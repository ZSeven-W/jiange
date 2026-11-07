import { describe, expect, it } from "vitest";
import { canExportBase } from "./csvAvailability";

describe("CSV export availability", () => {
  it("allows managers and ordinary unprotected unrestricted readers", () => {
    expect(canExportBase({ role: "manage", copyProtected: true }, true)).toBe(true);
    expect(canExportBase({ role: "view", copyProtected: false }, false)).toBe(true);
    expect(canExportBase({ role: "edit" }, false)).toBe(true);
  });
  it("does not offer export without confirmed scope or through protected views", () => {
    expect(canExportBase({ role: "view" }, true)).toBe(false);
    expect(canExportBase({ role: "edit", copyProtected: true }, false)).toBe(false);
    expect(canExportBase({ role: "view" }, undefined)).toBe(false);
    expect(canExportBase({}, false)).toBe(false);
  });
});
