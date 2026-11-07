import { describe, expect, it } from "vitest";
import type { BaseRecord } from "@/lib/api";
import { authorizedDetailRecord } from "./recordAuthorization";

describe("record detail authorization", () => {
  it("uses only the latest authorized record and hides it during revalidation", () => {
    const original: BaseRecord = { id: 5, baseId: 1, position: 0, cells: { 1: "公开", 2: "秘密" } };
    const narrowed: BaseRecord = { ...original, cells: { 1: "公开" } };
    expect(authorizedDetailRecord(5, [original], false)).toBeUndefined();
    expect(authorizedDetailRecord(5, [], true)).toBeUndefined();
    expect(authorizedDetailRecord(5, [narrowed], true)?.cells).toEqual({ 1: "公开" });
    expect(authorizedDetailRecord(null, [narrowed], true)).toBeUndefined();
  });
});
