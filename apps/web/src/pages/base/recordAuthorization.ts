import type { BaseRecord } from "@/lib/api";

/** Never fall back to an earlier row while authorization is being refreshed. */
export function authorizedDetailRecord(id: number | null, authorized: readonly BaseRecord[], ready: boolean): BaseRecord | undefined {
  return ready && id !== null ? authorized.find((record) => record.id === id) : undefined;
}
