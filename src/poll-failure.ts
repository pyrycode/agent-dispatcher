// What the poll loop does when one poll fails.
//
// Before 2026-10-14 any error that reached the loop, other than a GitHub
// rate-limit or shared-GitHub pause, ended the process. The fleet supervisor
// treats a stopped dispatcher as stopped on purpose, so nothing restarted it,
// and a crash leaves the dispatcher's claim reservations occupied until an
// operator frees them. Three dispatchers stopped that way in three days:
//   - Core: GitHub answered 200 with no data, and the board read failed with
//     a TypeError (now a GitHubNoDataError).
//   - Relay and Mobile: the claim service on pyrybox restarted, and the local
//     machine manager answered workflow reads with `Service 409: {"error":
//     "fetch failed"}` (409 is the manager's catch-all status).
//   - Mobile: a manager request timed out (DOMException TimeoutError).
//
// The rule here: a failure that says "the other side could not be reached or
// had a bad moment" is retried on the next poll with a bounded backoff. Every
// other error still stops the process, because it means a configuration
// mistake, a refused or lost authority (a run grant gone, a ticket owned
// elsewhere), or a bug, and carrying on could act on a wrong picture.
// A failed poll never touches running agent runs: they live in the dispatch
// pool or under a manager grant, outside the poll cycle.

import { githubPauseMs } from "./github-transport.js";

/** GitHub answered without the data a read asked for. Seen as an outage symptom. */
export class GitHubNoDataError extends Error {
  constructor(operation: string, detail: string) {
    super(`GitHub returned no data for ${operation} (${detail}); treating it as a temporary GitHub fault`);
    this.name = "GitHubNoDataError";
  }
}

// Socket-level failures. ENOENT and EACCES count only on connect, where they
// mean the manager's socket is missing while it restarts.
const NETWORK_CODES = new Set([
  "ECONNREFUSED", "ECONNRESET", "ECONNABORTED", "ETIMEDOUT", "EPIPE", "ENOTFOUND", "EAI_AGAIN",
  "EHOSTUNREACH", "ENETUNREACH", "ENETDOWN",
  "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_SOCKET", "UND_ERR_CLOSED",
]);
// The same failures as text, for errors the machine manager relays from the
// claim service inside its catch-all 409 body.
const NETWORK_TEXT = new RegExp(
  "^fetch failed$|socket hang up|aborted due to timeout|" + [...NETWORK_CODES].join("|") + "|^Service (5\\d\\d|408)\\b",
);

function networkReason(error: any): string | null {
  if (error?.name === "TimeoutError") return "a request timed out";
  const code = error?.code;
  if (typeof code === "string" && (NETWORK_CODES.has(code) || ((code === "ENOENT" || code === "EACCES") && error?.syscall === "connect"))) {
    return `the connection failed (${code})`;
  }
  const message = typeof error?.message === "string" ? error.message : "";
  if (message === "fetch failed" || message === "socket hang up") return `the connection failed (${message})`;
  return null;
}

function reasonFor(error: any): string | null {
  if (error instanceof GitHubNoDataError) return "GitHub answered without data";
  const network = networkReason(error);
  if (network) return network;
  const message = error instanceof Error ? error.message : "";
  // Errors from the machine manager or claim service (JsonClient).
  const service = /^Service (\d{3}): ([\s\S]*)$/.exec(message);
  if (service) {
    const status = Number(service[1]);
    if (status >= 500 || status === 408) return `the machine manager answered ${status}`;
    if (status !== 409) return null;
    let relayed = service[2];
    try { relayed = String(JSON.parse(service[2])?.error ?? ""); } catch { /* not JSON: match the raw text */ }
    return NETWORK_TEXT.test(relayed) ? `the claim service was unreachable from the machine manager (${relayed.slice(0, 120)})` : null;
  }
  // Octokit: a GitHub 5xx or 408, or GitHub's own query timeout.
  const status = error?.status;
  if (error?.name === "HttpError" && typeof status === "number" && (status >= 500 || status === 408)) return `GitHub answered ${status}`;
  if (error?.name === "GraphqlResponseError" && /Something went wrong while executing your query/.test(message)) {
    return "GitHub failed the query on its side";
  }
  if (/secondary rate limit/i.test(message)) return "GitHub's secondary rate limit";
  return null;
}

/**
 * A short reason when `error` is a temporary failure of something the poll
 * depends on, or null when it must stop the dispatcher. Follows `cause` a few
 * levels, because Node wraps socket errors in "fetch failed".
 */
export function transientPollFailure(error: unknown): string | null {
  let current: any = error;
  for (let depth = 0; depth < 5 && current; depth++) {
    const reason = reasonFor(current);
    if (reason) return reason;
    current = current?.cause;
  }
  return null;
}

/** Consecutive failed polls. Held by the poll loop across cycles. */
export interface PollOutage { failures: number; since: number | null; notified: boolean }
export function newPollOutage(): PollOutage { return { failures: 0, since: null, notified: false }; }

export const POLL_RETRY_BASE_MS = 5_000;
// The same one-minute ceiling as the GitHub pause, so a stop signal or a
// finished run is handled within a minute even in a long outage.
export const POLL_RETRY_MAX_MS = 60_000;
// After this long the outage goes to the operator channel, once.
export const POLL_OUTAGE_NOTIFY_MS = 10 * 60_000;

export type PollFailureDecision =
  | { kind: "pause"; waitMs: number }
  | { kind: "retry"; waitMs: number; log: string; notify: string | null }
  | { kind: "fatal" };

function minutes(ms: number): string { return `${Math.max(1, Math.round(ms / 60_000))} min`; }

/**
 * Decide what a failed poll does. "pause" is the existing GitHub rate-limit
 * and shared-GitHub wait. "retry" waits with a doubling backoff capped at a
 * minute, and carries one operator notice once the outage has lasted ten
 * minutes. "fatal" rethrows, which stops the dispatcher.
 */
export function decidePollFailure(error: unknown, outage: PollOutage, now: number, repo = process.env.GITHUB_REPO ?? "dispatcher"): PollFailureDecision {
  const pause = githubPauseMs(error);
  if (pause !== null) return { kind: "pause", waitMs: pause };
  const reason = transientPollFailure(error);
  if (reason === null) return { kind: "fatal" };
  outage.failures++;
  outage.since ??= now;
  const waitMs = Math.min(POLL_RETRY_MAX_MS, POLL_RETRY_BASE_MS * 2 ** Math.min(outage.failures - 1, 10));
  const lasted = now - outage.since;
  const detail = error instanceof Error ? error.message : String(error);
  const log = `   ⚠️  Poll failed (${reason}); failure ${outage.failures} in a row` +
    (outage.failures > 1 ? ` over ${minutes(lasted)}` : "") +
    `. Running agent runs continue; next poll in ${Math.round(waitMs / 1000)}s. Detail: ${detail.slice(0, 300)}`;
  let notify: string | null = null;
  if (!outage.notified && lasted >= POLL_OUTAGE_NOTIFY_MS) {
    outage.notified = true;
    notify = `⚠️ **${repo}**: polling has failed for ${minutes(lasted)} (${reason}). ` +
      `No new work starts until it recovers; running agent runs continue. The dispatcher keeps retrying every minute.`;
  }
  return { kind: "retry", waitMs, log, notify };
}

/**
 * Call after a successful poll. Resets the outage and returns what to say
 * about its end: always a log line, and a notice when the operator was told.
 */
export function pollRecovered(outage: PollOutage, now: number, repo = process.env.GITHUB_REPO ?? "dispatcher"): { log: string; notify: string | null } | null {
  if (outage.failures === 0) return null;
  const lasted = minutes(now - (outage.since ?? now));
  const result = {
    log: `   ✅ Poll recovered after ${outage.failures} failed poll(s) over ${lasted}.`,
    notify: outage.notified ? `✅ **${repo}**: polling recovered after ${lasted} and ${outage.failures} failed polls.` : null,
  };
  Object.assign(outage, newPollOutage());
  return result;
}
