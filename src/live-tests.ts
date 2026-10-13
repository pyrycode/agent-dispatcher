/** Read live requirements once for both selection and acceptance. Commas
 * separate plain names, but belong to a title inside a Markdown code span. */
export function parseLiveTestEntries(body: string): { all: boolean; names: string[] } {
  const lines = body.split(/\r?\n/);
  const start = lines.findIndex(line => /^##\s+live tests\s*$/i.test(line.trim()));
  const names: string[] = [];
  let all = false;
  if (start < 0) return { all, names };
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,2}\s/.test(line.trim())) break;
    const text = line.replace(/^\s*[-*]\s*/, "");
    let ticks = 0;
    let from = 0;
    const add = (entry: string) => {
      const name = entry.trim().replace(/^`+|`+$/g, "").trim();
      if (!name) return;
      if (name.toLowerCase() === "all") all = true;
      else if (!names.includes(name)) names.push(name);
    };
    for (let i = 0; i < text.length; i++) {
      if (text[i] === "`") {
        let end = i + 1;
        while (text[end] === "`") end++;
        const count = end - i;
        if (ticks === 0) ticks = count;
        else if (ticks === count) ticks = 0;
        i = end - 1;
      } else if (text[i] === "," && ticks === 0) {
        add(text.slice(from, i));
        from = i + 1;
      }
    }
    add(text.slice(from));
  }
  return { all, names };
}
