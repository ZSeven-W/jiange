/**
 * Minimal ZIP support for OOXML (.docx) import/export.
 *
 * Writing uses the STORE method only (no compression) with CRC-32, which
 * every OOXML consumer accepts. Reading supports STORE and DEFLATE (via the
 * platform's DecompressionStream("deflate-raw")), verifies CRC-32 and bounds
 * the inflated size so a crafted archive cannot exhaust memory.
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export interface ZipEntryInput { name: string; data: Uint8Array; }

export class ZipError extends Error {}

function dosDateTime(date: Date): { time: number; date: number } {
  const year = Math.max(1980, Math.min(2107, date.getFullYear()));
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

/** Build a STORE-only zip archive. Entry names are encoded as UTF-8 (flag bit 11). */
export function createZip(entries: ZipEntryInput[], modified = new Date()): Uint8Array {
  const encoder = new TextEncoder();
  const { time, date } = dosDateTime(modified);
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.name)) throw new ZipError(`duplicate zip entry ${entry.name}`);
    seen.add(entry.name);
    const name = encoder.encode(entry.name);
    const crc = crc32(entry.data);
    const size = entry.data.length;
    if (size >= 0xffffffff || offset >= 0xffffffff) throw new ZipError("zip64 is not supported");
    const local = new Uint8Array(30 + name.length + size);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true);
    lv.setUint16(8, 0, true);
    lv.setUint16(10, time, true);
    lv.setUint16(12, date, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, size, true);
    lv.setUint32(22, size, true);
    lv.setUint16(26, name.length, true);
    lv.setUint16(28, 0, true);
    local.set(name, 30);
    local.set(entry.data, 30 + name.length);
    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, time, true);
    cv.setUint16(14, date, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, size, true);
    cv.setUint32(24, size, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    central.set(name, 46);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const centralSize = centrals.reduce((sum, c) => sum + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  const out = new Uint8Array(offset + centralSize + end.length);
  let at = 0;
  for (const part of [...locals, ...centrals, end]) { out.set(part, at); at += part.length; }
  return out;
}

export interface ZipEntry {
  name: string;
  method: number;
  flags: number;
  crc: number;
  compressedSize: number;
  size: number;
  localOffset: number;
}

/** Parse the central directory. Throws ZipError for anything that is not a sane, single-disk zip. */
export function listZip(bytes: Uint8Array): ZipEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const minEnd = Math.max(0, bytes.length - 22 - 0xffff);
  let endAt = -1;
  for (let i = bytes.length - 22; i >= minEnd; i--) {
    if (view.getUint32(i, true) === 0x06054b50) { endAt = i; break; }
  }
  if (endAt < 0) throw new ZipError("end of central directory not found");
  const count = view.getUint16(endAt + 10, true);
  const cdSize = view.getUint32(endAt + 12, true);
  const cdOffset = view.getUint32(endAt + 16, true);
  if (view.getUint16(endAt + 4, true) !== 0 || view.getUint16(endAt + 6, true) !== 0) throw new ZipError("multi-disk zip");
  if (cdOffset + cdSize > endAt || count === 0xffff || cdOffset === 0xffffffff) throw new ZipError("invalid central directory");
  const decoder = new TextDecoder();
  const entries: ZipEntry[] = [];
  let p = cdOffset;
  for (let n = 0; n < count; n++) {
    if (p + 46 > endAt || view.getUint32(p, true) !== 0x02014b50) throw new ZipError("invalid central directory entry");
    const nameLength = view.getUint16(p + 28, true);
    const extraLength = view.getUint16(p + 30, true);
    const commentLength = view.getUint16(p + 32, true);
    if (p + 46 + nameLength > endAt) throw new ZipError("invalid entry name");
    const entry: ZipEntry = {
      flags: view.getUint16(p + 8, true),
      method: view.getUint16(p + 10, true),
      crc: view.getUint32(p + 16, true),
      compressedSize: view.getUint32(p + 20, true),
      size: view.getUint32(p + 24, true),
      localOffset: view.getUint32(p + 42, true),
      name: decoder.decode(bytes.subarray(p + 46, p + 46 + nameLength)),
    };
    if (entry.localOffset + 30 > bytes.length) throw new ZipError("invalid local header offset");
    entries.push(entry);
    p += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

export async function inflateRaw(data: Uint8Array, limit: number): Promise<Uint8Array> {
  if (typeof DecompressionStream === "undefined") throw new ZipError("DecompressionStream unavailable");
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > limit) throw new ZipError("entry exceeds size limit");
      chunks.push(value);
    }
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    if (error instanceof ZipError) throw error;
    throw new ZipError("corrupt deflate data");
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) { out.set(chunk, at); at += chunk.length; }
  return out;
}

/** Extract and CRC-check one entry. `limit` bounds the inflated size in bytes. */
export async function readZipEntry(bytes: Uint8Array, entry: ZipEntry, limit: number): Promise<Uint8Array> {
  if (entry.flags & 1) throw new ZipError("encrypted entry");
  if (entry.size > limit) throw new ZipError("entry exceeds size limit");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const p = entry.localOffset;
  if (view.getUint32(p, true) !== 0x04034b50) throw new ZipError("invalid local header");
  const start = p + 30 + view.getUint16(p + 26, true) + view.getUint16(p + 28, true);
  const end = start + entry.compressedSize;
  if (end > bytes.length) throw new ZipError("truncated entry");
  const raw = bytes.subarray(start, end);
  let data: Uint8Array;
  if (entry.method === 0) data = raw.slice();
  else if (entry.method === 8) data = await inflateRaw(raw, limit);
  else throw new ZipError(`unsupported compression method ${entry.method}`);
  if (data.length !== entry.size || crc32(data) !== entry.crc) throw new ZipError("checksum mismatch");
  return data;
}
