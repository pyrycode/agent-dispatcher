#!/usr/bin/env python3
"""Repeatable manual recovery of one pipeline ticket.

Subcommands:
  halt        move the card to Halted, refused while a wip: label is present
  export      write the preserved worktree's unpushed and uncommitted work as a patch
  clean-local preserve a diverged local feature/<N> and move stale <role>-<N> worktrees aside
  handback    clean-local, check origin/feature/<N>, edit labels, set the column, read back

Nothing here deletes, force pushes or runs `git worktree prune`. On pyrybox the
dispatchers run in containers that see the checkouts under /work/Projects, so
every worktree's `.git` file and admin `gitdir` carry container paths; a prune
from the host would mark every live worktree prunable and drop them all.
Every mutating subcommand takes --dry-run and prints exactly what it would do.
"""
from __future__ import annotations

import argparse
import datetime
import json
import os
import subprocess
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path

HERE = Path(__file__).resolve().parent
CONFIG_PATH = HERE / "recover-ticket.json"
ROOT_ENV = "RECOVER_TICKET_ROOT"
CONTAINER_ROOT_ENV = "RECOVER_TICKET_CONTAINER_ROOT"
SCRATCH_DIRNAME = ".pyrycode-recovery"
HALTED = "Halted"

# Same rules as BUILDER_ADVANCE_RULES in src/stage-sets.ts: a card in the
# column with the label is moved on by the dispatcher at its next poll.
ADVANCE_RULES = {
    "Backlog": ("done:refiner", "In Development"),
    "In Development": ("done:builder", "In Code Review"),
    "In Code Review": ("done:verifier", "In Documentation"),
    "In Documentation": ("done:documentation", "Done"),
}
COLUMN_ROLE = {
    "Backlog": "refiner",
    "In Development": "builder",
    "In Code Review": "verifier",
    "In Documentation": "documentation",
}


class RecoverError(RuntimeError):
    """A refusal or failed precondition; printed without a traceback."""


# --------- configuration and paths (pure) ---------

def load_config(path=CONFIG_PATH):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def resolve_root(flag, env, candidates, exists, home):
    """Checkout root: --root, then $RECOVER_TICKET_ROOT, then the first candidate that exists."""
    if flag:
        return os.path.abspath(os.path.expanduser(flag))
    if env.get(ROOT_ENV):
        return os.path.abspath(os.path.expanduser(env[ROOT_ENV]))
    for candidate in candidates:
        expanded = candidate.replace("~", home, 1) if candidate.startswith("~") else candidate
        if exists(expanded):
            return expanded
    raise RecoverError(f"no checkout root found; pass --root or set {ROOT_ENV} (tried {', '.join(candidates)})")


def map_container_path(path, container_root, host_root):
    """Translate a path the container wrote (/work/Projects/...) to the host's view.

    Paths outside the container root, or when host and container agree, come back unchanged.
    """
    container_root = container_root.rstrip("/")
    host_root = host_root.rstrip("/")
    if not container_root or container_root == host_root:
        return path
    if path == container_root or path.startswith(container_root + "/"):
        return host_root + path[len(container_root):]
    return path


def worktree_dir(root, repo, role, number):
    return os.path.join(root, ".pyrycode-worktrees", repo, f"{role}-{number}")


def scratch_dir(root, repo, number, stamp):
    return os.path.join(root, SCRATCH_DIRNAME, repo, f"{number}-{stamp}")


def utc_stamp(now=None):
    now = now or datetime.datetime.now(datetime.timezone.utc)
    return now.strftime("%Y%m%dT%H%M%SZ")


def branch_name(number):
    return f"feature/{number}"


def preserved_branch_name(number, stamp):
    return f"preserved/{number}-{stamp}"


# --------- argument parsing ---------

def build_parser():
    parser = argparse.ArgumentParser(prog="recover-ticket", description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("repo", help="target repository, e.g. pyrycode or pyrycode-desktop")
    common.add_argument("number", type=int, help="issue number")
    common.add_argument("--root", help=f"folder holding the checkouts and .pyrycode-worktrees (or ${ROOT_ENV})")
    common.add_argument("--checkout", help="the dispatcher's checkout of the repo (default <root>/<repo>)")
    common.add_argument("--container-root", help=f"path the dispatcher container sees for --root (or ${CONTAINER_ROOT_ENV})")
    common.add_argument("--dry-run", action="store_true", help="print what would be done, change nothing")
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("halt", parents=[common], help="move the card to Halted")

    export = sub.add_parser("export", parents=[common], help="patch of the preserved worktree's work, read only")
    export.add_argument("--worktree", action="append", default=[],
                        help="worktree, or a preserved folder holding worktree/ and gitdir/ (repeatable; default: every <role>-<N> found in place or in the recovery folder)")
    export.add_argument("--out-dir", default=".", help="where to write the patch and the untracked list")

    clean = sub.add_parser("clean-local", parents=[common], help="preserve a diverged local branch, move stale worktrees aside")
    clean.add_argument("--quiet-minutes", type=int, default=10, help="refuse while a ticket log is younger than this (default 10)")
    clean.add_argument("--scratch", help=f"folder to move worktrees into (default <root>/{SCRATCH_DIRNAME}/<repo>/<N>-<stamp>)")

    handback = sub.add_parser("handback", parents=[common], help="clean-local, then labels and column")
    handback.add_argument("--column", required=True, help="board column to hand the card back to, e.g. Backlog")
    handback.add_argument("--remove-label", action="append", default=[])
    handback.add_argument("--add-label", action="append", default=[])
    handback.add_argument("--scratch", help="as for clean-local")
    handback.add_argument("--quiet-minutes", type=int, default=10, help="as for clean-local")
    return parser


def parse_args(argv, config):
    args = build_parser().parse_args(argv)
    if args.repo not in config["boards"]:
        raise RecoverError(f"unknown repo {args.repo!r}; known: {', '.join(sorted(config['boards']))}")
    args.board = config["boards"][args.repo]
    overlap = set(getattr(args, "remove_label", [])) & set(getattr(args, "add_label", []))
    if overlap:
        raise RecoverError(f"label both added and removed: {', '.join(sorted(overlap))}")
    return args


# --------- planning (pure) ---------

@dataclass
class Action:
    kind: str          # "move", "rename-branch", "write"
    describe: str
    src: str = ""
    dst: str = ""
    content: str = ""


@dataclass
class AdminRecord:
    """One entry under <checkout>/.git/worktrees/."""
    admin_dir: str
    worktree: str      # host path of the worktree folder, from the admin's gitdir file
    head: str          # raw HEAD content


@dataclass
class BranchState:
    local_sha: str | None
    remote_sha: str | None
    local_is_ancestor: bool | None = None   # None when origin's commit is not present locally
    origin_is_ancestor: bool | None = None  # True: local is strictly ahead, holding unpushed commits


@dataclass
class Plan:
    actions: list = field(default_factory=list)
    notes: list = field(default_factory=list)
    refusals: list = field(default_factory=list)


def decide_branch(state):
    """What clean-local does with local feature/<N>.

    rename: local differs from origin and is not merely behind it. This is the
      DIVERGED or strictly-ahead state that parks the next stage.
    keep-*: the dispatcher handles it (equal, or a plain fast-forward).
    skip-no-remote: origin has no branch, so local may be the only copy. Left alone.
    """
    if state.local_sha is None:
        return "none"
    if state.remote_sha is None:
        return "skip-no-remote"
    if state.local_sha == state.remote_sha:
        return "keep-synced"
    if state.local_is_ancestor:
        return "keep-behind"
    return "rename"


def plan_clean_local(repo, number, roles, root, stamp, scratch, state, admins, existing_dirs):
    """Build the clean-local plan.

    admins: every AdminRecord of the checkout. existing_dirs: the <role>-<N>
    folders present on disk. Moves the stale worktree folders and their admin
    dirs into the scratch folder, then renames the branch. Moving the admin
    dir first matters: git refuses to rename a branch a worktree has checked
    out, and git branch -m would rewrite that worktree's HEAD.
    """
    plan = Plan()
    branch = branch_name(number)
    branch_ref = f"ref: refs/heads/{branch}"
    targets = [worktree_dir(root, repo, role, number) for role in roles]
    action = decide_branch(state)
    preserved = preserved_branch_name(number, stamp)

    moved_admins = []
    for target in targets:
        name = os.path.basename(target)
        dest = os.path.join(scratch, name)
        admin = next((a for a in admins if os.path.normpath(a.worktree) == os.path.normpath(target)), None)
        if target in existing_dirs:
            plan.actions.append(Action("move", f"move worktree {target} -> {dest}/worktree", target, os.path.join(dest, "worktree")))
        if admin:
            plan.actions.append(Action("move", f"move admin dir {admin.admin_dir} -> {dest}/gitdir", admin.admin_dir, os.path.join(dest, "gitdir")))
            moved_admins.append((admin, dest))
        elif target in existing_dirs:
            plan.notes.append(f"{target} has no admin dir under .git/worktrees; moving the folder only")

    holders = [a for a in admins if a.head.strip() == branch_ref and a not in [m for m, _ in moved_admins]]
    if action == "rename" and holders:
        plan.refusals.append(
            f"{branch} is also checked out at {', '.join(h.worktree for h in holders)}, which is not a {'/'.join(roles)} worktree of #{number}; "
            "resolve that worktree by hand before renaming")

    if action == "rename":
        relation = {True: "strictly ahead, unpushed commits", False: "DIVERGED"}.get(state.origin_is_ancestor, "differs; origin commit not fetched")
        plan.actions.append(Action("rename-branch", f"git branch -m {branch} {preserved}  (local {short(state.local_sha)}, origin {short(state.remote_sha)}: {relation})", branch, preserved))
    elif action == "keep-synced":
        plan.notes.append(f"local {branch} equals origin ({short(state.local_sha)}); left alone")
    elif action == "keep-behind":
        plan.notes.append(f"local {branch} is behind origin; the dispatcher fast-forwards it, left alone")
    elif action == "skip-no-remote":
        plan.notes.append(f"origin has no {branch}; local {short(state.local_sha)} may be the only copy, left alone (push it first)")
    else:
        plan.notes.append(f"no local {branch}")

    # A moved admin dir still names feature/<N> in HEAD. Point it at what the
    # worktree actually had, so export reads the preserved work and not the
    # live branch the dispatcher will keep moving.
    for admin, dest in moved_admins:
        if admin.head.strip() == branch_ref:
            new_head = f"ref: refs/heads/{preserved}\n" if action == "rename" else f"{state.local_sha}\n"
            if new_head.strip() != admin.head.strip() and state.local_sha:
                plan.actions.append(Action("write", f"set {dest}/gitdir/HEAD to {new_head.strip()!r} (was {admin.head.strip()!r})",
                                           dst=os.path.join(dest, "gitdir", "HEAD"), content=new_head))

    if any(a.kind == "move" for a in plan.actions):
        record = recovery_record(repo, number, stamp, state, action, preserved, plan.actions)
        plan.actions.append(Action("write", f"write {scratch}/RECOVERY.txt", dst=os.path.join(scratch, "RECOVERY.txt"), content=record))
    return plan


def recovery_record(repo, number, stamp, state, action, preserved, actions):
    lines = [f"recover-ticket clean-local {repo} #{number} at {stamp}",
             f"local {branch_name(number)}: {state.local_sha or '-'}  origin: {state.remote_sha or '-'}  decision: {action}"]
    if action == "rename":
        lines.append(f"renamed local {branch_name(number)} to {preserved}")
    lines += [a.describe for a in actions]
    lines.append("Each worktree/ folder's .git file still names its old admin path. Read it with:")
    lines.append("  GIT_COMMON_DIR=<checkout>/.git git --git-dir=<this>/<name>/gitdir --work-tree=<this>/<name>/worktree status")
    return "\n".join(lines) + "\n"


def plan_labels(labels, remove, add):
    """Label edits that would change something, and the labels after them."""
    current = set(labels)
    to_remove = [l for l in remove if l in current]
    to_add = [l for l in add if l not in current]
    after = sorted((current - set(to_remove)) | set(to_add))
    return to_remove, to_add, after


def handback_warnings(column, labels_after):
    """Things that would surprise someone handing back into this column."""
    warnings = []
    rule = ADVANCE_RULES.get(column)
    if rule and rule[0] in labels_after:
        warnings.append(f"{column} plus {rule[0]} auto-advances to {rule[1]} at the next poll")
    role = COLUMN_ROLE.get(column)
    for label in labels_after:
        if label.startswith("wip:"):
            warnings.append(f"{label} is still present")
        elif label.startswith("error:") and (label == f"error:{role}" or label in GLOBAL_BLOCKS):
            warnings.append(f"{label} still blocks dispatch in {column}")
        elif label.startswith("needs-rework:"):
            warnings.append(f"{label} is still present and will route the card")
    return warnings


GLOBAL_BLOCKS = {"error:max_turns_salvaged", "error:merge-conflict", "error:rework-loop", "error:family-breaker"}


def export_base(remote_feature_exists, number):
    return f"origin/{branch_name(number)}" if remote_feature_exists else "origin/main"


def short(sha):
    return sha[:8] if sha else "-"


# --------- side effects ---------

def run(cmd, env=None, check=True, cwd=None):
    result = subprocess.run(cmd, capture_output=True, text=True, env=env, cwd=cwd)
    if check and result.returncode != 0:
        raise RecoverError(f"{' '.join(cmd)} failed: {result.stderr.strip() or result.stdout.strip()}")
    return result


def read_env():
    # Optional locks off: plain `git status` or `git diff` would otherwise
    # refresh and rewrite the live checkout's index files.
    return {**os.environ, "GIT_OPTIONAL_LOCKS": "0"}


def git(checkout, *args, check=True):
    return run(["git", "-C", checkout, *args], env=read_env(), check=check)


def gh_graphql(query, **variables):
    cmd = ["gh", "api", "graphql", "-f", f"query={query}"]
    for key, value in variables.items():
        cmd += ["-F" if isinstance(value, int) else "-f", f"{key}={value}"]
    return json.loads(run(cmd).stdout)["data"]


STATE_QUERY = """query($o:String!,$r:String!,$n:Int!,$b:Int!){
 organization(login:$o){projectV2(number:$b){id field(name:"Status"){... on ProjectV2SingleSelectField{id options{id name}}}}}
 repository(owner:$o,name:$r){issue(number:$n){state title labels(first:50){nodes{name}}
  projectItems(first:10){nodes{id project{number} fieldValueByName(name:"Status"){... on ProjectV2ItemFieldSingleSelectValue{name}}}}}}}"""

SET_STATUS = """mutation($p:ID!,$i:ID!,$f:ID!,$o:String!){updateProjectV2ItemFieldValue(input:{projectId:$p,itemId:$i,fieldId:$f,value:{singleSelectOptionId:$o}}){projectV2Item{id}}}"""


@dataclass
class TicketState:
    title: str
    state: str
    labels: list
    project_id: str
    field_id: str
    options: dict          # column name -> option id
    item_id: str | None
    column: str | None


def parse_ticket_state(data, board):
    project = data["organization"]["projectV2"]
    issue = data["repository"]["issue"]
    if issue is None:
        raise RecoverError("issue not found")
    item = next((n for n in issue["projectItems"]["nodes"] if n["project"]["number"] == board), None)
    return TicketState(
        title=issue["title"], state=issue["state"],
        labels=[l["name"] for l in issue["labels"]["nodes"]],
        project_id=project["id"], field_id=project["field"]["id"],
        options={o["name"]: o["id"] for o in project["field"]["options"]},
        item_id=item["id"] if item else None,
        column=(item.get("fieldValueByName") or {}).get("name") if item else None,
    )


def read_ticket(config, args):
    data = gh_graphql(STATE_QUERY, o=config["owner"], r=args.repo, n=args.number, b=args.board)
    return parse_ticket_state(data, args.board)


def print_ticket(prefix, t):
    print(f"{prefix}: {t.state} #{t.title[:70]!r}")
    print(f"  column: {t.column or 'No status'}")
    print(f"  labels: {', '.join(sorted(t.labels)) or '-'}")


def refuse_wip(t, dry_run):
    """Refuse while a run is in flight. A dry run reports the refusal and goes on planning."""
    wip = [l for l in t.labels if l.startswith("wip:")]
    if not wip:
        return False
    message = f"{', '.join(wip)} present: a run is in flight. Let it finish, then retry."
    if not dry_run:
        raise RecoverError(message)
    print(f"REFUSE (a real run would stop here): {message}")
    return True


def option_id(t, column):
    match = next((name for name in t.options if name.lower() == column.lower()), None)
    if match is None:
        raise RecoverError(f"board has no column {column!r}; columns: {', '.join(t.options)}")
    return match, t.options[match]


def set_column(t, column, dry_run):
    name, opt = option_id(t, column)
    if t.item_id is None:
        raise RecoverError("ticket has no card on the board")
    if t.column == name:
        print(f"column already {name}; nothing to move")
        return
    print(f"{'would move' if dry_run else 'moving'} card {t.item_id}: {t.column or 'No status'} -> {name} (option {opt}, field {t.field_id}, project {t.project_id})")
    if not dry_run:
        gh_graphql(SET_STATUS, p=t.project_id, i=t.item_id, f=t.field_id, o=opt)


def remote_branch_sha(owner, repo, branch):
    result = run(["gh", "api", f"repos/{owner}/{repo}/git/ref/heads/{branch}", "--jq", ".object.sha"], check=False)
    if result.returncode != 0:
        if "Not Found" in result.stdout + result.stderr:
            return None
        raise RecoverError(f"could not read origin {branch}: {result.stderr.strip()}")
    return result.stdout.strip() or None


def read_admins(checkout, container_root, root):
    base = os.path.join(checkout, ".git", "worktrees")
    records = []
    if not os.path.isdir(base):
        return records
    for name in sorted(os.listdir(base)):
        admin = os.path.join(base, name)
        try:
            gitdir = Path(admin, "gitdir").read_text().strip()
            head = Path(admin, "HEAD").read_text()
        except OSError:
            continue
        worktree = os.path.dirname(map_container_path(gitdir, container_root, root))
        records.append(AdminRecord(admin, worktree, head))
    return records


def read_branch_state(checkout, owner, repo, number):
    branch = branch_name(number)
    local = git(checkout, "rev-parse", "--verify", "--quiet", f"refs/heads/{branch}", check=False).stdout.strip() or None
    remote = remote_branch_sha(owner, repo, branch)
    ancestor = None
    if local and remote and local != remote:
        if git(checkout, "cat-file", "-e", f"{remote}^{{commit}}", check=False).returncode == 0:
            ancestor = git(checkout, "merge-base", "--is-ancestor", local, remote, check=False).returncode == 0
            ahead = git(checkout, "merge-base", "--is-ancestor", remote, local, check=False).returncode == 0
            return BranchState(local, remote, ancestor, ahead)
    return BranchState(local, remote, ancestor)


def apply_actions(checkout, actions):
    for a in actions:
        if a.kind == "move":
            if os.path.exists(a.dst):
                raise RecoverError(f"{a.dst} already exists; refusing to overwrite")
            os.makedirs(os.path.dirname(a.dst), exist_ok=True)
            try:
                os.rename(a.src, a.dst)   # same filesystem only; never copy and delete
            except OSError as e:
                raise RecoverError(f"could not move {a.src}: {e}. Pick a --scratch on the same filesystem.")
        elif a.kind == "rename-branch":
            run(["git", "-C", checkout, "branch", "-m", a.src, a.dst])
        elif a.kind == "write":
            os.makedirs(os.path.dirname(a.dst), exist_ok=True)
            Path(a.dst).write_text(a.content)
        print(f"done: {a.describe}")


def context(config, args):
    container_root = args.container_root or os.environ.get(CONTAINER_ROOT_ENV) or config["container_root"]
    root = resolve_root(args.root, os.environ, config["root_candidates"], os.path.isdir, os.path.expanduser("~"))
    checkout = os.path.abspath(args.checkout) if args.checkout else os.path.join(root, args.repo)
    if not os.path.isdir(os.path.join(checkout, ".git")):
        raise RecoverError(f"{checkout} is not a git checkout")
    return root, checkout, container_root


# --------- subcommands ---------

def cmd_halt(config, args):
    t = read_ticket(config, args)
    print_ticket(f"{args.repo}#{args.number}", t)
    refused = refuse_wip(t, args.dry_run)
    set_column(t, HALTED, args.dry_run)
    if not args.dry_run:
        print_ticket("now", read_ticket(config, args))
    return 2 if refused else 0


def recent_logs(paths_with_mtime, now, minutes):
    """Agent logs of the ticket written in the last `minutes`: a run may still be in flight."""
    return sorted(p for p, mtime in paths_with_mtime if now - mtime < minutes * 60)


def ticket_logs(config, root, checkout, repo, number):
    found = []
    for template in config["logs_dirs"]:
        d = template.format(root=root, repo=repo, checkout=checkout)
        if os.path.isdir(d):
            suffix = f"_#{number}"
            for name in os.listdir(d):
                stem = name.split(".", 1)[0]
                if stem.endswith(suffix):
                    path = os.path.join(d, name)
                    found.append((path, os.path.getmtime(path)))
    return found


def do_clean_local(config, args, t):
    root, checkout, container_root = context(config, args)
    recent = recent_logs(ticket_logs(config, root, checkout, args.repo, args.number), time.time(), args.quiet_minutes)
    if recent:
        message = f"agent log written in the last {args.quiet_minutes} min, a run may be in flight even without a wip: label: {', '.join(os.path.basename(p) for p in recent)}"
        if not args.dry_run:
            raise RecoverError(message)
        print(f"REFUSE (a real run would stop here): {message}")
    stamp = utc_stamp()
    scratch = os.path.abspath(args.scratch) if args.scratch else scratch_dir(root, args.repo, args.number, stamp)
    state = read_branch_state(checkout, config["owner"], args.repo, args.number)
    admins = read_admins(checkout, container_root, root)
    roles = config["agent_roles"]
    existing = {p for p in (worktree_dir(root, args.repo, r, args.number) for r in roles) if os.path.lexists(p)}
    plan = plan_clean_local(args.repo, args.number, roles, root, stamp, scratch, state, admins, existing)
    print(f"checkout: {checkout}")
    if t.column and t.column != HALTED:
        print(f"warning: card is in {t.column}, not {HALTED}; the dispatcher may act on it meanwhile")
    for note in plan.notes:
        print(f"note: {note}")
    if plan.refusals:
        raise RecoverError("; ".join(plan.refusals))
    if not plan.actions:
        print("clean-local: nothing to do")
        return state
    for a in plan.actions:
        print(f"{'would' if args.dry_run else 'will'}: {a.describe}")
    if not args.dry_run:
        apply_actions(checkout, plan.actions)
    return state


def cmd_clean_local(config, args):
    t = read_ticket(config, args)
    print_ticket(f"{args.repo}#{args.number}", t)
    refused = refuse_wip(t, args.dry_run)
    do_clean_local(config, args, t)
    return 2 if refused else 0


def cmd_handback(config, args):
    t = read_ticket(config, args)
    print_ticket(f"{args.repo}#{args.number}", t)
    refused = refuse_wip(t, args.dry_run)
    column, _ = option_id(t, args.column)
    remote = remote_branch_sha(config["owner"], args.repo, branch_name(args.number))
    if remote is None:
        raise RecoverError(f"origin has no {branch_name(args.number)}; push the recovered work there before handing back")
    print(f"origin {branch_name(args.number)}: {short(remote)}")
    do_clean_local(config, args, t)
    to_remove, to_add, after = plan_labels(t.labels, args.remove_label, args.add_label)
    for label in args.remove_label:
        if label not in to_remove:
            print(f"note: {label} not present, nothing to remove")
    if to_remove or to_add:
        cmd = ["gh", "issue", "edit", str(args.number), "-R", f"{config['owner']}/{args.repo}"]
        for label in to_remove:
            cmd += ["--remove-label", label]
        for label in to_add:
            cmd += ["--add-label", label]
        print(f"{'would run' if args.dry_run else 'running'}: {' '.join(cmd)}")
        if not args.dry_run:
            run(cmd)
    for warning in handback_warnings(column, after):
        print(f"warning: {warning}")
    set_column(t, column, args.dry_run)
    if args.dry_run:
        print(f"labels after: {', '.join(after) or '-'}")
    else:
        print_ticket("read back", read_ticket(config, args))
    return 2 if refused else 0


def find_export_targets(root, repo, number, roles, explicit):
    if explicit:
        return [os.path.abspath(p) for p in explicit]
    found = [p for p in (worktree_dir(root, repo, r, number) for r in roles) if os.path.isdir(p)]
    recovery = os.path.join(root, SCRATCH_DIRNAME, repo)
    if os.path.isdir(recovery):
        for entry in sorted(os.listdir(recovery)):
            if entry.split("-", 1)[0] == str(number):
                for name in sorted(os.listdir(os.path.join(recovery, entry))):
                    p = os.path.join(recovery, entry, name)
                    if os.path.isdir(os.path.join(p, "worktree")):
                        found.append(p)
    return found


def resolve_git_dirs(target, container_root, root):
    """(worktree, admin dir) of a live worktree or of a preserved folder with worktree/ and gitdir/."""
    if os.path.isdir(os.path.join(target, "worktree")) and os.path.isdir(os.path.join(target, "gitdir")):
        return os.path.join(target, "worktree"), os.path.join(target, "gitdir")
    dotgit = os.path.join(target, ".git")
    if os.path.isfile(dotgit):
        line = Path(dotgit).read_text().strip()
        if line.startswith("gitdir:"):
            return target, map_container_path(line.split(":", 1)[1].strip(), container_root, root)
    if os.path.isdir(dotgit):
        return target, dotgit
    raise RecoverError(f"{target} is neither a worktree nor a preserved folder")


def cmd_export(config, args):
    root, checkout, container_root = context(config, args)
    common = os.path.join(checkout, ".git")
    remote_exists = git(checkout, "rev-parse", "--verify", "--quiet", f"refs/remotes/origin/{branch_name(args.number)}", check=False).returncode == 0
    base = export_base(remote_exists, args.number)
    targets = find_export_targets(root, args.repo, args.number, config["agent_roles"], args.worktree)
    if not targets:
        raise RecoverError(f"no preserved worktree for #{args.number}; pass --worktree")
    print(f"base: {base} (local ref, last fetched by the dispatcher)")
    for target in targets:
        wt, admin = resolve_git_dirs(target, container_root, root)
        # The main checkout's git dir with this worktree's own index and
        # HEAD. A moved admin dir cannot serve as GIT_DIR: git resolves refs
        # through its relative commondir file, which no longer leads home.
        env = {**read_env(), "GIT_DIR": common, "GIT_WORK_TREE": wt, "GIT_INDEX_FILE": os.path.join(admin, "index")}

        def g(*a, check=True):
            return run(["git", *a], env=env, check=check, cwd=wt)

        kind, value = parse_head(Path(admin, "HEAD").read_text())
        head = g("rev-parse", "--verify", f"{value}^{{commit}}").stdout.strip()
        merge_base = g("merge-base", base, head).stdout.strip()
        commits = g("log", "--oneline", f"{base}..{head}").stdout.strip()
        stat = g("diff", "--stat", merge_base).stdout.rstrip()
        patch = g("diff", "--binary", merge_base).stdout
        untracked = g("ls-files", "--others", "--exclude-standard").stdout.strip()
        name = os.path.basename(target.rstrip("/"))
        print(f"\n== {target}")
        print(f"worktree {wt}\nadmin    {admin}\nHEAD     {short(head)} ({value})  merge-base with {base}: {short(merge_base)}")
        if wt != target and kind == "ref" and value == f"refs/heads/{branch_name(args.number)}":
            print(f"warning: this preserved HEAD names the live {branch_name(args.number)}, which may have moved on since")
        print(f"commits not in {base}:\n{indent(commits)}")
        print(f"diff vs merge-base (committed plus uncommitted, tracked):\n{indent(stat)}")
        print(f"untracked:\n{indent(untracked)}")
        stem = os.path.join(os.path.abspath(args.out_dir), f"recover-{args.repo}-{args.number}-{name}")
        if args.dry_run:
            print(f"would write {stem}.patch ({len(patch)} bytes) and {stem}.untracked.txt")
        else:
            os.makedirs(args.out_dir, exist_ok=True)
            Path(stem + ".patch").write_text(patch)
            Path(stem + ".untracked.txt").write_text(untracked + ("\n" if untracked else ""))
            print(f"wrote {stem}.patch and {stem}.untracked.txt")
    return 0


def parse_head(content):
    """("ref", "refs/heads/x") for a symbolic HEAD, ("sha", "<sha>") for a detached one."""
    content = content.strip()
    if content.startswith("ref:"):
        return "ref", content[4:].strip()
    return "sha", content


def indent(text):
    return "\n".join("  " + line for line in text.splitlines()) if text else "  (none)"


COMMANDS = {"halt": cmd_halt, "export": cmd_export, "clean-local": cmd_clean_local, "handback": cmd_handback}


def main(argv=None):
    sys.stdout.reconfigure(line_buffering=True)
    config = load_config()
    try:
        args = parse_args(sys.argv[1:] if argv is None else argv, config)
        if args.dry_run:
            print("DRY RUN: nothing will be changed")
        return COMMANDS[args.command](config, args)
    except RecoverError as e:
        print(f"recover-ticket: {e}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
