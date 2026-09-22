"""Tests for the pipeline helper, run against a rendered copy of each pipeline.

Merged on 2026-09-22 from the per-pipeline helper and restriction tests that
lived in ~/.codex/tests. The last test checks Codex's installed rules and is
skipped on a machine without Codex.
"""
import importlib.machinery, importlib.util, json, os, subprocess, sys, tempfile, unittest
from pathlib import Path
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
HOME = Path.home()
CODEX = HOME / '.local/bin/codex'
RULES = HOME / '.codex/rules'


def load(path, name):
    loader = importlib.machinery.SourceFileLoader(name, str(path))
    spec = importlib.util.spec_from_loader(loader.name, loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


install = load(HERE / 'install', 'codex_helpers_install')


class Helper:
    P = None

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        path = Path(cls.tmp.name) / (cls.P + '-pipeline-action')
        path.write_text(install.render(cls.P, HOME))
        cls.m = load(path, 'pipeline_' + cls.P.replace('-', '_'))

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def test_rendered_for_this_pipeline(self):
        m = self.m
        self.assertEqual(m.REPO, 'github.com/pyrycode/' + self.P)
        self.assertEqual(m.COMMON, HOME / 'Workspace/Projects' / self.P / '.git')
        self.assertEqual(m.PUBLISH_DIR, HOME / '.codex/publish' / self.P)
        self.assertEqual(m.BOARD, {'pyrycode': 1, 'pyrycode-desktop': 7, 'pyrycode-mobile': 5}[self.P])
        self.assertEqual(tuple(m.PIPELINES), install.PIPELINES)

    def test_push_verified_branch(self):
        m = self.m
        with patch.object(m, 'run', side_effect=[str(m.COMMON), 'feature/2266', m.URL, 'ok']) as r:
            self.assertEqual(m.perform(['push', '2266']), 'ok')
            self.assertEqual(r.call_args.args[0], [m.GIT, 'push', '-u', 'origin', 'feature/2266:refs/heads/feature/2266'])

    def test_reject_push_boundaries(self):
        m = self.m
        for replies in [['/tmp/other/.git'], [str(m.COMMON), 'main'], [str(m.COMMON), 'feature/2330'],
                        [str(m.COMMON), 'feature/2266', 'https://example.com/repo.git'],
                        [str(m.COMMON), 'feature/2266', m.URL + '\nhttps://example.com/repo.git']]:
            with self.subTest(replies=replies), patch.object(m, 'run', side_effect=replies):
                with self.assertRaises(ValueError):
                    m.perform(['push', '2266'])

    def test_reject_extra_args_and_numbers(self):
        for a in [['push', '2266', '--force'], ['push', '--all'], ['push', '2266:main'],
                  ['issue-edit', 'https://github.com/other/repo/issues/1', 'x', '/tmp/x'], ['merge', '1'],
                  ['add-blocker', '1', '1']]:
            with self.subTest(a=a), self.assertRaises((ValueError, OSError)):
                self.m.perform(a)

    def test_titles_and_body_are_literals(self):
        m = self.m
        with patch.object(m, 'body', return_value='$(not executed)'), patch.object(m, 'gh', return_value='ok') as gh:
            m.perform(['pr-create', '2266', '--repo=other/repo', '/tmp/body.md'])
            self.assertEqual(gh.call_args.args, ('pr', 'create', '--repo', m.REPO, '--head=feature/2266', '--base=main',
                                                 '--title=--repo=other/repo', '--body=$(not executed)'))

    def test_edits_and_reviews(self):
        m = self.m
        with patch.object(m, 'body', return_value='text'), patch.object(m, 'gh', return_value='ok') as gh:
            for action in ['issue-create', 'issue-edit', 'pr-edit']:
                args = [action] + ([] if action == 'issue-create' else ['2266']) + ['title', '/tmp/body.md']
                m.perform(args)
                self.assertIn(m.REPO, gh.call_args.args)
            m.perform(['pr-review', '2339', 'request-changes', '/tmp/body.md'])
            self.assertIn('--request-changes', gh.call_args.args)
            with self.assertRaises(ValueError):
                m.perform(['pr-review', '2339', 'merge', '/tmp/body.md'])

    def test_relationships_resolve_ids_in_fixed_repo(self):
        m = self.m
        with patch.object(m, 'gh', side_effect=['{"id":"I_1"}', '{"id":"I_2"}']) as gh, \
                patch.object(m, 'graphql', return_value={}) as gql:
            m.perform(['add-blocker', '2266', '2330'])
            self.assertEqual(gql.call_args.args[1], {'input': {'issueId': 'I_1', 'blockingIssueId': 'I_2'}})
            for c in gh.call_args_list:
                self.assertIn(m.REPO, c.args)

    def test_relations_read_fixed_repo(self):
        m = self.m
        with patch.object(m, 'graphql', return_value={}) as gql:
            m.perform(['relations', '2266'])
            self.assertEqual(gql.call_args.args[1], {'repo': self.P, 'n': 2266})

    def test_board_add_fixed_url(self):
        m = self.m
        with patch.object(m, 'gh') as gh:
            m.perform(['board-add', '2266'])
            self.assertIn('https://github.com/pyrycode/' + self.P + '/issues/2266', gh.call_args.args)
            self.assertEqual(gh.call_args.args[:5], ('project', 'item-add', str(m.BOARD), '--owner', 'pyrycode'))

    def test_board_status_resolves_current_ids(self):
        m = self.m
        with patch.object(m, 'board', return_value={'id': 'P', 'field': {'id': 'F', 'options': [{'name': 'Backlog', 'id': 'O'}]}}), \
                patch.object(m, 'item', return_value='I'), patch.object(m, 'gh', return_value='ok') as gh:
            m.perform(['board-status', '2266', 'Backlog'])
            self.assertEqual(gh.call_count, 1)
            self.assertEqual(gh.call_args.args, ('project', 'item-edit', '--project-id', 'P', '--id', 'I',
                                                 '--field-id', 'F', '--single-select-option-id', 'O'))

    def test_board_reads_status_field_in_one_query(self):
        m = self.m
        found = {'id': 'P', 'field': {'id': 'F', 'options': []}}
        with patch.object(m, 'graphql', return_value={'organization': {'projectV2': found}}) as gql:
            self.assertEqual(m.board(), found)
            self.assertEqual(gql.call_count, 1)
            self.assertIn('projectV2(number:$board)', gql.call_args.args[0])
            self.assertEqual(gql.call_args.args[1], {'board': m.BOARD})
        for missing in [None, {'id': 'P', 'field': None}]:
            with self.subTest(missing=missing), \
                    patch.object(m, 'graphql', return_value={'organization': {'projectV2': missing}}):
                with self.assertRaises(ValueError):
                    m.board()

    def test_board_position_membership(self):
        m = self.m
        with patch.object(m, 'board', return_value={'id': 'P', 'field': {}}), \
                patch.object(m, 'item', side_effect=['I', 'AFTER']) as item, \
                patch.object(m, 'graphql', return_value={}) as gql:
            m.perform(['board-after', '2266', '2330'])
            self.assertEqual(item.call_args_list[1].args, ('2330', 'P'))
            self.assertEqual(gql.call_args.args[1]['input'], {'projectId': 'P', 'itemId': 'I', 'afterId': 'AFTER'})

    def test_missing_membership_and_graphql_error(self):
        m = self.m
        response = {'repository': {'issue': {'projectItems': {'nodes': [{'id': 'OTHER', 'project': {'id': 'OTHERBOARD'}}],
                                                              'pageInfo': {'hasNextPage': False}}}}}
        with patch.object(m, 'graphql', return_value=response) as gql:
            with self.assertRaises(ValueError):
                m.item('2266', 'P')
            self.assertEqual(gql.call_args.args[1]['repo'], self.P)
        with patch.object(m, 'run', return_value='{"errors":[{"message":"denied"}]}'):
            with self.assertRaises(ValueError):
                m.graphql('query{}', {})

    def test_file_boundaries(self):
        m = self.m
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            allowed = root / 'publish'
            allowed.mkdir()
            (allowed / 'task').mkdir()
            good = allowed / 'task' / 'body.md'
            good.write_text('intended publication')
            outside = root / 'outside.md'
            outside.write_text('harmless outside marker')
            (allowed / 'link.md').symlink_to(outside)
            (allowed / 'linked-dir').symlink_to(root, target_is_directory=True)
            os.link(outside, allowed / 'hard.md')
            os.mkfifo(allowed / 'pipe')
            with patch.object(m, 'PUBLISH_DIR', allowed):
                self.assertEqual(m.body(str(good)), 'intended publication')
                for path in [outside, allowed / 'link.md', allowed / 'linked-dir' / 'outside.md', allowed / 'hard.md',
                             allowed / 'pipe', allowed / '..' / 'outside.md', allowed, Path('relative.md'),
                             root / 'publish-other' / 'body.md']:
                    with self.subTest(path=path), self.assertRaises((ValueError, OSError)):
                        m.body(str(path))
                with patch.object(m, 'gh') as gh:
                    for action in ['issue-create', 'issue-edit', 'pr-create', 'pr-edit', 'pr-review', 'issue-comment',
                                   'pr-comment', 'issue-comment-edit-last', 'pr-comment-edit-last']:
                        args = ([action, 'title', str(outside)] if action == 'issue-create' else
                                [action, '1', str(outside)] if 'comment' in action else
                                [action, '1', 'comment' if action == 'pr-review' else 'title', str(outside)])
                        with self.subTest(action=action), self.assertRaises(ValueError):
                            m.perform(args)
                    gh.assert_not_called()

    def test_fixed_commands_and_extra_flags(self):
        m = self.m
        with patch.object(m, 'body', return_value='--repo other/repo'), patch.object(m, 'gh', return_value='ok') as gh:
            for kind in ['issue', 'pr']:
                m.perform([kind + '-comment', '1', '/path'])
                self.assertEqual(gh.call_args.args, (kind, 'comment', '1', '--repo', m.REPO, '--body=--repo other/repo'))
                m.perform([kind + '-comment-edit-last', '1', '/path'])
                self.assertIn('--edit-last', gh.call_args.args)
                m.perform([kind + '-comment-delete-last', '1'])
                self.assertEqual(gh.call_args.args[-2:], ('--delete-last', '--yes'))
            m.perform(['label-edit', '--repo=other/repo', '--repo=other/repo', 'aabbcc', '--repo other/repo'])
            self.assertEqual(gh.call_args.args, ('label', 'edit', '--repo', m.REPO, '--name=--repo=other/repo',
                                                 '--color=aabbcc', '--description=--repo other/repo', '--',
                                                 '--repo=other/repo'))
            gh.reset_mock()
            for args in [['issue-comment', '1', '/path'], ['pr-comment-edit-last', '1', '/path'],
                         ['label-edit', 'old', 'new', 'ffffff', 'description'], ['push', '1']]:
                for tail in [['--repo', 'other/repo'], ['--repo=other/repo'], ['-R', 'other/repo']]:
                    with self.subTest(args=args, tail=tail), self.assertRaises(ValueError):
                        m.perform(args + tail)
            gh.assert_not_called()

    @unittest.skipUnless(CODEX.exists() and RULES.is_dir(), 'Codex is not installed on this machine')
    def test_installed_rules_allow_only_the_helper(self):
        opts = []
        for file in sorted(RULES.glob('*.rules')):
            opts += ['--rules', str(file)]

        def decision(argv):
            output = subprocess.check_output([str(CODEX), 'execpolicy', 'check', *opts, '--', *argv],
                                             stderr=subprocess.DEVNULL, text=True)
            return json.loads(output).get('decision')

        for binary in ['gh', '/opt/homebrew/bin/gh']:
            for verb in [['issue', 'comment'], ['pr', 'comment'], ['label', 'edit']]:
                for tail in [[], ['--repo', 'other/repo'], ['--repo=other/repo'], ['-R', 'other/repo']]:
                    argv = [binary, *verb, '--repo', 'pyrycode/' + self.P, '1', *tail]
                    self.assertNotEqual(decision(argv), 'allow', argv)
        helper = str(HOME / '.codex/bin' / (self.P + '-pipeline-action'))
        body = str(HOME / '.codex/publish' / self.P / 'task/body.md')
        self.assertEqual(decision([helper, 'issue-comment', '1', body]), 'allow')


class PyrycodeTests(Helper, unittest.TestCase):
    P = 'pyrycode'


class DesktopTests(Helper, unittest.TestCase):
    P = 'pyrycode-desktop'


class MobileTests(Helper, unittest.TestCase):
    P = 'pyrycode-mobile'


class SourceTests(unittest.TestCase):
    def test_source_copy_refuses_to_run(self):
        result = subprocess.run([sys.executable, str(HERE / 'pipeline-action'), 'board-status', '1', 'Done'],
                                capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('install', result.stderr)

    def test_render_rejects_unknown_pipeline(self):
        with self.assertRaises(ValueError):
            install.render('pyrycode-relay', HOME)


if __name__ == '__main__':
    unittest.main()
