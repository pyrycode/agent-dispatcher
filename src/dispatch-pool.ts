// Dispatch pool: the set of agent runs in flight, and the bookkeeping the
// poll loop needs to refill a seat the moment one frees.
//
// Before 2026-09-22 a cycle picked up to `PYRY_MAX_CONCURRENT` candidates
// and awaited all of them (`Promise.allSettled`) before the next cycle
// began, so a seat freed by a short run sat empty until the longest run of
// the batch ended. Measured on Mobile's first cycle at a cap of two: the
// refiner finished in 5m22s, the verifier in 11m53s, and the second seat
// idled for 6m24s of a 12-minute cycle. The board's rework routing and
// column advances waited the same way, because both ran between batches.
//
// The pool keeps every run independent. `launch` starts a run and tracks
// it until it settles; `anySettled` resolves when the next run settles so
// the loop can wake early; `drain` waits for everything in flight. The
// loop asks `freeSeats` how many candidates to select and `excludeInFlight`
// drops any candidate a stale snapshot would pick twice.
//
// All pure or promise-only: no I/O, no globals, fully unit-tested.

/** One in-flight run is keyed by agent and ticket, e.g. `builder#590`. */
export function candidateKey(agentName: string, issueNumber: number): string {
  return `${agentName}#${issueNumber}`;
}

/** The loop's wait between board reads when nothing settles first. */
export const DEFAULT_POLL_INTERVAL_MS = 60_000;

/**
 * Floor for `PYRY_POLL_INTERVAL_MS`. 30s polling overran GitHub's hourly
 * GraphQL budget on 2026-05-03; anything under 10s is a typo, not a choice.
 */
export const MIN_POLL_INTERVAL_MS = 10_000;

/**
 * Read the poll interval from the environment. `PYRY_POLL_INTERVAL_MS` as a
 * whole number of milliseconds at or above the floor is used as given; unset,
 * empty, non-numeric, fractional or too small keeps the default. Mobile set
 * 120000 on 2026-09-22 to ease the account-wide API limit, which the
 * dispatchers share with interactive sessions and the board-status cron.
 * Only idle pickup latency changes: a pass that dispatches or a run that
 * settles wakes the loop without waiting out the interval.
 */
export function resolvePollIntervalMs(env: Record<string, string | undefined>): number {
  const raw = (env.PYRY_POLL_INTERVAL_MS ?? "").trim();
  if (!/^\d+$/.test(raw)) return DEFAULT_POLL_INTERVAL_MS;
  const n = Number(raw);
  return n < MIN_POLL_INTERVAL_MS ? DEFAULT_POLL_INTERVAL_MS : n;
}

/** Seats left under the cap for this cycle's selection. Never negative. */
export function freeSeats(maxConcurrent: number, inFlight: number): number {
  return Math.max(0, maxConcurrent - inFlight);
}

/**
 * Drop candidates already in flight. Selection reads a fresh board snapshot
 * each cycle and `wip:<agent>` gates a running ticket, but the label lands
 * a moment after the launch; this keeps a candidate from being picked twice
 * inside that window.
 */
export function excludeInFlight<T extends { agent: { name: string }; item: { issueNumber: number } }>(
  candidates: readonly T[],
  inFlightKeys: ReadonlySet<string>,
): T[] {
  return candidates.filter((c) => !inFlightKeys.has(candidateKey(c.agent.name, c.item.issueNumber)));
}

export class DispatchPool {
  private readonly running = new Map<string, Promise<void>>();
  private waiters: Array<() => void> = [];

  /** Runs in flight right now. */
  get size(): number {
    return this.running.size;
  }

  /** Keys of the runs in flight, for `excludeInFlight`. */
  keys(): ReadonlySet<string> {
    return new Set(this.running.keys());
  }

  has(key: string): boolean {
    return this.running.has(key);
  }

  /**
   * Start a run and track it until it settles. The run's own error handling
   * is its business (the dispatch driver already isolates failures); the
   * pool only needs to know when it is over, so a rejection counts as
   * settled too and is swallowed here after the driver logged it.
   */
  launch(key: string, run: () => Promise<unknown>): void {
    if (this.running.has(key)) {
      throw new Error(`dispatch pool: ${key} is already in flight`);
    }
    const tracked: Promise<void> = Promise.resolve()
      .then(run)
      .then(
        () => undefined,
        () => undefined,
      )
      .finally(() => {
        this.running.delete(key);
        const waiters = this.waiters;
        this.waiters = [];
        for (const wake of waiters) wake();
      });
    this.running.set(key, tracked);
  }

  /**
   * Resolves when the next in-flight run settles. With nothing in flight it
   * never resolves on its own, so the caller races it against the poll
   * interval rather than awaiting it alone.
   */
  anySettled(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  /** Wait for every run in flight to settle. Resolves at once when idle. */
  async drain(): Promise<void> {
    await Promise.allSettled([...this.running.values()]);
  }
}
