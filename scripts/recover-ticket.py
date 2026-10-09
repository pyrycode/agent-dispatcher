#!/usr/bin/env python3
"""Repeatable manual recovery of one pipeline ticket.

Subcommands:
  halt         move the card to Halted, refused while a wip: label is present
  export       write each preserved worktree's work and each local feature/<N>* branch
               as a patch; refuses a worktree stopped mid-merge, rebase or cherry-pick
  clean-local  preserve a diverged local feature/<N> and move stale <role>-<N> worktrees aside
  handback     clean-local, check origin/feature/<N>, edit labels, set the column, read back
  port         cherry-pick the ticket's own commits onto a fresh feature/<N> from
               origin/main in a scratch clone, run the repo's checks, push (never force)
  family-reset post the family dispatch reset marker on a family root and remove
               error:family-breaker
  clear-wip    remove a wip:<role> label older than the stranded sweep time with no
               agent log activity

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
import tempfile
import time
from dataclasses import dataclass, field
from pathlib import Path

HERE = Path(__file__).resolve().parent
CONFIG_PATH = HERE / "recover-ticket.json"
ROOT_ENV = "RECOVER_TICKET_ROOT"
CONTAINER_ROOT_ENV = "RECOVER_TICKET_CONTAINER_ROOT"
SCRATCH_DIRNAME = ".pyrycode-recovery"
HALTED = "Halted"
KEEP_COLUMN = "keep"
DEFAULT_MAX_PATCH_MB = 2.0
# Same string as FAMILY_DISPATCH_RESET_MARKER in src/pipeline-decisions.ts.
FAMILY_RESET_MARKER = "<!-- family-dispatch-reset -->"
FAMILY_BREAKER_LABEL = "error:family-breaker"
FAMILY_TRIP_MARKER = "<!-- family-breaker-tripped -->"
# A worktree or checkout stopped in the middle of one of these is a half-made
# state: its HEAD and index are neither the ticket's work nor main.
IN_PROGRESS_MARKERS = (
    ("MERGE_HEAD", "merge"),
    ("rebase-merge", "rebase"),
    ("rebase-apply", "rebase or am"),
    ("CHERRY_PICK_HEAD", "cherry-pick"),
    ("REVERT_HEAD", "revert"),
)

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
    export.add_argument("--max-patch-mb", type=float, default=DEFAULT_MAX_PATCH_MB,
                        help=f"do not write a patch larger than this, warn instead (default {DEFAULT_MAX_PATCH_MB})")

    clean = sub.add_parser("clean-local", parents=[common], help="preserve a diverged local branch, move stale worktrees aside")
    clean.add_argument("--quiet-minutes", type=int, default=10, help="refuse while a ticket log is younger than this (default 10)")
    clean.add_argument("--scratch", help=f"folder to move worktrees into (default <root>/{SCRATCH_DIRNAME}/<repo>/<N>-<stamp>)")

    handback = sub.add_parser("handback", parents=[common], help="clean-local, then labels and column")
    handback.add_argument("--column", required=True, help=f"board column to hand the card back to, e.g. Backlog, or {KEEP_COLUMN!r} to leave it where it is")
    handback.add_argument("--remove-label", action="append", default=[])
    handback.add_argument("--add-label", action="append", default=[])
    handback.add_argument("--scratch", help="as for clean-local")
    handback.add_argument("--quiet-minutes", type=int, default=10, help="as for clean-local")

    port = sub.add_parser("port", parents=[common], help="cherry-pick the ticket's commits onto a fresh feature/<N> from origin/main and push it")
    port.add_argument("--from", dest="source", required=True, help="branch or commit in the dispatcher's checkout holding the work, e.g. preserved/3022-...")
    port.add_argument("--all-commits", action="store_true", help="take every non-merge commit in origin/main..FROM, not only those whose subject names (#N)")
    port.add_argument("--skip-checks", action="store_true", help="do not run the repo's checks from recover-ticket.json")
    port.add_argument("--scratch", help=f"folder for the scratch clone (default <root>/{SCRATCH_DIRNAME}/<repo>/<N>-<stamp>-port)")
    port.add_argument("--git-name", help="commit identity if the clone has none (default: git_identity in recover-ticket.json)")
    port.add_argument("--git-email", help="as --git-name")

    family = sub.add_parser("family-reset", parents=[common], help="reset a tripped family breaker on its root (number is the root)")
    family.add_argument("--require-progress-hours", type=float,
                        help="refuse unless a descendant moved column or closed within this many hours")
    family.add_argument("--min-gap-hours", type=float, default=0,
                        help="refuse if a reset marker was already posted within this many hours (default 0, no limit)")

    wip = sub.add_parser("clear-wip", parents=[common], help="remove a stranded wip:<role> label")
    wip.add_argument("--label", required=True, help="the wip:<role> label to remove")
    wip.add_argument("--min-age-minutes", type=int, required=True,
                     help="refuse unless the label was added, and no ticket agent log written, at least this long ago (use the dispatcher's 'Stranded-wip gate' time)")
    return parser


def parse_args(argv, config):
    args = build_parser().parse_args(argv)
    if args.repo not in config["boards"]:
        raise RecoverError(f"unknown repo {args.repo!r}; known: {', '.join(sorted(config['boards']))}")
    args.board = config["boards"][args.repo]
    overlap = set(getattr(args, "remove_label", [])) & set(getattr(args, "add_label", []))
    if overlap:
        raise RecoverError(f"label both added and removed: {', '.join(sorted(overlap))}")
    if args.command == "clear-wip" and not args.label.startswith("wip:"):
        raise RecoverError(f"clear-wip only removes wip: labels, not {args.label!r}")
    if args.command == "clear-wip" and args.min_age_minutes < 30:
        raise RecoverError("--min-age-minutes below 30 is not a stranded label; use the dispatcher's 'Stranded-wip gate' time")
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


def in_progress_op(git_dir_entries):
    """The operation a git dir (a worktree's admin dir, or a checkout's .git) is stopped in, or None."""
    entries = set(git_dir_entries)
    for marker, op in IN_PROGRESS_MARKERS:
        if marker in entries:
            return op
    return None


def is_ticket_branch(name, number):
    """feature/<N> and feature/<N><suffix> such as feature/3023-dispatch-base, never feature/<N><digit>."""
    stem = branch_name(number)
    if name == stem:
        return True
    return name.startswith(stem) and not name[len(stem)].isdigit()


def patch_size_verdict(size_bytes, max_mb):
    """(write, message). A patch over the cap usually carries another ticket's lineage or a half merge."""
    mb = size_bytes / 1_000_000
    if size_bytes <= max_mb * 1_000_000:
        return True, f"{size_bytes} bytes"
    return False, (f"{mb:.1f} MB, over the {max_mb:g} MB cap. A patch this size usually carries another "
                   "ticket's lineage or a half-merged state, not the ticket's work. Not written; check the "
                   "commit list above, or pass --max-patch-mb to write it anyway")


def missing_identity(name, email, identity):
    """The repo-local git config settings to add so commits work, as (key, value) pairs."""
    out = []
    if not name:
        out.append(("user.name", identity["name"]))
    if not email:
        out.append(("user.email", identity["email"]))
    return out


def select_port_commits(commits, number, all_commits):
    """Split origin/main..FROM into (take, skip) for a port.

    commits: (sha, parent count, subject) oldest first. Merges are never
    taken: replaying one is a merge decision, not a port. By default only
    commits whose subject names (#N) are taken, which is the pipeline's own
    commit convention and keeps another ticket's lineage (the #2882 commits
    under #3022 and #3023) out of the new branch.
    """
    tag = f"(#{number})"
    take, skip = [], []
    for sha, parents, subject in commits:
        if parents > 1:
            skip.append((sha, subject, "merge"))
        elif all_commits or tag in subject:
            take.append((sha, subject))
        else:
            skip.append((sha, subject, f"subject does not name {tag}"))
    return take, skip


def decide_port_push(remote_sha, new_head):
    """push, already-there or refuse, for a port's new feature/<N> against origin's."""
    if remote_sha is None:
        return "push"
    if remote_sha == new_head:
        return "already-there"
    return "refuse"


def decide_family_reset(labels, reset_times, progress_times, now, min_gap_hours, require_progress_hours):
    """None when a reset may go ahead, else the reason to refuse. Times are epoch seconds."""
    if FAMILY_BREAKER_LABEL not in labels:
        return f"no {FAMILY_BREAKER_LABEL} label on this ticket; it is not a tripped family root"
    if min_gap_hours and any(now - t < min_gap_hours * 3600 for t in reset_times):
        return f"a reset marker was already posted in the last {min_gap_hours:g} h; a family that trips twice in a day wants a human"
    if require_progress_hours is not None and not any(now - t < require_progress_hours * 3600 for t in progress_times):
        return f"no descendant moved column or closed in the last {require_progress_hours:g} h; the family is not progressing"
    return None


def decide_clear_wip(labels, label, added_at, newest_log, now, min_age_minutes):
    """None when the wip label is stranded by every measure here, else the reason to refuse."""
    if label not in labels:
        return f"{label} is not on the ticket"
    if added_at is None:
        return f"no labeled event found for {label}; cannot tell its age"
    age = (now - added_at) / 60
    if age < min_age_minutes:
        return f"{label} is {age:.0f} min old, under the {min_age_minutes} min stranded time; the dispatcher's own sweep has not had its turn"
    if newest_log is not None and (now - newest_log) / 60 < min_age_minutes:
        return f"an agent log of the ticket was written {(now - newest_log) / 60:.0f} min ago; a run may still be going"
    return None


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
    if args.column.lower() == KEEP_COLUMN:
        if not t.column:
            raise RecoverError(f"--column {KEEP_COLUMN}: the ticket has no column on board {args.board}")
        args.column = t.column
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


def ticket_branches(checkout, number):
    """Local feature/<N>* branches of the checkout, as (name, sha)."""
    out = git(checkout, "for-each-ref", "--format=%(refname:short) %(objectname)", "refs/heads/feature/").stdout
    pairs = [line.split(" ", 1) for line in out.splitlines() if " " in line]
    return [(name, sha) for name, sha in pairs if is_ticket_branch(name, number)]


def write_patch(stem, patch, untracked, args):
    """Write or refuse one patch against the size cap. Returns True if written (or would be)."""
    ok, size = patch_size_verdict(len(patch.encode()), args.max_patch_mb)
    if not ok:
        print(f"WARNING: {os.path.basename(stem)}.patch is {size}")
        return False
    if args.dry_run:
        print(f"would write {stem}.patch ({size})" + (f" and {stem}.untracked.txt" if untracked is not None else ""))
        return True
    os.makedirs(os.path.dirname(stem), exist_ok=True)
    Path(stem + ".patch").write_text(patch)
    if untracked is not None:
        Path(stem + ".untracked.txt").write_text(untracked + ("\n" if untracked else ""))
    print(f"wrote {stem}.patch ({size})" + (f" and {stem}.untracked.txt" if untracked is not None else ""))
    return True


def export_worktree(target, args, checkout, root, container_root, base, out_dir):
    """Export one worktree. Returns 'ok', 'refused' or 'too-big'."""
    wt, admin = resolve_git_dirs(target, container_root, root)
    print(f"\n== worktree {target}")
    op = in_progress_op(os.listdir(admin)) if os.path.isdir(admin) else None
    if op:
        print(f"REFUSE: {target} is stopped in the middle of a {op} (admin dir {admin}). Its HEAD and index are a "
              "half-made state, not the ticket's work, so a patch of it would mislead. Look at the local "
              f"{branch_name(args.number)}* branches below, or finish or abort the {op} by hand in a copy.")
        return "refused"
    common = os.path.join(checkout, ".git")
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
    print(f"worktree {wt}\nadmin    {admin}\nHEAD     {short(head)} ({value})  merge-base with {base}: {short(merge_base)}")
    if wt != target and kind == "ref" and value == f"refs/heads/{branch_name(args.number)}":
        print(f"warning: this preserved HEAD names the live {branch_name(args.number)}, which may have moved on since")
    print(f"commits not in {base}:\n{indent(commits, 30)}")
    print(f"diff vs merge-base (committed plus uncommitted, tracked):\n{indent(stat, 40)}")
    print(f"untracked:\n{indent(untracked, 40)}")
    stem = os.path.join(out_dir, f"recover-{args.repo}-{args.number}-{name}")
    return "ok" if write_patch(stem, patch, untracked, args) else "too-big"


def export_branch(name, sha, args, checkout, out_dir):
    """Export one local feature/<N>* branch against origin/main. Returns 'ok' or 'too-big'."""
    commits = git(checkout, "log", "--oneline", f"origin/main..{sha}").stdout.strip()
    ahead = len(commits.splitlines()) if commits else 0
    print(f"\n== branch {name} {short(sha)}: {ahead} commit(s) ahead of origin/main")
    print(indent(commits, 30))
    if ahead == 0:
        print("nothing ahead of origin/main; no patch")
        return "ok"
    stat = git(checkout, "diff", "--stat", f"origin/main...{sha}").stdout.rstrip()
    print(f"diff vs merge-base with origin/main:\n{indent(stat, 40)}")
    patch = git(checkout, "diff", "--binary", f"origin/main...{sha}").stdout
    stem = os.path.join(out_dir, f"recover-{args.repo}-{args.number}-branch-{name.replace('/', '_')}")
    return "ok" if write_patch(stem, patch, None, args) else "too-big"


def cmd_export(config, args):
    root, checkout, container_root = context(config, args)
    remote_exists = git(checkout, "rev-parse", "--verify", "--quiet", f"refs/remotes/origin/{branch_name(args.number)}", check=False).returncode == 0
    base = export_base(remote_exists, args.number)
    targets = find_export_targets(root, args.repo, args.number, config["agent_roles"], args.worktree)
    branches = ticket_branches(checkout, args.number)
    if not targets and not branches:
        raise RecoverError(f"no preserved worktree and no local {branch_name(args.number)}* branch for #{args.number}; pass --worktree")
    out_dir = os.path.abspath(args.out_dir)
    print(f"worktree base: {base}, branch base: origin/main (local refs, last fetched by the dispatcher)")
    checkout_op = in_progress_op(os.listdir(os.path.join(checkout, ".git")))
    if checkout_op:
        print(f"warning: the checkout {checkout} itself is stopped in the middle of a {checkout_op}")
    results = [export_worktree(t, args, checkout, root, container_root, base, out_dir) for t in targets]
    results += [export_branch(name, sha, args, checkout, out_dir) for name, sha in branches]
    refused, big = results.count("refused"), results.count("too-big")
    print(f"\nexport: {len(targets)} worktree(s), {len(branches)} branch(es); "
          f"{refused} refused mid-operation, {big} over the size cap")
    return 2 if refused or big else 0


def parse_head(content):
    """("ref", "refs/heads/x") for a symbolic HEAD, ("sha", "<sha>") for a detached one."""
    content = content.strip()
    if content.startswith("ref:"):
        return "ref", content[4:].strip()
    return "sha", content


def indent(text, limit=None):
    if not text:
        return "  (none)"
    lines = text.splitlines()
    more = f"\n  ... and {len(lines) - limit} more" if limit and len(lines) > limit else ""
    return "\n".join("  " + line for line in lines[:limit]) + more


# --------- port, family-reset, clear-wip ---------

def ensure_identity(repo_dir, identity, dry_run):
    """Set a repo-local commit identity when the repo resolves none. Fresh clones,
    and the dispatcher's checkout on the host, have none; a commit there fails."""
    name = run(["git", "-C", repo_dir, "config", "user.name"], check=False).stdout.strip()
    email = run(["git", "-C", repo_dir, "config", "user.email"], check=False).stdout.strip()
    todo = missing_identity(name, email, identity)
    for key, value in todo:
        print(f"{'would set' if dry_run else 'setting'} repo-local {key} = {value} in {repo_dir}")
        if not dry_run:
            run(["git", "-C", repo_dir, "config", "--local", key, value])
    return todo


def resolve_identity(config, args):
    ident = dict(config.get("git_identity") or {})
    if getattr(args, "git_name", None):
        ident["name"] = args.git_name
    if getattr(args, "git_email", None):
        ident["email"] = args.git_email
    if not ident.get("name") or not ident.get("email"):
        raise RecoverError("no commit identity: set git_identity in recover-ticket.json or pass --git-name and --git-email")
    return ident


def port_commits(checkout, source, number, all_commits):
    rows = git(checkout, "log", "--reverse", "--format=%H %P%x09%s", f"origin/main..{source}").stdout.splitlines()
    commits = []
    for row in rows:
        head, _, subject = row.partition("\t")
        sha, *parents = head.split()
        commits.append((sha, len(parents), subject))
    return select_port_commits(commits, number, all_commits)


def run_checks(clone, commands, dry_run):
    """Run each check in the clone. Returns a line for the summary."""
    if not commands:
        return "no checks known for this repo in recover-ticket.json; none run"
    for cmd in commands:
        print(f"check: {' '.join(cmd)}")
        result = subprocess.run(cmd, cwd=clone, capture_output=True, text=True)
        if result.returncode != 0:
            tail = "\n".join((result.stdout + result.stderr).strip().splitlines()[-30:])
            raise RecoverError(f"check failed: {' '.join(cmd)} (exit {result.returncode})\n{tail}\nnothing pushed; the clone is kept for a look")
        print("  ok")
    return "checks passed: " + "; ".join(" ".join(c) for c in commands)


def cmd_port(config, args):
    t = read_ticket(config, args)
    print_ticket(f"{args.repo}#{args.number}", t)
    refused = refuse_wip(t, args.dry_run)
    root, checkout, _ = context(config, args)
    branch = branch_name(args.number)
    source = git(checkout, "rev-parse", "--verify", f"{args.source}^{{commit}}").stdout.strip()
    take, skip = port_commits(checkout, source, args.number, args.all_commits)
    print(f"source: {args.source} {short(source)}")
    for sha, subject in take:
        print(f"take: {short(sha)} {subject}")
    for sha, subject, why in skip[:40]:
        print(f"skip: {short(sha)} {subject}  ({why})")
    if len(skip) > 40:
        print(f"skip: ... and {len(skip) - 40} more")
    if not take:
        raise RecoverError(f"no commit to port in origin/main..{args.source}" + ("" if args.all_commits else f" names (#{args.number}); check the source or pass --all-commits"))
    remote = remote_branch_sha(config["owner"], args.repo, branch)
    if remote is not None:
        print(f"origin {branch}: {short(remote)}")
    ident = resolve_identity(config, args)
    stamp = utc_stamp()
    url = git(checkout, "remote", "get-url", "origin").stdout.strip()
    keep = not args.dry_run or args.scratch
    if keep:
        clone = os.path.abspath(args.scratch) if args.scratch else scratch_dir(root, args.repo, args.number, stamp) + "-port"
        if os.path.exists(clone):
            raise RecoverError(f"{clone} already exists; refusing to overwrite")
        os.makedirs(os.path.dirname(clone), exist_ok=True)
        return finish_port(config, args, checkout, clone, url, branch, take, remote, ident, refused)
    # A dry run makes the same clone and cherry-picks for real, so it proves
    # the port applies and the checks pass, then removes its own temporary clone.
    parent = os.path.join(root, SCRATCH_DIRNAME, args.repo)
    os.makedirs(parent, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=f"{args.number}-dry-port-", dir=parent) as tmp:
        return finish_port(config, args, checkout, os.path.join(tmp, "clone"), url, branch, take, remote, ident, refused)


def finish_port(config, args, checkout, clone, url, branch, take, remote, ident, refused):
    print(f"clone: {clone}")
    # --shared borrows the checkout's objects, so the source commits are there
    # without a fetch. The clone's own config gets the identity, never the
    # dispatcher's checkout, whose config the containers share.
    run(["git", "clone", "-q", "--shared", "--no-checkout", checkout, clone])
    run(["git", "-C", clone, "remote", "set-url", "origin", url])
    run(["git", "-C", clone, "fetch", "-q", "origin", "main"])
    base = run(["git", "-C", clone, "rev-parse", "FETCH_HEAD"]).stdout.strip()
    run(["git", "-C", clone, "checkout", "-q", "-b", branch, base])
    print(f"{branch} from origin/main {short(base)}")
    ensure_identity(clone, ident, False)
    for sha, subject in take:
        result = run(["git", "-C", clone, "cherry-pick", "-x", sha], check=False)
        if result.returncode != 0:
            run(["git", "-C", clone, "cherry-pick", "--abort"], check=False)
            raise RecoverError(f"cherry-pick of {short(sha)} {subject!r} onto main conflicts; port it by hand. "
                               f"{(result.stderr or result.stdout).strip()[:400]}")
        print(f"picked {short(sha)} {subject}")
    head = run(["git", "-C", clone, "rev-parse", "HEAD"]).stdout.strip()
    stat = run(["git", "-C", clone, "diff", "--stat", f"{base}..{head}"]).stdout.rstrip()
    print(f"new {branch}: {short(head)}\n{indent(stat, 40)}")
    checks = "checks skipped (--skip-checks)" if args.skip_checks else run_checks(clone, config.get("checks", {}).get(args.repo), args.dry_run)
    print(checks)
    decision = decide_port_push(remote, head)
    if decision == "refuse":
        raise RecoverError(f"origin already has {branch} at {short(remote)}, which differs from the port {short(head)}. "
                           "Not pushed and never forced; compare the two by hand.")
    if decision == "already-there":
        print(f"origin {branch} already equals the port; nothing to push")
    elif args.dry_run:
        print(f"would run: git push origin {branch}  (new branch, no force)")
    else:
        run(["git", "-C", clone, "push", "-q", "origin", f"refs/heads/{branch}:refs/heads/{branch}"])
        pushed = remote_branch_sha(config["owner"], args.repo, branch)
        print(f"pushed: origin {branch} is now {short(pushed)}")
        if pushed != head:
            raise RecoverError(f"read back: origin {branch} is {short(pushed)}, expected {short(head)}")
        print(f"undo: the branch is new, nothing was overwritten. To take it back: git push origin --delete {branch}")
    return 2 if refused else 0


def family_state(config, args):
    query = """query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r){issue(number:$n){state labels(first:50){nodes{name}}
      comments(last:100){nodes{createdAt body}}
      subIssues(first:50){nodes{number state closedAt projectItems(first:5){nodes{fieldValueByName(name:"Status"){... on ProjectV2ItemFieldSingleSelectValue{name updatedAt}}}}
        subIssues(first:50){nodes{number state closedAt projectItems(first:5){nodes{fieldValueByName(name:"Status"){... on ProjectV2ItemFieldSingleSelectValue{name updatedAt}}}}}}}}}}}"""
    issue = gh_graphql(query, o=config["owner"], r=args.repo, n=args.number)["repository"]["issue"]
    if issue is None:
        raise RecoverError("issue not found")
    labels = [l["name"] for l in issue["labels"]["nodes"]]
    # The trip comment quotes the reset marker; the dispatcher's tallyFamilyComments skips it the same way.
    resets = [iso_epoch(c["createdAt"]) for c in issue["comments"]["nodes"] if FAMILY_RESET_MARKER in c["body"]
              and FAMILY_TRIP_MARKER not in c["body"]]
    progress, kids = [], []
    for child in issue["subIssues"]["nodes"]:
        for node in [child] + child["subIssues"]["nodes"]:
            kids.append(f"#{node['number']} {node['state'].lower()}")
            if node.get("closedAt"):
                progress.append(iso_epoch(node["closedAt"]))
            for item in node["projectItems"]["nodes"]:
                status = item.get("fieldValueByName") or {}
                if status.get("updatedAt"):
                    progress.append(iso_epoch(status["updatedAt"]))
    return labels, resets, progress, kids


def iso_epoch(value):
    return datetime.datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()


def cmd_family_reset(config, args):
    labels, resets, progress, kids = family_state(config, args)
    now = time.time()
    print(f"{args.repo}#{args.number}: labels {', '.join(sorted(labels)) or '-'}")
    print(f"descendants: {', '.join(kids) or 'none'}")
    if progress:
        print(f"latest descendant move or close: {(now - max(progress)) / 3600:.1f} h ago")
    if resets:
        print(f"latest reset marker: {(now - max(resets)) / 3600:.1f} h ago")
    reason = decide_family_reset(labels, resets, progress, now, args.min_gap_hours, args.require_progress_hours)
    if reason:
        raise RecoverError(reason)
    repo = f"{config['owner']}/{args.repo}"
    body = (f"{FAMILY_RESET_MARKER}\nFamily dispatch tally reset by recover-ticket at {utc_stamp()}; "
            f"`{FAMILY_BREAKER_LABEL}` removed so the family can dispatch again.")
    if args.dry_run:
        print(f"would comment on {repo}#{args.number}: {body!r}")
        print(f"would run: gh issue edit {args.number} -R {repo} --remove-label {FAMILY_BREAKER_LABEL}")
        return 0
    run(["gh", "issue", "comment", str(args.number), "-R", repo, "--body", body])
    run(["gh", "issue", "edit", str(args.number), "-R", repo, "--remove-label", FAMILY_BREAKER_LABEL])
    after, resets_after, _, _ = family_state(config, args)
    print(f"read back: labels {', '.join(sorted(after)) or '-'}; reset markers in the last hour: "
          f"{sum(1 for r in resets_after if now - r < 3600 + 60)}")
    if FAMILY_BREAKER_LABEL in after:
        raise RecoverError(f"read back: {FAMILY_BREAKER_LABEL} is still present")
    print(f"undo: gh issue edit {args.number} -R {repo} --add-label {FAMILY_BREAKER_LABEL}  (the marker comment only zeroes the tally)")
    return 0


def label_added_at(config, args, label):
    query = """query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r){issue(number:$n){
      timelineItems(last:100,itemTypes:[LABELED_EVENT]){nodes{... on LabeledEvent{createdAt label{name}}}}}}}"""
    nodes = gh_graphql(query, o=config["owner"], r=args.repo, n=args.number)["repository"]["issue"]["timelineItems"]["nodes"]
    times = [iso_epoch(n["createdAt"]) for n in nodes if (n.get("label") or {}).get("name") == label]
    return max(times) if times else None


def cmd_clear_wip(config, args):
    t = read_ticket(config, args)
    print_ticket(f"{args.repo}#{args.number}", t)
    root, checkout, _ = context(config, args)
    added = label_added_at(config, args, args.label)
    logs = ticket_logs(config, root, checkout, args.repo, args.number)
    newest = max((m for _, m in logs), default=None)
    now = time.time()
    if added:
        print(f"{args.label} added {(now - added) / 60:.0f} min ago")
    print(f"newest agent log of #{args.number}: " + (f"{(now - newest) / 60:.0f} min ago" if newest else "none found"))
    reason = decide_clear_wip(t.labels, args.label, added, newest, now, args.min_age_minutes)
    if reason:
        raise RecoverError(reason)
    repo = f"{config['owner']}/{args.repo}"
    cmd = ["gh", "issue", "edit", str(args.number), "-R", repo, "--remove-label", args.label]
    print(f"{'would run' if args.dry_run else 'running'}: {' '.join(cmd)}")
    if args.dry_run:
        return 0
    run(cmd)
    print_ticket("read back", read_ticket(config, args))
    print(f"undo: gh issue edit {args.number} -R {repo} --add-label {args.label}")
    return 0


COMMANDS = {"halt": cmd_halt, "export": cmd_export, "clean-local": cmd_clean_local, "handback": cmd_handback,
            "port": cmd_port, "family-reset": cmd_family_reset, "clear-wip": cmd_clear_wip}


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
