#!/usr/bin/env python3
"""Focused builder checks at managed launchers, before any test admission."""
import http.client
import json
import os
from pathlib import Path
import re
import shlex
import socket


class PolicyError(ValueError):
    pass


DIAGNOSIS = ('Builder checks require affected tests, one exact Mobile class or scenario, '
             'or an affected Go package. Full acceptance belongs to the dispatcher/verifier. '
             'For a wider investigation, use fleet-task.py investigate with retained failed '
             'test evidence and requested scope; no diagnostic runs merely by requesting it.')


def refuse(detail):
    raise PolicyError('Test selection policy: ' + detail + '. ' + DIAGNOSIS)


def options(args, names):
    values = []
    for index, token in enumerate(args):
        for name in names:
            if token == name:
                if index + 1 >= len(args):
                    refuse(name + ' needs an explicit selector')
                values.append(args[index + 1])
            elif token.startswith(name + '='):
                values.append(token[len(name) + 1:])
    return values


def option(args, names):
    values = options(args, names)
    if len(values) > 1:
        refuse('duplicate selection flags can override an earlier selection')
    return values[0] if values else None


def named_go(value, prefix):
    # Explicit test names and alternatives only. The affected package form is
    # available when a useful regex family cannot be represented this way.
    if value == '^$':
        return True
    raw = value.removeprefix('^').removesuffix('$')
    if raw.startswith('(') and raw.endswith(')'):
        raw = raw[1:-1]
    return bool(raw) and all(re.fullmatch(prefix + r'[A-Za-z0-9_]+(?:/[A-Za-z0-9_.,=:\\ -]+)*', name)
                             for name in raw.split('|'))


def go_command(args):
    # Go's global directory flag precedes its subcommand.
    args = list(args)
    directory = None
    if args[:1] == ['-C']:
        if len(args) < 3:
            refuse('Go -C needs a directory and command')
        directory, args = args[1], args[2:]
    elif args and args[0].startswith('-C='):
        directory, args = args[0][3:], args[1:]
    return directory, args


def go_selection(args):
    _, args = go_command(args)
    if not args or args[0] != 'test':
        return
    args = args[1:]
    # These operations do not execute tests or benchmarks.
    compilation = [arg for arg in args if arg == '-c' or arg.startswith('-c=')]
    if len(compilation) > 1:
        refuse('duplicate compile flags can change whether tests execute')
    if compilation and compilation[0] in {'-c', '-c=true'} and '-args' not in args:
        return
    listed = option(args, ['-list', '-test.list'])
    if listed is not None and listed and '-args' not in args:
        return
    run = option(args, ['-run', '-test.run'])
    bench = option(args, ['-bench', '-test.bench'])
    fuzz = option(args, ['-fuzz', '-test.fuzz'])
    for value, prefix in [(run, 'Test'), (bench, 'Benchmark'), (fuzz, 'Fuzz')]:
        if value is not None and not named_go(value, prefix):
            refuse('catch-all or unbounded Go selection')
    if run is not None:
        return
    # Module-wide selection needs explicit named tests. Concrete affected
    # packages can run their own tests, including a narrowly rooted subtree.
    value_flags = {'-run','-test.run','-bench','-test.bench','-fuzz','-test.fuzz',
                   '-list','-test.list','-timeout','-test.timeout','-count','-test.count',
                   '-parallel','-test.parallel','-cpu','-test.cpu','-p','-tags','-mod',
                   '-coverpkg','-coverprofile','-covermode','-benchtime',
                   '-test.benchtime','-fuzztime','-test.fuzztime','-fuzzminimizetime',
                   '-test.fuzzminimizetime','-shuffle','-test.shuffle','-o','-exec',
                   '-gcflags','-ldflags','-asmflags','-modfile','-overlay',
                   '-blockprofile','-cpuprofile','-memprofile','-mutexprofile','-trace'}
    packages = []
    skip = False
    for token in args:
        if skip:
            skip = False
        elif token in value_flags:
            skip = True
        elif token.startswith('-'):
            continue
        else:
            packages.append(token)
    # One local affected package or narrow subtree is reviewable. Import-path
    # aliases, absolute paths and multiple packages require named tests.
    if len(packages) > 1:
        refuse('select one affected Go package or name the affected tests')
    package = packages[0] if packages else '.'
    if package != '.' and not re.fullmatch(r'\./[A-Za-z0-9_-]+(?:/[A-Za-z0-9_-]+)*(?:/\.\.\.)?', package):
        refuse('use one local affected Go package or explicit named tests')
    if package in {'./internal/...', './cmd/...'}:
        refuse('module-wide Go tests need an explicit named selection')


CLASS = r'de\.pyryco\.mobile(?:\.[A-Za-z_$][A-Za-z0-9_$]*)+'


def mobile_names(values, methods=False):
    if not isinstance(values, list) or not 1 <= len(values) <= 64:
        refuse('an empty or unbounded Mobile selection')
    classes = set()
    for name in values:
        if not isinstance(name, str) or len(name) > 1024:
            refuse('an invalid Mobile selector')
        parts = name.split('#', 1)
        if not re.fullmatch(CLASS, parts[0]) or methods and len(parts) != 2:
            refuse('Mobile selectors must name an exact class or method')
        if len(parts) == 2 and (not parts[1] or re.search(r'[*?\x00-\x1f\x7f]', parts[1])):
            refuse('Mobile method wildcards are not focused selections')
        if parts[0].endswith('.RecordedMobileSuiteTest') and len(parts) == 1:
            refuse('the aggregate recording suite belongs to the dispatcher')
        classes.add(parts[0])
    if len(classes) != 1:
        refuse('run one affected Mobile class per focused invocation')


def android_selection(args):
    if not args:
        refuse('an Android mode and focused selection are required')
    if args[0] == 'scripted' and len(args) >= 2 and re.fullmatch(r'[a-z][a-z-]*', args[1]) and args[1] not in {'all', 'full'}:
        return
    if args[0] not in {'ui', 'live'}:
        refuse('complete scripted or device suites are dispatcher-owned')
    tests = option(args, ['--tests'])
    if tests is None:
        refuse('an unselected Android suite')
    mobile_names(tests.split(','), methods=args[0] == 'live')


def jvm_selection(args):
    tests = option(args, ['--tests'])
    encoded = option(args, ['--tests-json'])
    classes = option(args, ['--classes'])
    if sum(value is not None for value in [tests, encoded, classes]) != 1:
        refuse('one explicit JVM selection is required')
    if encoded is not None:
        try:
            names = json.loads(encoded)
        except (ValueError, TypeError):
            refuse('malformed JVM JSON selection')
        mobile_names(names, methods=True)
    else:
        mobile_names((tests if tests is not None else classes).split(','), methods=tests is not None)


def gradle_selection(args):
    tests = options(args, ['--tests'])
    instrumentation = option(args, ['-Pandroid.testInstrumentationRunnerArguments.class'])
    tasks = []
    skip = False
    value_flags = {'--tests','--console','--max-workers','--warning-mode','--project-dir','-p',
                   '--gradle-user-home','-g','--init-script','-I','--include-build',
                   '--configuration-cache-problems','--priority','--dependency-verification',
                   '--write-verification-metadata','-P','-D'}
    for token in args:
        if skip:
            skip = False
        elif token in value_flags:
            skip = True
        elif token.startswith('-'):
            continue
        else:
            tasks.append(token.removeprefix(':app:'))
    if not tasks:
        if any(x in {'--version', '--help', '-h', '-v'} for x in args):
            return
        refuse('Gradle default tasks do not define a focused check')
    compilation = re.compile(r'(?:assemble(?:Debug|Release)?(?:AndroidTest)?|compile(?:Debug|Release)(?:UnitTest|AndroidTest)?Kotlin|lint(?:Debug|Release)?|spotless(?:Check|Apply)|clean|help|tasks|properties|dependencies)')
    for task in tasks:
        # This managed-device setup prepares its image without running tests.
        if compilation.fullmatch(task) or task == 'pixel2Api33AtdSetup':
            continue
        if task == 'testDebugUnitTest' and tests:
            names = []
            for pattern in tests:
                match = re.fullmatch(r'(de\.pyryco\.mobile(?:\.[a-z_][A-Za-z0-9_$]*)*\.[A-Z_$][A-Za-z0-9_$]*)(?:\.([^*?\x00-\x1f\x7f]+))?', pattern)
                if match is None:
                    refuse('Gradle test selectors must name an exact Mobile class or method')
                names.append(match[1] + ('#' + match[2] if match[2] is not None else ''))
            mobile_names(names)
            continue
        if re.fullmatch(r'(?:pixel2Api33AtdDebugAndroidTest|connectedDebugAndroidTest|connectedAndroidTest)', task) and instrumentation is not None:
            mobile_names(instrumentation.split(','))
            continue
        refuse('Gradle task ' + task + ' is not an explicit focused test or ordinary build/static task')


def desktop_unit_selection(args):
    if len(args) != 2 or args[0] not in {'--files-json', '--tests-json'}:
        refuse('select one exact Desktop unit file or its named tests')
    try:
        values = json.loads(args[1])
    except (TypeError, ValueError):
        refuse('malformed Desktop unit selection')
    if not isinstance(values, list) or not 1 <= len(values) <= 64 or len(args[1]) > 32768:
        refuse('empty or unbounded Desktop unit selection')
    files = set()
    for value in values:
        if not isinstance(value, str) or len(value) > 2048 or re.search(r'[\x00-\x1f\x7f]', value):
            refuse('invalid Desktop unit name')
        file, separator, name = value.partition('#')
        if (not re.fullmatch(r'(?:src|e2e|scripts)/(?:[A-Za-z0-9_-]+/)*[A-Za-z0-9_.-]+\.(?:test|spec)\.tsx?', file)
                or '..' in file.split('/') or file.startswith('e2e/') and '.spec.' in file):
            refuse('Desktop unit files must be exact repository-relative test paths')
        if (args[0] == '--tests-json') != bool(separator) or separator and not name.strip():
            refuse('Desktop named tests require file#full test title')
        files.add(file)
    if len(files) != 1:
        refuse('select one affected Desktop unit file per builder invocation')


def selection(kind, args):
    validators = {'go': go_selection, 'android': android_selection, 'jvm': jvm_selection, 'gradle': gradle_selection,
                  'desktop-unit': desktop_unit_selection}
    if kind not in validators:
        raise PolicyError('Unknown managed test entry point')
    if list(args) == ['--help'] and kind in {'android', 'jvm'}:
        return
    validators[kind](list(args))


def context_directory(root):
    root = Path(root).resolve()
    git = root / '.git'
    if git.is_file():
        value = git.read_text().strip()
        if not value.startswith('gitdir: '):
            raise PolicyError('Managed test context has an invalid Git worktree link')
        git = (root / value[8:]).resolve()
    return git / 'pyry-test-context'


def socket_context(path):
    class Connection(http.client.HTTPConnection):
        def connect(self):
            self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            self.sock.settimeout(3)
            self.sock.connect(path)
    connection = Connection('localhost', timeout=3)
    try:
        connection.request('POST', '/test-context', '{}', {'Content-Type': 'application/json'})
        response = connection.getresponse()
        raw = response.read(16385)
        if response.status != 200 or len(raw) > 16384:
            raise ValueError('unavailable context')
        return json.loads(raw)
    finally:
        connection.close()


def check(root, kind, args, env=None):
    root = Path(root).resolve()
    try:
        folder = context_directory(root)
        for candidate in [Path.cwd(), *Path.cwd().parents]:
            if (candidate / '.git').exists():
                claimed = context_directory(candidate)
                if (claimed.exists() or claimed.with_name('pyry-test-managed').exists()) and candidate.resolve() != root:
                    raise PolicyError('Managed test context belongs to the caller worktree; a different product root is not allowed')
                break
        if not folder.exists() and folder.with_name('pyry-test-managed').exists():
            raise PolicyError('Managed test context was deleted; no test was admitted')
    except OSError as error:
        raise PolicyError('Managed test context unreadable; no test was admitted') from error
    if not folder.exists():
        # Old workers have a legacy task socket but no binding. Do not strand
        # their active work during rollout. Ordinary operator invocations also
        # have no binding. Editable environment alone never supplies authority.
        return
    try:
        record = json.loads((folder / 'context.json').read_text())
        if (not isinstance(record, dict) or record.get('version') != 1 or record.get('root') != str(root) or
                not isinstance(record.get('runId'), str) or not record['runId'] or
                not isinstance(record.get('socket'), str) or not record['socket'].startswith('/')):
            raise ValueError('foreign or malformed worktree binding')
        executing_tests = kind != 'go' or go_command(args)[1][:1] == ['test']
        caller_root = candidate.resolve()
        if kind == 'go':
            directory, _ = go_command(args)
            if directory is not None and (Path.cwd() / directory).resolve().is_relative_to(root):
                caller_root = root
        if executing_tests and caller_root != root and (candidate / '.git').exists():
            raise ValueError('caller is in a different Git worktree')
        reply = socket_context(record['socket'])
        if (not isinstance(reply, dict) or reply.get('version') != 1 or reply.get('runId') != record['runId'] or
                reply.get('project') != record.get('project') or not isinstance(reply.get('role'), str)):
            raise ValueError('stale or foreign run context')
    except (OSError, ValueError, TypeError, KeyError, http.client.HTTPException) as error:
        raise PolicyError('Managed test context unavailable; no test was admitted: ' + str(error)) from error
    if reply['role'] in {'builder', 'developer'} and reply.get('origin') != 'dispatcher-gate':
        actual = list(args)
        effective_env = os.environ if env is None else env
        if kind == 'go':
            directory, actual = go_command(actual)
            if actual[:1] == ['test'] and directory is not None and not (Path.cwd() / directory).resolve().is_relative_to(root):
                refuse('Go -C must stay inside the admitted product worktree')
            if actual[:1] == ['test'] and effective_env.get('GOFLAGS'):
                actual = ['test', *shlex.split(effective_env['GOFLAGS']), *actual[1:]]
        selection(kind, actual)
