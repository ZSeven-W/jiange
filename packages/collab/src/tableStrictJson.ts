/**
 * Strict JSON reader for the unshipped table prototype. Native JSON.parse
 * silently accepts duplicate object keys and unpaired UTF-16 surrogates;
 * different runtimes may then interpret an identical snapshot differently.
 * This scans every key and value before handing the text to JSON.parse.
 *
 * The nesting bound protects the scanner's call stack, not the prototype's
 * operation count or pending queue. More resource limits are required before
 * accepting untrusted network traffic.
 */
export function parseTableSnapshotJson(text: string, maxArrayItems = Number.MAX_SAFE_INTEGER): unknown {
  if (typeof text !== "string") throw new TypeError("snapshot must be text");
  let i = 0;
  const fail = (): never => { throw new SyntaxError("invalid or ambiguous table snapshot JSON"); };
  const space = () => { while (i < text.length && (text[i] === " " || text[i] === "\t" || text[i] === "\r" || text[i] === "\n")) i++; };
  const string = (): string => {
    if (text[i] !== '"') return fail();
    const start = i++;
    let closed = false;
    while (i < text.length) {
      if (text[i] === '"') { i++; closed = true; break; }
      if (text[i] === "\\") { i += 2; continue; }
      i++;
    }
    if (!closed) return fail();
    let value: unknown;
    try { value = JSON.parse(text.slice(start, i)); } catch { return fail(); }
    if (typeof value !== "string") return fail();
    for (let j = 0; j < value.length; j++) {
      const c = value.charCodeAt(j);
      if (c >= 0xd800 && c <= 0xdbff) {
        const next = value.charCodeAt(++j);
        if (!(next >= 0xdc00 && next <= 0xdfff)) return fail();
      } else if (c >= 0xdc00 && c <= 0xdfff) return fail();
    }
    return value;
  };
  const number = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
  const value = (depth: number): void => {
    space();
    if (text[i] === '"') { string(); return; }
    if (text[i] === "{") {
      if (depth >= 128) return fail();
      i++; space();
      if (text[i] === "}") { i++; return; }
      const keys = new Set<string>();
      while (true) {
        space(); const key = string();
        if (keys.has(key)) return fail();
        keys.add(key); space();
        if (text[i++] !== ":") return fail();
        value(depth + 1); space();
        if (text[i] === "}") { i++; return; }
        if (text[i++] !== ",") return fail();
      }
    }
    if (text[i] === "[") {
      if (depth >= 128) return fail();
      i++; space();
      if (text[i] === "]") { i++; return; }
      let count = 0;
      while (true) {
        // A valid snapshot contains only its ops array. Reject an oversized
        // array before JSON.parse allocates it, including malformed nested
        // arrays supplied by untrusted callers.
        if (++count > maxArrayItems) throw new RangeError("table resource limit: maxOperations");
        value(depth + 1); space();
        if (text[i] === "]") { i++; return; }
        if (text[i++] !== ",") return fail();
      }
    }
    for (const literal of ["true", "false", "null"]) {
      if (text.startsWith(literal, i)) { i += literal.length; return; }
    }
    number.lastIndex = i;
    const match = number.exec(text);
    if (!match) return fail();
    i = number.lastIndex;
  };
  value(0); space();
  if (i !== text.length) return fail();
  try { return JSON.parse(text); } catch { return fail(); }
}
