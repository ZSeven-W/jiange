import { describe, expect, it } from "vitest";
import { defaultDriveColumns, moveDriveColumn, readDriveColumns, writeDriveColumns } from "./drive-columns";

describe("drive column settings", () => {
  it("keeps each account's order and visibility across reloads", () => {
    const data = new Map<string, string>();
    const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } };
    const changed = moveDriveColumn({ ...defaultDriveColumns(), visible: { updated: false, created: true } }, "created", "updated");
    expect(writeDriveColumns(storage, 7, changed)).toBe(true);
    expect(readDriveColumns(storage, 7)).toEqual(changed);
    expect(readDriveColumns(storage, 8)).toEqual(defaultDriveColumns());
  });
  it("handles corrupt data and unavailable storage safely", () => {
    for (const raw of ["{", JSON.stringify({ order: ["created", "created"], visible: { updated: true, created: true } }), JSON.stringify({ order: ["created", "updated"], visible: { updated: "false", created: true } })]) {
      expect(readDriveColumns({ getItem: () => raw }, 1)).toEqual(defaultDriveColumns());
    }
    expect(readDriveColumns({ getItem: () => { throw new Error("denied"); } }, 1)).toEqual(defaultDriveColumns());
    expect(writeDriveColumns({ setItem: () => { throw new Error("quota"); } }, 1, defaultDriveColumns())).toBe(false);
  });
  it("moves columns without mutating the previous settings", () => {
    const original = defaultDriveColumns();
    expect(moveDriveColumn(original, "created", "updated").order).toEqual(["created", "updated"]);
    expect(original.order).toEqual(["updated", "created"]);
    expect(moveDriveColumn(original, "updated", "updated")).toBe(original);
  });
});
