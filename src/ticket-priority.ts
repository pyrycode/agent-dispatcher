// Lower ranks dispatch first. Unknown labels behave like an unmarked ticket.
export function ticketPriority(labels: readonly string[]): number {
  if (labels.includes("priority:high")) return 0;
  if (labels.includes("priority:normal")) return 1;
  if (labels.includes("priority:low")) return 3;
  return 2;
}

/** Stable sorting preserves board order within each priority. */
export function byTicketPriority<T>(items: readonly T[], labels: (item: T) => readonly string[]): T[] {
  return [...items].sort((a, b) => ticketPriority(labels(a)) - ticketPriority(labels(b)));
}
