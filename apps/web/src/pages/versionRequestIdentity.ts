/** Reuse an uncertain request for the same label; a new label is a new intent. */
export type VersionRequestIdentity = { label: string; id: string };
export function versionRequestIdentity(previous: VersionRequestIdentity | null, label: string, generate: () => string): VersionRequestIdentity {
  return previous?.label === label ? previous : { label, id: generate() };
}
export function randomVersionRequestId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (n) => n.toString(16).padStart(2, "0")).join("");
}

/** Automatic system snapshots do not consume the user's named-version numbering. */
export function nextNamedVersionNumber(entries: readonly { createdBy: number }[]): number {
  return entries.filter((entry) => entry.createdBy > 0).length + 1;
}
