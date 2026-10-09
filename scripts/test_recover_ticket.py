import importlib.util
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location('recover', Path(__file__).with_name('recover-ticket.py'))
rt = importlib.util.module_from_spec(spec)
sys.modules['recover'] = rt  # dataclasses look their module up by name
spec.loader.exec_module(rt)
CONFIG = rt.load_config()
ROLES = CONFIG['agent_roles']
ROOT = '/host/Projects'
STAMP = '20261009T082700Z'
SCRATCH = f'{ROOT}/.pyrycode-recovery/pyrycode/3022-{STAMP}'
WT = f'{ROOT}/.pyrycode-worktrees/pyrycode/builder-3022'
ADMIN = f'{ROOT}/pyrycode/.git/worktrees/builder-3022'


class ArgsTest(unittest.TestCase):
    def test_board_comes_from_the_repo_map(self):
        args = rt.parse_args(['halt', 'pyrycode-desktop', '1723', '--dry-run'], CONFIG)
        self.assertEqual((args.command, args.repo, args.number, args.board, args.dry_run), ('halt', 'pyrycode-desktop', 1723, 7, True))
        self.assertEqual([CONFIG['boards'][r] for r in ('pyrycode', 'pyrycode-mobile', 'pyrycode-relay', 'tui-driver')], [1, 5, 3, 6])

    def test_unknown_repo_and_contradictory_labels_are_refused(self):
        with self.assertRaises(rt.RecoverError):
            rt.parse_args(['halt', 'nope', '1'], CONFIG)
        with self.assertRaises(rt.RecoverError):
            rt.parse_args(['handback', 'pyrycode', '1', '--column', 'Backlog', '--add-label', 'x', '--remove-label', 'x'], CONFIG)

    def test_handback_needs_a_column_and_collects_labels(self):
        with self.assertRaises(SystemExit):
            rt.build_parser().parse_args(['handback', 'pyrycode', '1'])
        args = rt.parse_args(['handback', 'pyrycode', '3022', '--column', 'Backlog', '--remove-label', 'error:builder', '--remove-label', 'needs-rework:builder', '--add-label', 'done:refiner'], CONFIG)
        self.assertEqual(args.remove_label, ['error:builder', 'needs-rework:builder'])
        self.assertEqual(args.add_label, ['done:refiner'])
        self.assertEqual(args.quiet_minutes, 10)


class PathTest(unittest.TestCase):
    def test_container_paths_map_to_the_host_root(self):
        host = '/home/pyry/pyrycode-runtime/work/Projects'
        self.assertEqual(rt.map_container_path('/work/Projects/pyrycode/.git/worktrees/builder-3026', '/work/Projects', host),
                         f'{host}/pyrycode/.git/worktrees/builder-3026')
        self.assertEqual(rt.map_container_path('/work/Projectsfoo/x', '/work/Projects', host), '/work/Projectsfoo/x')
        self.assertEqual(rt.map_container_path('/Users/j/Workspace/Projects/x', '/work/Projects', host), '/Users/j/Workspace/Projects/x')
        self.assertEqual(rt.map_container_path('/work/Projects/x', '/work/Projects/', '/work/Projects'), '/work/Projects/x')

    def test_root_prefers_flag_then_env_then_first_existing_candidate(self):
        cands = ['/work/Projects', '/home/pyry/pyrycode-runtime/work/Projects', '~/Workspace/Projects']
        self.assertEqual(rt.resolve_root('/x', {rt.ROOT_ENV: '/y'}, cands, lambda p: True, '/h'), '/x')
        self.assertEqual(rt.resolve_root(None, {rt.ROOT_ENV: '/y'}, cands, lambda p: True, '/h'), '/y')
        self.assertEqual(rt.resolve_root(None, {}, cands, lambda p: p == '/h/Workspace/Projects', '/h'), '/h/Workspace/Projects')
        with self.assertRaises(rt.RecoverError):
            rt.resolve_root(None, {}, cands, lambda p: False, '/h')

    def test_names(self):
        self.assertEqual(rt.worktree_dir(ROOT, 'pyrycode', 'builder', 3022), WT)
        self.assertEqual(rt.scratch_dir(ROOT, 'pyrycode', 3022, STAMP), SCRATCH)
        self.assertEqual(rt.preserved_branch_name(3022, STAMP), f'preserved/3022-{STAMP}')
        self.assertEqual(rt.export_base(True, 7), 'origin/feature/7')
        self.assertEqual(rt.export_base(False, 7), 'origin/main')
        self.assertEqual(rt.parse_head('ref: refs/heads/feature/7\n'), ('ref', 'refs/heads/feature/7'))
        self.assertEqual(rt.parse_head('abc123\n'), ('sha', 'abc123'))


class BranchDecisionTest(unittest.TestCase):
    def test_only_a_local_branch_origin_lacks_or_cannot_fast_forward_is_renamed(self):
        B = rt.BranchState
        self.assertEqual(rt.decide_branch(B(None, 'a')), 'none')
        self.assertEqual(rt.decide_branch(B('a', None)), 'skip-no-remote')
        self.assertEqual(rt.decide_branch(B('a', 'a')), 'keep-synced')
        self.assertEqual(rt.decide_branch(B('a', 'b', True)), 'keep-behind')
        self.assertEqual(rt.decide_branch(B('a', 'b', False)), 'rename')
        self.assertEqual(rt.decide_branch(B('a', 'b', None)), 'rename')


def plan(state, admins=(), existing=()):
    return rt.plan_clean_local('pyrycode', 3022, ROLES, ROOT, STAMP, SCRATCH, state, list(admins), set(existing))


class CleanLocalPlanTest(unittest.TestCase):
    def test_diverged_branch_with_stale_worktree_moves_both_dirs_before_the_rename(self):
        admin = rt.AdminRecord(ADMIN, WT, 'ref: refs/heads/feature/3022\n')
        p = plan(rt.BranchState('aaaa', 'bbbb', False, False), [admin], [WT])
        kinds = [(a.kind, a.src, a.dst) for a in p.actions]
        self.assertEqual(kinds[0], ('move', WT, f'{SCRATCH}/builder-3022/worktree'))
        self.assertEqual(kinds[1], ('move', ADMIN, f'{SCRATCH}/builder-3022/gitdir'))
        self.assertEqual(kinds[2], ('rename-branch', 'feature/3022', f'preserved/3022-{STAMP}'))
        self.assertIn('DIVERGED', p.actions[2].describe)
        self.assertEqual(p.actions[3].dst, f'{SCRATCH}/builder-3022/gitdir/HEAD')
        self.assertEqual(p.actions[3].content, f'ref: refs/heads/preserved/3022-{STAMP}\n')
        self.assertEqual(p.actions[4].dst, f'{SCRATCH}/RECOVERY.txt')
        self.assertEqual(p.refusals, [])

    def test_synced_branch_stays_and_the_moved_head_is_pinned_to_its_commit(self):
        admin = rt.AdminRecord(ADMIN, WT, 'ref: refs/heads/feature/3022\n')
        p = plan(rt.BranchState('aaaa', 'aaaa'), [admin], [WT])
        self.assertNotIn('rename-branch', [a.kind for a in p.actions])
        head = [a for a in p.actions if a.dst.endswith('gitdir/HEAD')][0]
        self.assertEqual(head.content, 'aaaa\n')

    def test_orphan_admin_dir_without_folder_is_moved_too(self):
        admin = rt.AdminRecord(ADMIN, WT, 'deadbeef\n')
        p = plan(rt.BranchState(None, None), [admin], [])
        self.assertEqual([(a.kind, a.src) for a in p.actions if a.kind == 'move'], [('move', ADMIN)])

    def test_other_tickets_and_gate_worktrees_are_left_alone(self):
        others = [rt.AdminRecord(f'{ROOT}/pyrycode/.git/worktrees/real-claude-gate-3022', f'{ROOT}/.pyrycode-worktrees/pyrycode/real-claude-gate-3022', 'cafe\n'),
                  rt.AdminRecord(f'{ROOT}/pyrycode/.git/worktrees/builder-30221', f'{ROOT}/.pyrycode-worktrees/pyrycode/builder-30221', 'ref: refs/heads/feature/30221\n')]
        p = plan(rt.BranchState('aaaa', 'aaaa'), others, [])
        self.assertEqual(p.actions, [])
        self.assertTrue(any('equals origin' in n for n in p.notes))

    def test_rename_refused_when_another_worktree_holds_the_branch(self):
        holder = rt.AdminRecord(f'{ROOT}/pyrycode/.git/worktrees/manual', '/elsewhere/manual', 'ref: refs/heads/feature/3022\n')
        p = plan(rt.BranchState('aaaa', 'bbbb', False), [holder], [])
        self.assertEqual(len(p.refusals), 1)
        self.assertIn('/elsewhere/manual', p.refusals[0])

    def test_branch_missing_on_origin_is_never_renamed(self):
        p = plan(rt.BranchState('aaaa', None), [], [])
        self.assertEqual(p.actions, [])
        self.assertTrue(any('only copy' in n for n in p.notes))


class HandbackTest(unittest.TestCase):
    def test_label_plan_skips_noops(self):
        self.assertEqual(rt.plan_labels(['a', 'error:builder'], ['error:builder', 'missing'], ['a', 'b']),
                         (['error:builder'], ['b'], ['a', 'b']))

    def test_warnings_name_auto_advance_and_live_blocks(self):
        w = rt.handback_warnings('In Development', ['done:builder', 'error:builder', 'error:rework-loop', 'needs-rework:builder', 'wip:verifier'])
        self.assertTrue(any('auto-advances to In Code Review' in x for x in w))
        self.assertTrue(any(x.startswith('error:builder') for x in w))
        self.assertTrue(any(x.startswith('error:rework-loop') for x in w))
        self.assertTrue(any(x.startswith('needs-rework:builder') for x in w))
        self.assertTrue(any(x.startswith('wip:verifier') for x in w))
        self.assertEqual(rt.handback_warnings('Backlog', ['error:verifier', 'done:builder']), [])

    def test_ticket_state_finds_the_boards_card(self):
        data = {'organization': {'projectV2': {'id': 'P', 'field': {'id': 'F', 'options': [{'id': 'h', 'name': 'Halted'}, {'id': 'b', 'name': 'Backlog'}]}}},
                'repository': {'issue': {'state': 'OPEN', 'title': 't', 'labels': {'nodes': [{'name': 'wip:builder'}]},
                                         'projectItems': {'nodes': [{'id': 'other', 'project': {'number': 9}, 'fieldValueByName': None},
                                                                    {'id': 'I', 'project': {'number': 1}, 'fieldValueByName': {'name': 'In Development'}}]}}}}
        t = rt.parse_ticket_state(data, 1)
        self.assertEqual((t.item_id, t.column, t.project_id, t.field_id), ('I', 'In Development', 'P', 'F'))
        self.assertEqual(rt.option_id(t, 'halted'), ('Halted', 'h'))
        with self.assertRaises(rt.RecoverError):
            rt.option_id(t, 'Nowhere')
        with self.assertRaises(rt.RecoverError):
            rt.refuse_wip(t, False)
        self.assertTrue(rt.refuse_wip(t, True))

    def test_recent_logs_flag_a_possible_live_run(self):
        self.assertEqual(rt.recent_logs([('old', 0), ('new', 950)], 1000, 10), ['new'])


class ExportGuardTest(unittest.TestCase):
    def test_in_progress_operations_are_named(self):
        self.assertEqual(rt.in_progress_op(['HEAD', 'index', 'MERGE_HEAD', 'MERGE_MSG']), 'merge')
        self.assertEqual(rt.in_progress_op(['HEAD', 'rebase-merge']), 'rebase')
        self.assertEqual(rt.in_progress_op(['rebase-apply']), 'rebase or am')
        self.assertEqual(rt.in_progress_op(['CHERRY_PICK_HEAD']), 'cherry-pick')
        self.assertEqual(rt.in_progress_op(['REVERT_HEAD']), 'revert')
        self.assertIsNone(rt.in_progress_op(['HEAD', 'index', 'ORIG_HEAD', 'gitdir']))

    def test_ticket_branches_match_suffixes_but_not_longer_numbers(self):
        self.assertTrue(rt.is_ticket_branch('feature/3023', 3023))
        self.assertTrue(rt.is_ticket_branch('feature/3023-dispatch-base', 3023))
        self.assertTrue(rt.is_ticket_branch('feature/3023_b', 3023))
        self.assertFalse(rt.is_ticket_branch('feature/30231', 3023))
        self.assertFalse(rt.is_ticket_branch('feature/302', 3023))
        self.assertFalse(rt.is_ticket_branch('preserved/3023-x', 3023))

    def test_patch_cap(self):
        self.assertEqual(rt.patch_size_verdict(2_000_000, 2), (True, '2000000 bytes'))
        ok, msg = rt.patch_size_verdict(11_800_000, 2)
        self.assertFalse(ok)
        self.assertIn('11.8 MB, over the 2 MB cap', msg)
        self.assertEqual(rt.parse_args(['export', 'pyrycode', '1'], CONFIG).max_patch_mb, rt.DEFAULT_MAX_PATCH_MB)


class IdentityAndPortPlanTest(unittest.TestCase):
    IDENT = {'name': 'Juhana Ilmoniemi', 'email': 'juhana@ilmoniemi.fi'}

    def test_identity_fills_only_what_is_missing(self):
        self.assertEqual(rt.missing_identity('', '', self.IDENT), [('user.name', 'Juhana Ilmoniemi'), ('user.email', 'juhana@ilmoniemi.fi')])
        self.assertEqual(rt.missing_identity('x', '', self.IDENT), [('user.email', 'juhana@ilmoniemi.fi')])
        self.assertEqual(rt.missing_identity('x', 'y', self.IDENT), [])
        self.assertEqual(CONFIG['git_identity'], self.IDENT)

    def test_port_takes_the_tickets_own_commits_only(self):
        commits = [('a', 1, 'test: retain six-run evidence (#2882)'), ('m', 2, "Merge branch 'main'"),
                   ('b', 1, 'spec: plan witnesses (#3023)'), ('c', 1, 'fix: unrelated')]
        take, skip = rt.select_port_commits(commits, 3023, False)
        self.assertEqual(take, [('b', 'spec: plan witnesses (#3023)')])
        self.assertEqual([x[2] for x in skip], ['subject does not name (#3023)', 'merge', 'subject does not name (#3023)'])
        take, skip = rt.select_port_commits(commits, 3023, True)
        self.assertEqual([x[0] for x in take], ['a', 'b', 'c'])
        self.assertEqual([x[0] for x in skip], ['m'])

    def test_port_never_overwrites_a_different_origin_branch(self):
        self.assertEqual(rt.decide_port_push(None, 'h'), 'push')
        self.assertEqual(rt.decide_port_push('h', 'h'), 'already-there')
        self.assertEqual(rt.decide_port_push('o', 'h'), 'refuse')


class FamilyAndWipDecisionTest(unittest.TestCase):
    NOW = 1_000_000.0
    H = 3600

    def test_family_reset_needs_the_label_progress_and_a_gap(self):
        d = rt.decide_family_reset
        labels = ['error:family-breaker', 'family-dispatches:60']
        self.assertIsNone(d(labels, [], [self.NOW - 2 * self.H], self.NOW, 24, 24))
        self.assertIn('not a tripped family root', d(['x'], [], [self.NOW], self.NOW, 24, 24))
        self.assertIn('already posted', d(labels, [self.NOW - 23 * self.H], [self.NOW], self.NOW, 24, 24))
        self.assertIsNone(d(labels, [self.NOW - 25 * self.H], [self.NOW], self.NOW, 24, 24))
        self.assertIn('not progressing', d(labels, [], [self.NOW - 25 * self.H], self.NOW, 24, 24))
        self.assertIn('not progressing', d(labels, [], [], self.NOW, 24, 24))
        self.assertIsNone(d(labels, [self.NOW - 60], [], self.NOW, 0, None))  # by hand: no limits by default

    def test_clear_wip_waits_out_the_sweep_time_and_the_logs(self):
        d = rt.decide_clear_wip
        labels = ['wip:builder', 'done:refiner']
        self.assertIsNone(d(labels, 'wip:builder', self.NOW - 200 * 60, self.NOW - 150 * 60, self.NOW, 110))
        self.assertIsNone(d(labels, 'wip:builder', self.NOW - 200 * 60, None, self.NOW, 110))
        self.assertIn('not on the ticket', d(labels, 'wip:verifier', self.NOW - 200 * 60, None, self.NOW, 110))
        self.assertIn('cannot tell its age', d(labels, 'wip:builder', None, None, self.NOW, 110))
        self.assertIn('under the 110 min', d(labels, 'wip:builder', self.NOW - 60 * 60, None, self.NOW, 110))
        self.assertIn('run may still be going', d(labels, 'wip:builder', self.NOW - 200 * 60, self.NOW - 5 * 60, self.NOW, 110))

    def test_clear_wip_arguments(self):
        with self.assertRaises(rt.RecoverError):
            rt.parse_args(['clear-wip', 'pyrycode', '1', '--label', 'error:builder', '--min-age-minutes', '110'], CONFIG)
        with self.assertRaises(rt.RecoverError):
            rt.parse_args(['clear-wip', 'pyrycode', '1', '--label', 'wip:builder', '--min-age-minutes', '5'], CONFIG)
        a = rt.parse_args(['family-reset', 'pyrycode', '2959', '--require-progress-hours', '24', '--min-gap-hours', '24', '--dry-run'], CONFIG)
        self.assertEqual((a.number, a.require_progress_hours, a.min_gap_hours), (2959, 24, 24))
        self.assertEqual(rt.parse_args(['handback', 'pyrycode', '1', '--column', 'keep'], CONFIG).column, 'keep')


def git(cwd, *args):
    return subprocess.run(['git', '-C', cwd, *args], check=True, capture_output=True, text=True).stdout.strip()


class ApplyOnRealGitTest(unittest.TestCase):
    """End to end on a throwaway repo: the hand recovery of #3022, by the plan."""

    def test_clean_local_unblocks_worktree_add_and_keeps_everything(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = os.path.join(tmp, 'Projects')
            checkout = os.path.join(root, 'pyrycode')
            origin = os.path.join(tmp, 'origin.git')
            subprocess.run(['git', 'init', '-q', '--bare', origin], check=True)
            os.makedirs(checkout)
            git(checkout, 'init', '-q', '-b', 'main')
            git(checkout, 'config', 'user.email', 't@t')
            git(checkout, 'config', 'user.name', 't')
            git(checkout, 'commit', '-q', '--allow-empty', '-m', 'base')
            git(checkout, 'remote', 'add', 'origin', origin)
            git(checkout, 'push', '-q', 'origin', 'main')
            wt = rt.worktree_dir(root, 'pyrycode', 'builder', 5)
            git(checkout, 'worktree', 'add', '-q', '-b', 'feature/5', wt)
            Path(wt, 'work.txt').write_text('committed, never pushed\n')
            git(wt, 'add', 'work.txt')
            git(wt, 'commit', '-q', '-m', 'stale local')
            Path(wt, 'dirty.txt').write_text('uncommitted\n')
            stale = git(wt, 'rev-parse', 'HEAD')
            # origin gets a different feature/5, as a manual recovery would push
            git(checkout, 'push', '-q', 'origin', 'main:refs/heads/feature/5')
            git(checkout, 'fetch', '-q', 'origin')
            remote = git(checkout, 'rev-parse', 'origin/feature/5')
            git(checkout, 'commit', '-q', '--allow-empty', '-m', 'x')  # keep main moving, irrelevant
            state = rt.BranchState(stale, remote, False, False)
            admins = rt.read_admins(checkout, '/work/Projects', root)
            scratch = rt.scratch_dir(root, 'pyrycode', 5, STAMP)
            p = rt.plan_clean_local('pyrycode', 5, ROLES, root, STAMP, scratch, state, admins, {wt})
            self.assertEqual(p.refusals, [])
            rt.apply_actions(checkout, p.actions)
            self.assertFalse(os.path.exists(wt))
            self.assertEqual(git(checkout, 'rev-parse', f'preserved/5-{STAMP}'), stale)
            self.assertEqual(Path(scratch, 'builder-5', 'worktree', 'dirty.txt').read_text(), 'uncommitted\n')
            self.assertTrue(Path(scratch, 'RECOVERY.txt').exists())
            # export reads the moved worktree through the main checkout's git dir
            out = os.path.join(tmp, 'out')
            self.assertEqual(rt.main(['export', 'pyrycode', '5', '--root', root, '--out-dir', out]), 0)
            stem = os.path.join(out, 'recover-pyrycode-5-builder-5')
            self.assertIn('+committed, never pushed', Path(stem + '.patch').read_text())
            self.assertEqual(Path(stem + '.untracked.txt').read_text(), 'dirty.txt\n')
            # what the dispatcher does next: recreate the branch from origin and add the worktree
            git(checkout, 'branch', 'feature/5', 'origin/feature/5')
            git(checkout, 'worktree', 'add', '-q', wt, 'feature/5')
            self.assertEqual(git(wt, 'rev-parse', 'HEAD'), remote)


def make_repo(tmp):
    """A checkout under <tmp>/Projects/pyrycode with a bare origin and main pushed."""
    root = os.path.join(tmp, 'Projects')
    checkout = os.path.join(root, 'pyrycode')
    origin = os.path.join(tmp, 'origin.git')
    subprocess.run(['git', 'init', '-q', '--bare', '-b', 'main', origin], check=True)
    os.makedirs(checkout)
    git(checkout, 'init', '-q', '-b', 'main')
    git(checkout, 'config', 'user.email', 't@t')
    git(checkout, 'config', 'user.name', 't')
    Path(checkout, 'README').write_text('base\n')
    git(checkout, 'add', 'README')
    git(checkout, 'commit', '-q', '-m', 'base')
    git(checkout, 'remote', 'add', 'origin', origin)
    git(checkout, 'push', '-q', 'origin', 'main')
    git(checkout, 'fetch', '-q', 'origin')
    return root, checkout, origin


class ExportOnRealGitTest(unittest.TestCase):
    """The #3023 shape: a builder worktree stopped mid-merge of the old lineage, the real work on a side branch."""

    def test_mid_merge_worktree_is_refused_and_side_branches_are_exported(self):
        with tempfile.TemporaryDirectory() as tmp:
            root, checkout, _ = make_repo(tmp)
            # the old lineage: a big historical spec main never had
            git(checkout, 'checkout', '-q', '-b', 'lineage')
            Path(checkout, 'old-spec.md').write_text('x' * 5000 + '\n')
            git(checkout, 'add', 'old-spec.md')
            git(checkout, 'commit', '-q', '-m', 'test: old evidence (#2882)')
            git(checkout, 'checkout', '-q', 'main')
            Path(checkout, 'README').write_text('main moved\n')
            git(checkout, 'commit', '-q', '-am', 'main moves')
            git(checkout, 'push', '-q', 'origin', 'main')
            git(checkout, 'fetch', '-q', 'origin')
            # the real work, on a side branch from main
            git(checkout, 'branch', 'feature/7-dispatch-base', 'main')
            git(checkout, 'checkout', '-q', 'feature/7-dispatch-base')
            Path(checkout, 'plan.md').write_text('the real plan\n')
            git(checkout, 'add', 'plan.md')
            git(checkout, 'commit', '-q', '-m', 'spec: plan (#7)')
            git(checkout, 'checkout', '-q', 'main')
            git(checkout, 'branch', 'feature/70', 'main')  # another ticket, must not be exported
            # builder worktree on feature/7 from the lineage, stopped mid-merge with a conflict
            wt = rt.worktree_dir(root, 'pyrycode', 'builder', 7)
            git(checkout, 'worktree', 'add', '-q', '-b', 'feature/7', wt, 'lineage')
            Path(wt, 'README').write_text('lineage edit\n')
            git(wt, 'commit', '-q', '-am', 'lineage edits readme (#2882)')
            r = subprocess.run(['git', '-C', wt, 'merge', 'origin/main'], capture_output=True, text=True)
            self.assertNotEqual(r.returncode, 0)
            self.assertTrue(Path(checkout, '.git', 'worktrees', 'builder-7', 'MERGE_HEAD').exists())
            out = os.path.join(tmp, 'out')
            rc = rt.main(['export', 'pyrycode', '7', '--root', root, '--out-dir', out])
            self.assertEqual(rc, 2)  # the refused worktree makes the run fail loudly
            names = sorted(os.listdir(out))
            self.assertEqual(names, ['recover-pyrycode-7-branch-feature_7-dispatch-base.patch',
                                     'recover-pyrycode-7-branch-feature_7.patch'])
            self.assertIn('+the real plan', Path(out, names[0]).read_text())
            self.assertIn('old-spec.md', Path(out, names[1]).read_text())
            # a tight cap refuses the lineage patch and keeps the small one
            out2 = os.path.join(tmp, 'out2')
            rc = rt.main(['export', 'pyrycode', '7', '--root', root, '--out-dir', out2, '--max-patch-mb', '0.002'])
            self.assertEqual(rc, 2)
            self.assertEqual(os.listdir(out2), ['recover-pyrycode-7-branch-feature_7-dispatch-base.patch'])


class PortOnRealGitTest(unittest.TestCase):
    """The #3022 recovery, scripted: the ticket's commit off the old lineage onto a fresh feature/N from main."""

    def setUp(self):
        self.env = dict(os.environ)
        self.tmp = tempfile.TemporaryDirectory()
        empty = os.path.join(self.tmp.name, 'empty.gitconfig')
        Path(empty).write_text('')
        # no global or system identity, like a fresh clone on the pyrybox host
        os.environ.update(GIT_CONFIG_GLOBAL=empty, GIT_CONFIG_NOSYSTEM='1')
        self.saved = (rt.read_ticket, rt.remote_branch_sha)

    def tearDown(self):
        rt.read_ticket, rt.remote_branch_sha = self.saved
        os.environ.clear()
        os.environ.update(self.env)
        self.tmp.cleanup()

    def run_port(self, root, origin, *extra, labels=('done:refiner', 'error:builder')):
        def remote(owner, repo, branch):
            r = subprocess.run(['git', 'ls-remote', origin, f'refs/heads/{branch}'], capture_output=True, text=True, check=True)
            return r.stdout.split()[0] if r.stdout.strip() else None
        rt.remote_branch_sha = remote
        rt.read_ticket = lambda config, args: rt.TicketState('t', 'OPEN', list(labels), 'P', 'F', {'In Development': 'd'}, 'I', 'In Development')
        config = {**CONFIG, 'checks': {'pyrycode': [['test', '-f', 'work.txt']]}}
        args = rt.parse_args(['port', 'pyrycode', '5', '--root', root, *extra], config)
        return rt.cmd_port(config, args)

    def test_port_takes_the_ticket_commit_sets_identity_and_pushes_once(self):
        root, checkout, origin = make_repo(self.tmp.name)
        git(checkout, 'checkout', '-q', '-b', 'preserved/5-x')
        Path(checkout, 'old.md').write_text('old lineage\n')
        git(checkout, 'add', 'old.md')
        git(checkout, 'commit', '-q', '-m', 'test: old evidence (#2882)')
        Path(checkout, 'work.txt').write_text('ticket work\n')
        git(checkout, 'add', 'work.txt')
        git(checkout, 'commit', '-q', '-m', 'feat: the work (#5)')
        git(checkout, 'checkout', '-q', 'main')
        # dry run: proves the pick and the check, pushes nothing, leaves no clone behind
        self.assertEqual(self.run_port(root, origin, '--from', 'preserved/5-x', '--dry-run'), 0)
        self.assertIsNone(rt.remote_branch_sha('pyrycode', 'pyrycode', 'feature/5'))
        self.assertEqual(os.listdir(os.path.join(root, '.pyrycode-recovery', 'pyrycode')), [])
        # for real
        scratch = os.path.join(self.tmp.name, 'port')
        self.assertEqual(self.run_port(root, origin, '--from', 'preserved/5-x', '--scratch', scratch), 0)
        pushed = rt.remote_branch_sha('pyrycode', 'pyrycode', 'feature/5')
        files = subprocess.run(['git', '--git-dir', origin, 'ls-tree', '--name-only', pushed], capture_output=True, text=True).stdout.split()
        self.assertEqual(sorted(files), ['README', 'work.txt'])  # old.md stayed out
        self.assertEqual(git(scratch, 'config', '--local', 'user.email'), 'juhana@ilmoniemi.fi')
        self.assertEqual(subprocess.run(['git', '-C', checkout, 'config', '--local', 'user.email'], capture_output=True, text=True).stdout.strip(), 't@t')
        self.assertIn('cherry picked from commit', git(scratch, 'log', '-1', '--format=%B'))
        # a second port meets a different origin branch and refuses rather than force
        git(checkout, 'checkout', '-q', 'preserved/5-x')
        Path(checkout, 'work.txt').write_text('changed\n')
        git(checkout, 'commit', '-q', '-am', 'feat: more (#5)')
        git(checkout, 'checkout', '-q', 'main')
        with self.assertRaises(rt.RecoverError) as e:
            self.run_port(root, origin, '--from', 'preserved/5-x', '--scratch', os.path.join(self.tmp.name, 'port2'))
        self.assertIn('never forced', str(e.exception))
        self.assertEqual(rt.remote_branch_sha('pyrycode', 'pyrycode', 'feature/5'), pushed)

    def test_failed_check_pushes_nothing(self):
        root, checkout, origin = make_repo(self.tmp.name)
        git(checkout, 'checkout', '-q', '-b', 'preserved/5-x')
        Path(checkout, 'other.txt').write_text('no work.txt here\n')
        git(checkout, 'add', 'other.txt')
        git(checkout, 'commit', '-q', '-m', 'feat: wrong file (#5)')
        git(checkout, 'checkout', '-q', 'main')
        with self.assertRaises(rt.RecoverError) as e:
            self.run_port(root, origin, '--from', 'preserved/5-x', '--scratch', os.path.join(self.tmp.name, 'p'))
        self.assertIn('check failed', str(e.exception))
        self.assertIsNone(rt.remote_branch_sha('pyrycode', 'pyrycode', 'feature/5'))

    def test_wip_refuses_a_real_port(self):
        root, checkout, origin = make_repo(self.tmp.name)
        with self.assertRaises(rt.RecoverError):
            self.run_port(root, origin, '--from', 'main', labels=('wip:builder',))


if __name__ == '__main__':
    unittest.main()
