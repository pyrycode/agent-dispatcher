/** The original feature request, retained through any number of recovery splits. */
const FEATURE_REFERENCE = /^([\w.-]+\/[\w.-]+)#([1-9]\d*)$/;

export function featureRootIssueNumber(reference: string, project?: string): number {
  const match = FEATURE_REFERENCE.exec(reference);
  const number = match ? Number(match[2]) : NaN;
  if (!match || !Number.isSafeInteger(number)) throw new Error('Invalid feature root reference');
  if (project && match[1].toLowerCase() !== project.toLowerCase()) throw new Error('Feature root belongs to another repository');
  return number;
}

/** Missing legacy lineage stays missing. An invalid record must never select a plausible ancestor. */
export function parseFeatureRoot(body: string, project?: string): string | undefined {
  let root: string | undefined;
  let fence: { character: string; length: number } | undefined;
  for (const line of body.split(/\r?\n/)) {
    const boundary = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (boundary) {
      const delimiter = boundary[1];
      if (!fence) fence = { character: delimiter[0], length: delimiter.length };
      else if (delimiter[0] === fence.character && delimiter.length >= fence.length) fence = undefined;
      continue;
    }
    if (fence || !/^\s*<!--\s*feature-root\b/.test(line)) continue;
    const match = /^\s*<!-- feature-root: ([\w.-]+\/[\w.-]+#[1-9]\d*) -->\s*$/.exec(line);
    if (!match) throw new Error('Invalid feature root marker');
    featureRootIssueNumber(match[1], project);
    if (root && root.toLowerCase() !== match[1].toLowerCase()) throw new Error('Conflicting feature root markers');
    root = match[1];
  }
  return root;
}

/** Only the issue URL establishes which repository owns a board item. */
export function featureRootProject(url?: string): string | undefined {
  return url?.match(/^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/[1-9]\d*(?:[?#].*)?$/)?.[1];
}
