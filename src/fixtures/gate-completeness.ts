import type { GateOutputFormat } from "../gate-output.js";

export const completeGo = Array.from({ length: 10 }, (_, i) =>
  JSON.stringify({ Action: "pass", Package: "fixture", Test: `TestOther${i}` })).join("\n");
export const completePlaywright = JSON.stringify({ suites: [{ title: "fixture.spec.ts", specs:
  Array.from({ length: 10 }, (_, i) => ({ title: `other ${i}`, tests: [{ status: "expected", results: [{ status: "passed" }] }] })),
}] });
export const completeJUnit = '<testsuite name="fixture" tests="10">' +
  Array.from({ length: 10 }, (_, i) => `<testcase classname="fixture" name="other${i}"/>`).join("") + '</testsuite>';

// Tagged build diagnostics are prose, including between Go events. These
// synthetic fixtures exercise readers and recovery, never live acceptance.
export const loggedArtifacts = [
  { name: "Go build preamble", format: "go-json" as const, raw: `[INFO] build starting\n${completeGo}`, green: completeGo },
  { name: "Go interleaved logs", format: "go-json" as const,
    raw: completeGo.split("\n").join("\n[build] compiling package\n") + "\n[INFO] build finished", green: completeGo },
  { name: "Playwright build preamble", format: "playwright-json" as const,
    raw: `[INFO] build starting\n[build] compiling package\n${completePlaywright}`, green: completePlaywright },
];
export const loggedFailures = [
  { name: "Go failure beside logs", format: "go-json" as const, green: completeGo,
    failedName: "fixture.TestFailure/case:Low,confirmed",
    raw: `[INFO] build starting\n${completeGo}\n[ERROR] assertion failed\n` + [
      { Action: "run", Package: "fixture", Test: "TestFailure/case:Low,confirmed" },
      { Action: "fail", Package: "fixture", Test: "TestFailure/case:Low,confirmed" },
      { Action: "fail", Package: "fixture" },
    ].map(e => JSON.stringify(e)).join("\n") },
  { name: "Playwright failure beside logs", format: "playwright-json" as const, green: completePlaywright,
    failedName: "fixture.spec.ts › failure: Low, confirmed",
    raw: `[INFO] build starting\n[ERROR] assertion failed\n` + JSON.stringify({ suites: [
      ...JSON.parse(completePlaywright).suites,
      { title: "fixture.spec.ts", specs: [{ title: "failure: Low, confirmed", tests: [
        { status: "unexpected", results: [{ status: "failed" }] },
      ] }] },
    ] }) },
];

// Synthetic reports exercise parser/recovery decisions; they are not live acceptance.
export const incompleteArtifacts: { name: string; format: GateOutputFormat; raw: string; green: string }[] = [
  { name: "unfinished Go Luna", format: "go-json", green: completeGo,
    raw: `${completeGo}\n${JSON.stringify({ Action: "run", Package: "fixture", Test: "TestLuna" })}` },
  { name: "comment-prefixed XML mixed with Go", format: "go-json", green: completeGo,
    raw: `${completeGo}\n<!-- JUnit report -->${completeJUnit}` },
  ...["[]", '[{"Action":"pass","Test":"TestHidden"}]', '["INFO"]', "[true]", "[false]", "[null]", "[1]",
    "[", '[{"Action":', '["unterminated', "[INFO", "[INFO] {\"suites\":", "[INFO] [null]"].flatMap((array, i) => [
    { name: `array or malformed bracket record with Go ${i}`, format: "go-json" as const, green: completeGo,
      raw: `[INFO] build starting\n${completeGo}\n${array}` },
    { name: `array or malformed bracket preamble with Playwright ${i}`, format: "playwright-json" as const, green: completePlaywright,
      raw: `${array}\n${completePlaywright}` },
  ]),
  ...[null, {}, { status: "unknown", results: [{ status: "passed" }] },
    { status: "expected", results: [{ status: "running" }] }, { status: "expected", results: [] }].map((test, i) => ({
    name: `malformed Playwright Luna ${i}`, format: "playwright-json" as const, green: completePlaywright,
    raw: JSON.stringify({ suites: [...JSON.parse(completePlaywright).suites,
      { title: "luna.spec.ts", specs: [{ title: "GPT-6 Luna: Low, confirmed", tests: [test] }] }],
    }),
  })),
];

// A normal reporter beside a JSON reporter must not borrow its provenance.
export const wrappedGoCommands = [
  "go -C /tmp/fixture test", "go -C=/tmp/fixture test", "time go test",
  "command env go test", "env command go test", "time command env MODE=fixture go -C /tmp/fixture test",
];
export const mixedGoCommands = wrappedGoCommands.flatMap(ordinary => [
  `go test -json ./...; ${ordinary} ./ordinary`,
  `${ordinary} ./ordinary; go test -json ./...`,
]);
export const singleWrappedGoCommands = wrappedGoCommands.map(command => `${command} -json ./...`);

export function repeatedGo(statuses: readonly ("pass" | "fail" | "skip")[], others = 10): string {
  return [
    { Action: "start", Package: "fixture" },
    ...Array.from({ length: others }, (_, i) => [
      { Action: "run", Package: "fixture", Test: `TestOther${i}` },
      { Action: "pass", Package: "fixture", Test: `TestOther${i}` },
    ]).flat(),
    ...statuses.flatMap(Action => [
      { Action: "run", Package: "fixture", Test: "TestRepeated/case:Low,confirmed" },
      { Action, Package: "fixture", Test: "TestRepeated/case:Low,confirmed" },
    ]),
    { Action: statuses.includes("fail") ? "fail" : "pass", Package: "fixture" },
  ].map(event => JSON.stringify(event)).join("\n");
}
