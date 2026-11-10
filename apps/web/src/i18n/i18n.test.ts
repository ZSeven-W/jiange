import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { beforeEach } from "vitest";
import { fileURLToPath } from "node:url";
import { detectLocale, getLocale, setLocale, t } from "./core";
import { en } from "./en";

const srcRoot = fileURLToPath(new URL("../..", import.meta.url));

function* files(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) yield* files(full);
    else if ((name.endsWith(".ts") || name.endsWith(".tsx")) && !name.includes(".test.") && name !== "en.ts") yield full;
  }
}

/** 每个 t("中文") 字面量都必须有英文词条，漏译会在英文界面露出中文。 */
describe("en dictionary completeness", () => {
  it("covers every t() literal in src", () => {
    const missing: string[] = [];
    for (const file of files(srcRoot)) {
      const s = readFileSync(file, "utf8");
      for (const m of s.matchAll(/\bt\(\s*"([^"]*[一-龥][^"]*)"/g)) {
        const key = m[1];
        if (!(key in en)) missing.push(`${file}: ${key}`);
      }
      for (const m of s.matchAll(/\bt\(\s*'([^']*[一-龥][^']*)'/g)) {
        const key = m[1];
        if (!(key in en)) missing.push(`${file}: ${key}`);
      }
    }
    // via-variable labels: registries/maps whose values are translated by t(var)
    const registry = readFileSync(join(srcRoot, "src/pages/base/registry.ts"), "utf8");
    for (const m of registry.matchAll(/label: "([^"]+)"/g)) if (!(m[1] in en)) missing.push(`registry.ts: ${m[1]}`);
    const fill = readFileSync(join(srcRoot, "src/pages/base/fill.ts"), "utf8");
    for (const m of fill.matchAll(/(low|medium|high|xhigh): "([^"]+)"/g)) if (!(m[2] in en)) missing.push(`fill.ts: ${m[2]}`);
    const bell = readFileSync(join(srcRoot, "src/pages/NotificationBell.tsx"), "utf8");
    for (const m of bell.matchAll(/(mention|reply|resolve): "([^"]+)"/g)) if (!(m[2] in en)) missing.push(`NotificationBell: ${m[2]}`);
    const share = readFileSync(join(srcRoot, "src/components/ShareDialog.tsx"), "utf8");
    for (const m of share.matchAll(/(view|edit|manage|anon|none): "([^"]*[一-龥][^"]*)"/g)) if (!(m[2] in en)) missing.push(`ShareDialog: ${m[2]}`);
    const perms = readFileSync(join(srcRoot, "src/components/sharePermissions.tsx"), "utf8");
    for (const m of perms.matchAll(/label: "([^"]+)"/g)) if (!(m[1] in en)) missing.push(`sharePermissions: ${m[1]}`);
    expect(missing).toEqual([]);
  });

  it("keeps zh-CN as the identity locale", () => {
    expect(t("搜索")).toBe("搜索");
    expect(t("没有这一条")).toBe("没有这一条"); // missing key falls back to the source text
  });

  it("interpolates placeholders", () => {
    setLocale("en");
    expect(t("{n} 条记录", { n: 12 })).toBe("12 records");
    setLocale("zh-CN");
    expect(t("{n} 条记录", { n: 12 })).toBe("12 条记录");
  });
});

describe("locale persistence", () => {
  beforeEach(() => {
    localStorage.setItem("jiange.locale", "zh-CN");
  });
  it("persists the choice and switches dictionaries", () => {
    setLocale("en");
    expect(getLocale()).toBe("en");
    expect(t("搜索")).toBe("Search");
    setLocale("zh-CN");
    expect(t("搜索")).toBe("搜索");
  });
  it("falls back to browser detection without stored state", () => {
    localStorage.removeItem("jiange.locale");
    expect(detectLocale()).toBe("en-US".startsWith("en") ? "en" : "zh-CN");
  });
});
