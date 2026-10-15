// Ticket requirements (2026-10-15).
//
// A ticket can carry `requires:<capability>` labels: `requires:macos`,
// `requires:linux` or `requires:android-device`. Every stage of such a ticket
// is admitted only on a computer that advertises every named capability. A
// ticket with no requirement runs anywhere, as before.
//
// A computer advertises its operating system automatically and its hardware
// from its manager configuration (`capabilities`, for example
// ["android-device"] on the Mac with the physical phone attached). The
// manager reports the list to the claim service, which enforces it at
// admission, releases a claim its owner can never satisfy, and names every
// requirement no reporting computer can satisfy.
//
// Motivation: Desktop #1983, a mute test that failed only on macOS, was owned
// by a Linux builder that could not reproduce it.

export const REQUIRES_PREFIX = "requires:";

/** Advertised automatically from the manager's own operating system. */
export const OS_CAPABILITIES = ["macos", "linux"] as const;
/** Advertised only when the manager configuration names them. */
export const HARDWARE_CAPABILITIES = ["android-device"] as const;
export const TICKET_CAPABILITIES = [...OS_CAPABILITIES, ...HARDWARE_CAPABILITIES] as const;
export type OsCapability = typeof OS_CAPABILITIES[number];
export type TicketCapability = typeof TICKET_CAPABILITIES[number];

/**
 * A computer whose last report is older than this is not counted as able to
 * satisfy a requirement in attention: it may be offline. Managers report
 * every minute. Admission and claim release use the last report whatever its
 * age, since a computer's capabilities do not change while it is away.
 */
export const CAPABILITY_REPORT_FRESH_MS = 180_000;
export const CAPABILITY_REPORT_INTERVAL_MS = 60_000;

/** The capability for a Node `process.platform`, or undefined for any other system. */
export function osCapability(platform: string = process.platform): OsCapability | undefined {
  return platform === "darwin" ? "macos" : platform === "linux" ? "linux" : undefined;
}

export function requirementLabel(capability: string): string {
  return `${REQUIRES_PREFIX}${capability}`;
}

/**
 * The capabilities a ticket's labels require, unique and sorted. An unknown
 * name is kept: no computer advertises it, so the ticket waits visibly
 * rather than running anywhere.
 */
export function ticketRequirements(labels: readonly string[]): string[] {
  return [...new Set(labels.filter(l => l.startsWith(REQUIRES_PREFIX)).map(l => l.slice(REQUIRES_PREFIX.length)).filter(Boolean))].sort();
}

export function missingCapabilities(required: readonly string[], capabilities: readonly string[] | undefined): string[] {
  const have = new Set(capabilities ?? []);
  return required.filter(c => !have.has(c));
}

export function isTicketCapability(value: unknown): value is TicketCapability {
  return typeof value === "string" && (TICKET_CAPABILITIES as readonly string[]).includes(value);
}

/**
 * Everything a manager advertises: its operating system, then the hardware
 * its configuration names. The configuration may not name an operating
 * system, so a computer cannot claim to be one it is not.
 */
export function machineCapabilities(configured: unknown, platform: string = process.platform): TicketCapability[] {
  if (configured !== undefined && (!Array.isArray(configured)
    || configured.some(c => !(HARDWARE_CAPABILITIES as readonly string[]).includes(c)))) {
    throw new Error(`capabilities may name only ${HARDWARE_CAPABILITIES.join(", ")}; the operating system is detected`);
  }
  const os = osCapability(platform);
  return [...new Set([...(os ? [os] : []), ...((configured as TicketCapability[] | undefined) ?? [])])].sort() as TicketCapability[];
}

export function validateCapabilityReport(capabilities: unknown): TicketCapability[] {
  if (!Array.isArray(capabilities) || capabilities.length > TICKET_CAPABILITIES.length || capabilities.some(c => !isTicketCapability(c))) {
    throw new Error("Invalid machine capabilities");
  }
  return [...new Set(capabilities as TicketCapability[])].sort();
}

/**
 * The `requires:` label for the operating system a failure was seen on, for
 * a ticket the pipeline files from one run. Undefined on any other system.
 */
export function seenOnLabel(platform: string = process.platform): string | undefined {
  const os = osCapability(platform);
  return os ? requirementLabel(os) : undefined;
}

/** A human-readable operating system name for ticket text. */
export function osName(platform: string = process.platform): string {
  const os = osCapability(platform);
  return os === "macos" ? "macOS" : os === "linux" ? "Linux" : platform;
}

/**
 * The operating-system requirement to drop when a failure tracked on a
 * ticket is seen again on another system: it no longer happens on one
 * system only. Only operating-system labels are touched; a hardware
 * requirement stays. Undefined when nothing changes.
 */
export function osRequirementToDrop(labels: readonly string[], platform: string = process.platform): string | undefined {
  const os = osCapability(platform);
  if (!os) return undefined;
  const other = OS_CAPABILITIES.filter(c => c !== os).map(requirementLabel);
  return labels.find(l => other.includes(l));
}

/**
 * The attention lines for requirements no computer that reported recently
 * can satisfy, from a claim service snapshot. Empty for an older service.
 */
export function capabilityAttention(state: {
  noCapableMachine?: Array<{ ticket: string; requires: string[]; missing: string[] }>;
  machineCapabilities?: Record<string, { capabilities: string[]; updated: number }>;
}): Array<{ ticket: string; requires: string[]; missing: string[]; reason: string }> {
  const reports = Object.entries(state.machineCapabilities ?? {});
  return (state.noCapableMachine ?? []).map(gap => {
    const known = reports.filter(([, r]) => !missingCapabilities(gap.requires, r.capabilities).length).map(([m]) => m);
    const reason = known.length
      ? `No computer that reported in the last ${CAPABILITY_REPORT_FRESH_MS / 60_000} minutes offers ${gap.requires.join(" and ")}. ${known.join(", ")} did earlier; check that its manager is running.`
      : `No computer offers ${gap.requires.join(" and ")}. Configure one, or remove the requires: label.`;
    return { ...gap, reason };
  });
}
