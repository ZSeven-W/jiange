// 飞书“页面宽度：标准 / 全宽”：按用户 + 文档记在本地，不写入文档内容。
const key = (user: number, doc: number) => `jiange:doc-wide:${user}:${doc}`;

export function readDocWide(user: number, doc: number): boolean {
  try { return typeof localStorage !== "undefined" && localStorage.getItem(key(user, doc)) === "1"; } catch { return false; }
}

export function writeDocWide(user: number, doc: number, wide: boolean) {
  try { if (wide) localStorage.setItem(key(user, doc), "1"); else localStorage.removeItem(key(user, doc)); } catch { /* 隐私模式忽略 */ }
}

export const docWidthClass = (wide: boolean) => (wide ? "max-w-none" : "max-w-[960px]");
