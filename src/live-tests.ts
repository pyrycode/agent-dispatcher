/**
 * Read a pull request's `## Live tests` section once, for both gate selection
 * and named acceptance.
 *
 * The section runs from its heading to the next heading, a thematic break or
 * a footer line (`🤖 Generated with ...`, `Co-Authored-By:`), whichever comes
 * first. Blank lines and HTML comments are skipped and list markers are
 * stripped. Commas separate names, except inside a Markdown code span, so a
 * backticked Playwright title keeps its commas and colons.
 *
 * Each entry must be a test name: a code span, a single word with no spaces
 * (`pkg.TestName/sub`, `a.b.Class#method`, `file.spec.ts`), or a Playwright
 * title joined with ` › `. `all` asks for the whole suite and `none` for no
 * named tests. Anything else is prose, and its whole line is reported in
 * `invalid` rather than read as names: a stray `Review: ...` line under the
 * heading became a required test on Mobile #2132, and the generated footer
 * did on #1847. An invalid section yields no names at all.
 */
export interface LiveTestEntries {
  /** A `## Live tests` heading exists. */
  present: boolean;
  /** `all` was listed. */
  all: boolean;
  /** Valid names, in order, without repeats. Empty when `invalid` is not. */
  names: string[];
  /** Lines under the heading that are not test names, verbatim. */
  invalid: string[];
}

const FOOTER = /^(?:🤖|generated with\b|co-authored-by:)/i;
const THEMATIC_BREAK = /^(?:-{3,}|\*{3,}|_{3,})$/;

export function parseLiveTestEntries(body: string): LiveTestEntries {
  const lines = body.split(/\r?\n/);
  const start = lines.findIndex(line => /^##\s+live tests\s*$/i.test(line.trim()));
  const result: LiveTestEntries = { present: start >= 0, all: false, names: [], invalid: [] };
  if (start < 0) return result;
  const names: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const trimmed = line.trim();
    if (/^#{1,6}\s/.test(trimmed) || THEMATIC_BREAK.test(trimmed) || FOOTER.test(trimmed)) break;
    if (trimmed === "" || /^<!--.*-->$/.test(trimmed)) continue;
    const text = trimmed.replace(/^(?:[-*+]|\d+[.)])\s+/, "");
    const entries = splitEntries(text);
    const lineNames: string[] = [];
    let lineAll = false, valid = entries !== null;
    for (const entry of entries ?? []) {
      const name = entry.code ? entry.text : entry.text.trim();
      if (name === "") continue;
      const word = name.toLowerCase();
      if (!entry.code && word === "all") lineAll = true;
      else if (!entry.code && word === "none") continue;
      else if (entry.code || !/\s/.test(name) || name.includes(" › ")) lineNames.push(name);
      else valid = false;
    }
    if (!valid) { result.invalid.push(trimmed); continue; }
    if (lineAll) result.all = true;
    for (const name of lineNames) if (!names.includes(name)) names.push(name);
  }
  result.names = result.invalid.length === 0 ? names : [];
  return result;
}

/** Split at commas outside code spans. A code span must be the whole entry;
 *  an unclosed span or text beside one is not a name, so returns null. */
function splitEntries(text: string): { text: string; code: boolean }[] | null {
  const entries: { text: string; code: boolean }[] = [];
  let i = 0;
  while (i <= text.length) {
    while (text[i] === " " || text[i] === "\t") i++;
    if (text[i] === "`") {
      let end = i;
      while (text[end] === "`") end++;
      const fence = text.slice(i, end);
      const close = text.indexOf(fence, end);
      if (close < 0) return null;
      entries.push({ text: text.slice(end, close).trim(), code: true });
      i = close + fence.length;
      while (text[i] === " " || text[i] === "\t") i++;
      if (i < text.length && text[i] !== ",") return null;
      i++;
      continue;
    }
    const comma = text.indexOf(",", i);
    const end = comma < 0 ? text.length : comma;
    const part = text.slice(i, end);
    if (part.includes("`")) return null;
    entries.push({ text: part, code: false });
    i = end + 1;
  }
  return entries;
}

/** The named tests a pull request requires the live gate to execute and
 *  pass. `all`, `none`, an empty or missing section, and an invalid section
 *  all require no named test. */
export function requiredLiveTestNames(body: string): string[] {
  const entries = parseLiveTestEntries(body);
  return entries.all ? [] : entries.names;
}

/** A clear message for an invalid section, or null when it is valid. */
export function liveTestsSectionError(body: string): string | null {
  const { invalid } = parseLiveTestEntries(body);
  if (invalid.length === 0) return null;
  return "The pull request's `## Live tests` section has lines that are not test names, so it names no required test until they are fixed:\n" +
    invalid.map(line => `- \`${line.replace(/`/g, "'")}\``).join("\n") +
    "\nList one test name per line (backtick a title with spaces or commas), or write `all`. " +
    "Move prose out of the section, below another heading.";
}
