#!/usr/bin/env python3
"""One targeted real-Claude test for builder repairs, with counted evidence."""
import argparse
import json
import os
import subprocess
import sys

class ClaudeEnvironmentError(RuntimeError):
    """A missing live-test credential is setup failure, not a test verdict."""


def live_claude_environment(parent):
    """Fetch the login in memory, strip account credentials from test children."""
    env = {key: value for key, value in parent.items() if not key.startswith("OP_") and key != "PYRY_DEV_AGENTS_TOKEN"}
    token = parent.get("OP_SERVICE_ACCOUNT_TOKEN")
    if env.get("CLAUDE_CODE_OAUTH_TOKEN") or not token:
        return env
    op_env = {**env, "OP_SERVICE_ACCOUNT_TOKEN": token, "OP_BIOMETRIC_UNLOCK_ENABLED": "false"}
    try:
        result = subprocess.run(
            ["op", "read", "--no-newline", "op://kmzgpgsyeesea3pkiuk2ul2phq/Claude long term token/password"],
            env=op_env, capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.TimeoutExpired):
        raise ClaudeEnvironmentError("Dev Agents login lookup unavailable. Check the 1Password CLI and account access.") from None
    if result.returncode or not result.stdout.strip():
        raise ClaudeEnvironmentError("Dev Agents Claude login unavailable. Add or check the Claude long term token item in the account's permitted vault.")
    env["CLAUDE_CODE_OAUTH_TOKEN"] = result.stdout.rstrip("\n")
    return env


def test_counts(mode, output):
    if mode == "go":
        outcomes = {}
        for line in output.splitlines():
            try:
                event = json.loads(line)
            except ValueError:
                continue
            if event.get("Test") and event.get("Action") in ("pass", "fail", "skip"):
                outcomes[(event.get("Package"), event["Test"])] = event["Action"]
        leaves = [status for (package, name), status in outcomes.items()
                  if not any(p == package and n.startswith(name + "/") for p, n in outcomes)]
        return sum(s != "skip" for s in leaves), leaves.count("pass")
    report = json.loads(output)
    statuses = []
    def visit(suite):
        for spec in suite.get("specs", []):
            for test in spec.get("tests", []):
                statuses.extend(result["status"] for result in test.get("results", []))
        for child in suite.get("suites", []):
            visit(child)
    visit(report)
    return sum(s != "skipped" for s in statuses), statuses.count("passed")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("go", "desktop"))
    parser.add_argument("--tests", required=True, help="One Go -run expression or Playwright test title")
    parser.add_argument("--spec", help="Desktop: the affected real-*.spec.ts file")
    args = parser.parse_args()
    if args.tests.strip() in ("", "all", ".*", "^"):
        parser.error("Select the named failing test. The full suite belongs to the dispatcher.")
    if args.mode == "desktop" and not args.spec:
        parser.error("Desktop requires --spec for the affected live spec")
    try:
        env = live_claude_environment(os.environ)
        env.pop("ANTHROPIC_API_KEY", None)
        auth = subprocess.run(["claude", "auth", "status"], env=env, capture_output=True, text=True, timeout=30)
        if auth.returncode or json.loads(auth.stdout).get("loggedIn") is not True:
            raise ClaudeEnvironmentError("Claude authentication unavailable for the targeted live test.")
    except (ClaudeEnvironmentError, OSError, ValueError, subprocess.TimeoutExpired) as error:
        message = str(error) if isinstance(error, ClaudeEnvironmentError) else "Claude login check unavailable."
        print(f"Live gate: environment error: {message}", file=sys.stderr)
        return 2
    command = (["go", "test", "-tags", "e2e_realclaude", "-timeout", "20m", "-count=1", "-json", "-run", args.tests, "./internal/e2e/realclaude/..."]
               if args.mode == "go" else ["npx", "playwright", "test", "--config", "playwright.real-claude.config.ts", args.spec, "--grep", args.tests, "--retries=0", "--reporter=json"])
    # Keep raw output in memory. Redact known credentials before showing any
    # child diagnostic, including a failing command's output.
    try:
        result = subprocess.run(command, env=env, capture_output=True, text=True)
    except OSError:
        print("Live gate: environment error: test command unavailable.", file=sys.stderr)
        return 2
    output = result.stdout
    for stream, text in ((sys.stdout, output), (sys.stderr, result.stderr)):
        for secret in (os.environ.get("OP_SERVICE_ACCOUNT_TOKEN"), env.get("CLAUDE_CODE_OAUTH_TOKEN")):
            if secret:
                text = text.replace(secret, "[REDACTED]")
        if text:
            print(text, file=stream, end="" if text.endswith("\n") else "\n")
    try:
        executed, passed = test_counts(args.mode, output)
    except (ValueError, KeyError, TypeError):
        print("Live gate: no readable test results.", file=sys.stderr)
        return 1
    print(f"Live gate: {executed} executed; {passed} passed; {executed - passed} failed; process exit {result.returncode}", file=sys.stderr)
    return 0 if result.returncode == 0 and executed > 0 and passed == executed else 1


if __name__ == "__main__":
    sys.exit(main())
