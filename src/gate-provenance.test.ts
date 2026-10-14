import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { gateCommandProvenance, gateOutputFormatFromCommand, parseGateOutput, parseGateTestDetails } from "./gate-output.js";
import { decideGateVerdict } from "./pipeline-decisions.js";

const playwright = readFileSync(new URL("./fixtures/desktop-1809-live-report.json", import.meta.url), "utf8");
const go = Array.from({ length: 10 }, (_, i) => JSON.stringify({ Action: "pass", Package: "fixture", Test: `TestOther${i}` })).join("\n");

test("each test invocation must supply consistent reporter provenance", () => {
  for (const [json, ordinary] of [
    ["go test -json ./...", "go test ./ordinary"],
    ["playwright test --reporter=json", "playwright test"],
  ]) {
    for (const separator of [";", "&&", "||", "|", "\n"]) {
      for (const order of [[json, ordinary], [ordinary, json]]) {
        assert.deepEqual(gateCommandProvenance(order.join(separator)), { kind: "ambiguous" }, order.join(separator));
      }
    }
  }
});

test("expansions belong to their shell word and invocation", () => {
  for (const command of [
    'echo "$BUILD_STEP"; go test -json ./...',
    'echo "$BUILD_STEP" && go test "-json" ./... > "$LOG_PATH" 2>&1',
    'go test -json ./...; echo "$BUILD_STEP"',
    'echo "$BUILD_STEP"; npx playwright test --reporter="json"',
    'echo "$BUILD_STEP"; go test -json ./... # $UNRELATED',
    'echo "${BUILD_STEP}"; command go test -json ./...',
    "echo '$BUILD_STEP; go test'; go test -json ./...",
    "echo \"\\$BUILD_STEP\"; go test -json ./...",
  ]) assert.equal(gateCommandProvenance(command).kind, "single", command);
  for (const command of [
    '"$TEST_RUNNER" test -json ./...',
    'echo "$BUILD_STEP"; "$TEST_RUNNER" test -json ./...',
    'go "$TEST_COMMAND" -json ./...', 'go test "$JSON_FLAG" ./...',
    'playwright test --reporter="$REPORTER"', 'npx "$TEST_RUNNER" test --reporter=json',
    'go test -json ./...; "$TEST_RUNNER" test ./ordinary',
    'go test -json ./...; exec "$TEST_RUNNER" test ./ordinary',
    'command "$TEST_RUNNER" test -json ./...', 'go test -json ./...; /bin/g? test ./ordinary',
    'go test -json=$(echo true) ./...', 'go test `echo -json` ./...',
    'go test -json ./... <<EOF\nignored\nEOF',
  ]) assert.deepEqual(gateCommandProvenance(command), { kind: "ambiguous" }, command);
  for (const command of [
    "go test ./... > '-json'", "playwright test > '--reporter=json'",
    "go test -run '-json' ./...", 'echo "go test -json; playwright test --reporter=json"',
  ]) assert.deepEqual(gateCommandProvenance(command), { kind: "missing" }, command);
});

test("command provenance respects adjacent shell operators and quoted single arguments", () => {
  for (const command of [
    "go test -json ./...;", "go test -json;echo done", "go test '-json' ./...",
    'go test "-json" ./...', "go test -json>gate.log", "go test -json\n",
  ]) assert.equal(gateOutputFormatFromCommand(command), "go-json", command);
  for (const command of [
    "playwright test --reporter=json;", "npx playwright test --reporter=json&&echo done",
    "pnpm exec playwright test '--reporter=json'", 'playwright test --reporter "json"',
    "playwright test --reporter=json>gate.log",
    "playwright test --grep 'go test -json; Luna: Low, confirmed' --reporter=json",
    "playwright test --grep '--reporter=html' --reporter=json", "npx --no-install playwright test --reporter=json",
  ]) assert.equal(gateOutputFormatFromCommand(command), "playwright-json", command);
});

test("missing provenance and mixed or conflicting reporters never infer a single format", () => {
  for (const separator of [";", "; ", "&&", "||", "|", "\n"]) {
    for (const commands of [
      ["playwright test --reporter=json", "go test -json ./..."],
      ["go test -json ./...", "playwright test --reporter=json"],
    ]) assert.equal(gateOutputFormatFromCommand(commands.join(separator)), null, commands.join(separator));
  }
  for (const command of [
    "pnpm live-tests", "echo 'go test -json'", 'echo "playwright test --reporter=json"',
    "go test -json=false ./...", "playwright test --reporter=json,line",
    "playwright test --reporter=line --reporter=json", "playwright test --reporter=json --reporter=html",
    "go test -json ./...;playwright test --reporter=line",
    "playwright test --reporter=json;go test ./...", "playwright test --reporter=json # go test -json",
    "playwright test --grep '--reporter=json'", "go test -run '-json' ./...", "go test ./... -args -json",
  ]) {
    // A shell comment cannot add a second reporter.
    const expected = command.includes(" # ") ? "playwright-json" : null;
    assert.equal(gateOutputFormatFromCommand(command), expected, command);
  }
});

test("missing command provenance can use metadata, but ambiguity remains explicit", () => {
  assert.deepEqual(gateCommandProvenance("pnpm live-tests"), { kind: "missing" });
  for (const command of [
    "playwright test --reporter=json; go test -json ./...", "playwright test --reporter=json,line",
    "playwright test --reporter='$REPORTER'", 'playwright test --reporter="$REPORTER"',
    "playwright test --reporter=json 'unterminated", "sh -c 'playwright test --reporter=json'",
  ]) assert.deepEqual(gateCommandProvenance(command), { kind: "ambiguous" }, command);
});

test("partial parsing of mixed or malformed structured artifacts cannot establish acceptance", () => {
  const xml = '<testsuite><testcase classname="fixture" name="optional"><skipped/></testcase></testsuite>';
  for (const raw of [
    `${playwright}\n${go}`, `${go}\n${playwright}`, `${JSON.stringify(JSON.parse(playwright))}\n${go}`,
    `${go}\n${xml}`, `${xml}\n${go}`, `${go}\n{"Action":`, `${go}\n{"unrelated":true}`,
  ]) {
    const tally = parseGateOutput(raw, "go-json");
    assert.equal(tally.recognizedLines, 0);
    assert.equal(decideGateVerdict({ runError: null, timedOut: false, exitCode: 0, minExecuted: 10, tally }).verdict, "unusable");
    assert.equal(parseGateTestDetails(raw, "go-json"), null);
  }
  const raw = `${xml}\n${playwright}`;
  assert.equal(parseGateOutput(raw, "playwright-json").recognizedLines, 0);
  assert.equal(parseGateTestDetails(raw, "playwright-json"), null);
  assert.equal(parseGateOutput(`build log\n${go}\nfinished`, "go-json").passed, 10);
  assert.equal(parseGateOutput(`build log\n${playwright}`, "playwright-json").passed, 26);
});


test("wrapper chains and Go global flags preserve each invocation's reporter", () => {
  for (const ordinary of [
    "go -C /tmp/fixture test", "go -C=/tmp/fixture test", "time go test",
    "command env go test", "env command go test", "time command env MODE=fixture go -C /tmp/fixture test",
  ]) {
    for (const command of [`go test -json ./...; ${ordinary}`, `${ordinary}; go test -json ./...`]) {
      assert.deepEqual(gateCommandProvenance(command), { kind: "ambiguous" }, command);
      assert.equal(decideGateVerdict({ command, outputFormat: "go-json", tally: parseGateOutput(go + "\nok fixture 0.001s", "go-json"),
        runError: null, timedOut: false, exitCode: 0, minExecuted: 10 }).verdict, "unusable", command);
    }
    const command = `echo "$BUILD_STEP"; ${ordinary} -json ./...`;
    assert.deepEqual(gateCommandProvenance(command), { kind: "single", format: "go-json" }, command);
  }
  for (const unresolved of ["go -C", "go -unknown test", "command env --unknown go test", "time --unknown go test",
    'command env "$TEST_RUNNER" test', 'go -C "$DIR" "$SUBCOMMAND"', 'time command go "$SUBCOMMAND"',
    "pnpm -C /tmp/fixture exec go test", 'npm "$SUBCOMMAND" go test', "env -S 'go test'"]) {
    assert.deepEqual(gateCommandProvenance(`go test -json ./...; ${unresolved}`), { kind: "ambiguous" }, unresolved);
  }
  for (const command of [
    "env -- command -- time -p go -C=/tmp/fixture test -json ./...",
    "env -i -u UNUSED --chdir=/tmp/fixture command -p go test -json ./...",
    "command npx --no-install playwright test --reporter=json",
    "time pnpm exec env MODE=fixture go test -json ./...",
  ]) assert.equal(gateCommandProvenance(command).kind, "single", command);
});

test("unsupported launchers cannot hide a test invocation behind another invocation's JSON", () => {
  const tally = parseGateOutput(go + "\nok fixture 0.001s", "go-json");
  const verdict = (command: string) => decideGateVerdict({ command, outputFormat: "go-json", tally,
    runError: null, timedOut: false, exitCode: 0, minExecuted: 10 }).verdict;
  // The October 13 review reproducer for Desktop #1809, in both orders.
  for (const command of ["go test -json ./first; timeout 30 go test ./second", "timeout 30 go test ./second; go test -json ./first"]) {
    assert.deepEqual(gateCommandProvenance(command), { kind: "ambiguous" }, command);
    assert.equal(verdict(command), "unusable", command);
  }
  for (const launcher of [
    "sudo -E go test ./second", "xargs go test", "find . -name go.mod -execdir go test ./... ;",
    "retry --times 3 -- go test ./second", "/usr/local/bin/with-lock gate go test ./second",
    "doas /usr/bin/go test ./second", "sudo npx playwright test", 'sudo "$RUNNER" test ./second',
    "timeout --unknown 30 go test ./second", 'timeout "$GATE_TIMEOUT" go test ./second', "timeout go test ./second",
    "nice --unknown go test ./second", "stdbuf -x go test ./second", "xvfb-run --bogus npx playwright test",
    "nohup", "timeout 30",
  ]) {
    for (const command of [`go test -json ./first; ${launcher}`, `${launcher}; go test -json ./first`]) {
      assert.deepEqual(gateCommandProvenance(command), { kind: "ambiguous" }, command);
      assert.equal(verdict(command), "unusable", command);
    }
  }
});

test("supported launchers resolve to the invocation they run", () => {
  for (const [command, format] of [
    ["timeout 30 go test -json ./...", "go-json"],
    ["timeout 30m go test -json ./...", "go-json"],
    ["timeout -s KILL -k 5s 1.5h go test -json ./...", "go-json"],
    ["timeout --signal=TERM --kill-after=10 --preserve-status 20m go test -json ./...", "go-json"],
    ["timeout -sKILL -- 30 go test -json ./...", "go-json"],
    ["nice -n 10 go test -json ./...", "go-json"],
    ["nice -10 nohup go test -json ./...", "go-json"],
    ["nice --adjustment=5 env MODE=fixture go test -json ./...", "go-json"],
    ["stdbuf -oL -eL go test -json ./...", "go-json"],
    ["stdbuf --output=0 timeout 30 go test -json ./...", "go-json"],
    ["setsid -w go test -json ./...", "go-json"],
    ["xvfb-run -a npx playwright test --reporter=json", "playwright-json"],
    ["xvfb-run --auto-servernum -s '-screen 0 1280x720x24' npx playwright test --reporter=json", "playwright-json"],
    ["xvfb-run --server-args='-screen 0 1280x720x24' timeout 30m npx playwright test --reporter=json", "playwright-json"],
  ]) assert.deepEqual(gateCommandProvenance(command), { kind: "single", format }, command);
  // A launched runner keeps the per-invocation reporter rule.
  for (const command of [
    "go test -json ./first; timeout 30 go test -json ./second",
    "xvfb-run -a npx playwright test --reporter=json && nice -n 5 npx playwright test --reporter=json",
  ]) assert.equal(gateCommandProvenance(command).kind, "single", command);
  for (const command of ["timeout 30 go test ./...", "xvfb-run -a npx playwright test"]) {
    assert.deepEqual(gateCommandProvenance(command), { kind: "missing" }, command);
  }
});

test("commands that never run their arguments stay unrelated to the gate", () => {
  for (const command of [
    "echo go test ./second; go test -json ./first", "printf '%s\\n' playwright test; go test -json ./first",
    "mkdir -p go; go test -json ./first", "go test -json ./first | tee go", 'test -n "$CI"; go test -json ./first',
    "npm install --no-audit --no-fund >&2 && npm run build >&2 && npx playwright test --config playwright.real-claude.config.ts --reporter=json",
  ]) assert.equal(gateCommandProvenance(command).kind, "single", command);
  assert.deepEqual(gateCommandProvenance("pnpm live-tests"), { kind: "missing" });
  assert.deepEqual(gateCommandProvenance("./gradlew connectedDebugAndroidTest"), { kind: "missing" });
});
