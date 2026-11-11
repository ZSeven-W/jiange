import { describe, expect, it } from "vitest";
import { formatEditDay, formatEditTime, headerMetaText, nextSavedFlag } from "./docHeaderMeta";

const now = new Date(2026, 10, 9, 16, 40);

describe("doc header meta (最近修改 in the top bar)", () => {
  it("formats edit times the Feishu way", () => {
    expect(formatEditTime(new Date(2026, 10, 9, 9, 5).toISOString(), now)).toBe("今天 09:05");
    expect(formatEditTime(new Date(2026, 10, 8, 18, 0).toISOString(), now)).toBe("昨天 18:00");
    expect(formatEditTime(new Date(2026, 9, 2, 8, 30).toISOString(), now)).toBe("10月2日 08:30");
    expect(formatEditTime(new Date(2025, 2, 2, 8, 30).toISOString(), now)).toBe("2025年3月2日 08:30");
    expect(formatEditTime("nope", now)).toBe("");
  });
  it("formats the author-line edit day the Feishu way", () => {
    expect(formatEditDay(new Date(2026, 10, 9, 9, 5).toISOString(), now)).toBe("今天修改");
    expect(formatEditDay(new Date(2026, 10, 8, 18, 0).toISOString(), now)).toBe("昨天修改");
    expect(formatEditDay(new Date(2026, 9, 2, 8, 30).toISOString(), now)).toBe("10月2日修改");
    expect(formatEditDay(new Date(2025, 2, 2, 8, 30).toISOString(), now)).toBe("2025年3月2日修改");
    expect(formatEditDay("nope", now)).toBe("");
  });
  it("shows 最近修改 on open and 已经保存到云端 after a local save", () => {
    const at = new Date(2026, 10, 9, 16, 19).toISOString();
    expect(headerMetaText("synced", false, at, now)).toBe("最近修改：今天 16:19");
    expect(headerMetaText("synced", true, at, now)).toBe("已经保存到云端");
    expect(headerMetaText("syncing", false, at, now)).toBe("保存中…");
    expect(headerMetaText("offline", true, at, now)).toBe("离线，恢复后自动同步");
    expect(headerMetaText("synced", false, undefined, now)).toBe("已经保存到云端");
  });
  it("ignores the initial sync when deciding whether this session saved", () => {
    let f = { seenSynced: false, saved: false };
    f = nextSavedFlag(f, "connecting"); f = nextSavedFlag(f, "syncing");
    expect(f.saved).toBe(false);
    f = nextSavedFlag(f, "synced"); expect(f.saved).toBe(false);
    f = nextSavedFlag(f, "syncing"); expect(f.saved).toBe(true);
    const same = nextSavedFlag(f, "synced"); expect(same).toBe(f);
  });
});
