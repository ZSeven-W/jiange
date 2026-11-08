import { describe, expect, it } from "vitest";
import { defaultDriveColumns, moveDriveColumn, readDriveColumns, writeDriveColumns } from "./drive-columns";

describe("drive column settings", () => {
  it("keeps each account's order and visibility across reloads", () => {
    const data = new Map<string, string>();
    const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } };
    const changed = moveDriveColumn({ ...defaultDriveColumns(), visible: { owner: true, modifier: true, updated: false, created: true } }, "created", "updated");
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
    expect(moveDriveColumn(original, "created", "updated").order).toEqual(["owner", "modifier", "created", "updated"]);
    expect(original.order).toEqual(["owner", "modifier", "updated", "created"]);
    expect(moveDriveColumn(original, "updated", "updated")).toBe(original);
  });
  it("migrates existing time column settings without changing their order", () => {
    const data = new Map([["jiange:drive-columns:v1:7", JSON.stringify({ order: ["created", "updated"], visible: { updated: false, created: true } })]]);
    const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } };
    const migrated = readDriveColumns(storage, 7);
    expect(migrated).toEqual({ order: ["owner", "modifier", "created", "updated"], visible: { owner: false, modifier: false, updated: false, created: true } });
    writeDriveColumns(storage, 7, migrated);
    expect(readDriveColumns(storage, 7)).toEqual(migrated);
    expect(data.has("jiange:drive-columns:v1:7")).toBe(true);
  });
  it("migrates owner preferences and inserts the new hidden modifier column", () => {
    const data = new Map([["jiange:drive-columns:v2:7", JSON.stringify({ order: ["created", "owner", "updated"], visible: { owner: true, updated: false, created: true } })]]);
    const storage = { getItem: (key: string) => data.get(key) ?? null };
    expect(readDriveColumns(storage, 7)).toEqual({ order: ["created", "owner", "modifier", "updated"], visible: { owner: true, modifier: false, updated: false, created: true } });
  });
});
