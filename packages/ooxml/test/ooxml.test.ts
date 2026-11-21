import { describe, expect, it } from "vitest";
import { createZip, createZipAsync, deflateRaw, inflateRaw, listZip, readZipEntry, parseXml, child, children, textContent, escapeXml, XmlError, ZipError, ZIP_DEFAULT_MAX_ENTRIES } from "../src/index.js";

describe("shared OOXML primitives", () => {
  it("reads a bounded XML entry from a generated archive", async () => {
    const bytes = createZip([{ name: "part.xml", data: new TextEncoder().encode("<root><item>内容</item></root>") }]);
    const entries = listZip(bytes);
    const xml = new TextDecoder().decode(await readZipEntry(bytes, entries[0], 1024));
    expect(child(parseXml(xml), "item")?.children).toEqual(["内容"]);
  });

  it("writes and reads DEFLATE-compressed archives with significant size reduction", async () => {
    const repetitive = new TextEncoder().encode("<sheetData>" + "<row><c><v>123456</v></c></row>".repeat(500) + "</sheetData>");
    const tiny = new TextEncoder().encode("x");
    const empty = new Uint8Array(0);
    const stored = createZip([{ name: "xl/sheet1.xml", data: repetitive }]);
    const compressed = await createZipAsync([
      { name: "xl/sheet1.xml", data: repetitive },
      { name: "tiny.txt", data: tiny },
      { name: "empty.txt", data: empty },
    ], { modified: new Date("2026-01-02T03:04:05Z") });

    expect(compressed.length).toBeLessThan(stored.length / 5);
    const entries = listZip(compressed);
    expect(entries).toHaveLength(3);
    expect(entries[0].method).toBe(8);
    expect(entries[0].compressedSize).toBeLessThan(entries[0].size);
    expect(entries[1].method).toBe(0); // tiny entry does not shrink -> STORE fallback
    expect(entries[2].method).toBe(0); // empty entry -> STORE

    const extracted = await readZipEntry(compressed, entries[0], repetitive.length + 16);
    expect(extracted).toEqual(repetitive);
    expect(await readZipEntry(compressed, entries[1], 16)).toEqual(tiny);
    expect(await readZipEntry(compressed, entries[2], 16)).toEqual(empty);

    const storeExplicit = await createZipAsync([{ name: "a.xml", data: repetitive }], { compression: "store" });
    expect(listZip(storeExplicit)[0].method).toBe(0);
  });

  it("round-trips raw deflate/inflate and rejects duplicate names", async () => {
    const raw = new TextEncoder().encode("jiange-ooxml-deflate-roundtrip-".repeat(20));
    const deflated = await deflateRaw(raw);
    expect(await inflateRaw(deflated, raw.length)).toEqual(raw);
    await expect(createZipAsync([{ name: "dup.xml", data: raw }, { name: "dup.xml", data: raw }])).rejects.toThrow(ZipError);
  });

  it("rejects malformed entities and documents over a caller-supplied element limit", () => {
    expect(() => parseXml("<r>A&B</r>")).toThrow(XmlError);
    expect(() => parseXml("<r>&#0;</r>")).toThrow(XmlError);
    expect(() => parseXml("<r><a/><b/></r>", {maxNodes:2})).toThrow(/too many/);
    expect(child(parseXml("<r>A&amp;B</r>"), "x")).toBeUndefined();
  });

  it("handles XML comments, CDATA, processing instructions, numeric entities, children/textContent/escapeXml, and corrupt zips", () => {
    const doc = parseXml(`<?xml version="1.0"?><!-- note --><root a="1" b='&quot;x&apos;'><n>&#65;&#x42;<![CDATA[<raw>]]></n><n>tail</n></root>`);
    expect(children(doc, "n")).toHaveLength(2);
    expect(children(doc)).toHaveLength(2);
    expect(children(undefined)).toEqual([]);
    expect(textContent(doc)).toBe("AB<raw>tail");
    expect(escapeXml(`<a & "b" 'c'>`)).toBe(`&lt;a &amp; &quot;b&quot; 'c'&gt;`);
    expect(() => parseXml("<a><b></a>")).toThrow(XmlError);
    expect(() => parseXml("<!DOCTYPE x><a/>")).toThrow(XmlError);
    expect(() => listZip(new Uint8Array([1, 2, 3, 4]))).toThrow(ZipError);
  });

  it("covers all XML parser edge cases, entities, whitespace, BOM, and error paths", () => {
    // BOM, whitespace before/after root, whitespace inside opening/closing tags, valid control & astral refs
    const withBom = parseXml("\ufeff  <root  >&#9;&#10;&#13;&#xe000;&#x1f600;</root  >   ");
    expect(textContent(withBom)).toBe("\t\n\r\ue000\u{1f600}");
    expect(parseXml("<self  />").name).toBe("self");

    // Entity errors
    expect(() => parseXml("<r>A&B&amp;</r>")).toThrow(/malformed entity/);
    expect(() => parseXml("<r>&unknown;</r>")).toThrow(/unknown entity/);
    expect(() => parseXml("<r>&#x110000;</r>")).toThrow(/invalid character reference/);
    expect(() => parseXml("<r>&#xfffe;</r>")).toThrow(/invalid character reference/);
    expect(() => parseXml("<r>&#xffff;</r>")).toThrow(/invalid character reference/);
    expect(() => parseXml("<r>&#xd800;</r>")).toThrow(/invalid character reference/);
    expect(() => parseXml("<r>&#xdfff;</r>")).toThrow(/invalid character reference/);

    // Invalid maxNodes
    expect(() => parseXml("<r/>", { maxNodes: 0 })).toThrow(/invalid node limit/);
    expect(() => parseXml("<r/>", { maxNodes: Number.NaN })).toThrow(/invalid node limit/);

    // Trailing / leading text & unexpected EOF
    expect(() => parseXml("<r>unterminated")).toThrow(/unexpected end of document/);
    expect(() => parseXml("<r/>trailing")).toThrow(/text outside root element/);
    expect(() => parseXml("leading<r/>")).toThrow(/text outside root element/);

    // Unterminated PI / comment / CDATA
    expect(() => parseXml("<?xml version='1.0'<r/>")).toThrow(/unterminated processing instruction/);
    expect(() => parseXml("<!-- unterminated")).toThrow(/unterminated comment/);
    expect(() => parseXml("<r><![CDATA[unterminated</r>")).toThrow(/invalid CDATA section/);
    expect(() => parseXml("<![CDATA[outside]]><r/>")).toThrow(/invalid CDATA section/);

    // Invalid closing tags & tags
    expect(() => parseXml("<r></123>")).toThrow(/invalid closing tag/);
    expect(() => parseXml("<r></r!")).toThrow(/invalid closing tag/);
    expect(() => parseXml("</r>")).toThrow(/mismatched closing tag/);
    expect(() => parseXml("<123/>")).toThrow(/invalid tag/);
    expect(() => parseXml('<r a="1" a="2"/>')).toThrow(/duplicate attribute/);
    expect(() => parseXml("<a/><b/>")).toThrow(/multiple root elements/);
    expect(() => parseXml("<r broken")).toThrow(/malformed tag/);

    // Nesting limit, unclosed element at EOF, empty document
    expect(() => parseXml("<a>".repeat(512) + "</a>".repeat(512))).toThrow(/nesting too deep/);
    expect(() => parseXml("<r>")).toThrow(/unclosed element/);
    expect(() => parseXml("")).toThrow(/empty document/);
    expect(() => parseXml("<!-- only comment -->")).toThrow(/empty document/);
  });

  it("covers all ZIP assembly, central directory, deflate/inflate, and readZipEntry error paths", async () => {
    // ZIP64 guard on huge rawSize without allocating 4GB
    let lengthReads = 0;
    const fakeLargeData = Object.defineProperty(new Uint8Array(0), "length", {
      get() {
        lengthReads += 1;
        return lengthReads === 1 ? 0xffffffff : 0;
      },
    });
    expect(() => createZip([{ name: "huge.bin", data: fakeLargeData }])).toThrow(/zip64 is not supported/);

    // Central directory corruption checks
    const valid = createZip([{ name: "a.txt", data: new TextEncoder().encode("hello world") }]);
    const findEocd = (buf: Uint8Array) => {
      const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
      for (let i = buf.length - 22; i >= 0; i--) {
        if (v.getUint32(i, true) === 0x06054b50) return i;
      }
      return -1;
    };
    const eocd = findEocd(valid);
    const cdOffset = new DataView(valid.buffer).getUint32(eocd + 16, true);

    // Configurable maxEntries limit on listZip
    const multi = createZip([
      { name: "a.txt", data: new TextEncoder().encode("1") },
      { name: "b.txt", data: new TextEncoder().encode("2") },
      { name: "c.txt", data: new TextEncoder().encode("3") },
    ]);
    expect(listZip(multi, { maxEntries: 3 })).toHaveLength(3);
    expect(() => listZip(multi, { maxEntries: 2 })).toThrow(/too many zip entries/);
    expect(() => listZip(multi, { maxEntries: 0 })).toThrow(/invalid entry limit/);
    expect(() => listZip(multi, { maxEntries: Number.NaN })).toThrow(/invalid entry limit/);
    const overDefault = valid.slice();
    new DataView(overDefault.buffer).setUint16(eocd + 10, ZIP_DEFAULT_MAX_ENTRIES + 1, true);
    expect(() => listZip(overDefault)).toThrow(/too many zip entries/);

    // Multi-disk checks (disk number & start disk)
    const multiDisk1 = valid.slice();
    new DataView(multiDisk1.buffer).setUint16(eocd + 4, 1, true);
    expect(() => listZip(multiDisk1)).toThrow(/multi-disk zip/);

    const multiDisk2 = valid.slice();
    new DataView(multiDisk2.buffer).setUint16(eocd + 6, 1, true);
    expect(() => listZip(multiDisk2)).toThrow(/multi-disk zip/);

    // Invalid central directory bounds / zip64 sentinels
    const badCdBounds = valid.slice();
    new DataView(badCdBounds.buffer).setUint32(eocd + 12, 99999, true);
    expect(() => listZip(badCdBounds)).toThrow(/invalid central directory/);

    const badCount = valid.slice();
    new DataView(badCount.buffer).setUint16(eocd + 10, 0xffff, true);
    expect(() => listZip(badCount)).toThrow(/invalid central directory/);

    const badOffset = valid.slice();
    new DataView(badOffset.buffer).setUint32(eocd + 16, 0xffffffff, true);
    expect(() => listZip(badOffset)).toThrow(/invalid central directory/);

    // Invalid central directory entry (truncated & bad signature)
    const badCdCount = valid.slice();
    new DataView(badCdCount.buffer).setUint16(eocd + 10, 2, true);
    expect(() => listZip(badCdCount)).toThrow(/invalid central directory entry/);

    const badCdSig = valid.slice();
    badCdSig[cdOffset] = 0;
    expect(() => listZip(badCdSig)).toThrow(/invalid central directory entry/);

    // Invalid entry name length
    const badNameLen = valid.slice();
    new DataView(badNameLen.buffer).setUint16(cdOffset + 28, 9999, true);
    expect(() => listZip(badNameLen)).toThrow(/invalid entry name/);

    // Invalid local header offset
    const badLocalOff = valid.slice();
    new DataView(badLocalOff.buffer).setUint32(cdOffset + 42, valid.length, true);
    expect(() => listZip(badLocalOff)).toThrow(/invalid local header offset/);

    // readZipEntry guards
    const [entry] = listZip(valid);
    await expect(readZipEntry(valid, { ...entry, flags: entry.flags | 1 }, 1024)).rejects.toThrow(/encrypted entry/);
    await expect(readZipEntry(valid, entry, 2)).rejects.toThrow(/entry exceeds size limit/);

    const badLocalSig = valid.slice();
    badLocalSig[0] = 0;
    await expect(readZipEntry(badLocalSig, entry, 1024)).rejects.toThrow(/invalid local header/);

    await expect(readZipEntry(valid, { ...entry, compressedSize: valid.length + 10 }, 1024)).rejects.toThrow(/truncated entry/);
    await expect(readZipEntry(valid, { ...entry, method: 99 }, 1024)).rejects.toThrow(/unsupported compression method 99/);
    await expect(readZipEntry(valid, { ...entry, size: entry.size + 1 }, 1024)).rejects.toThrow(/checksum mismatch/);
    await expect(readZipEntry(valid, { ...entry, crc: (entry.crc ^ 1) >>> 0 }, 1024)).rejects.toThrow(/checksum mismatch/);

    // inflateRaw size limit and corrupt deflate data
    const bigRaw = new TextEncoder().encode("inflate-limit-test-".repeat(50));
    const bigDeflated = await deflateRaw(bigRaw);
    await expect(inflateRaw(bigDeflated, 16)).rejects.toThrow(/entry exceeds size limit/);
    await expect(inflateRaw(new Uint8Array([0xff, 0xff, 0xff, 0xff]), 1024)).rejects.toThrow(/corrupt deflate data/);

    // Missing CompressionStream / DecompressionStream and stream failure catch paths
    const origComp = globalThis.CompressionStream;
    const origDecomp = globalThis.DecompressionStream;
    try {
      (globalThis as unknown as { CompressionStream: unknown }).CompressionStream = undefined;
      await expect(deflateRaw(bigRaw)).rejects.toThrow(/CompressionStream unavailable/);
      const fallbackZip = await createZipAsync([{ name: "a.txt", data: bigRaw }]);
      expect(listZip(fallbackZip)[0].method).toBe(0);

      // Failing CompressionStream (non-ZipError + rejecting cancel, and ZipError rethrow)
      const makeFailingStream = (err: Error) =>
        class {
          writable = new WritableStream({ write() {} });
          readable = new ReadableStream({
            pull(ctrl) {
              ctrl.error(err);
            },
            cancel() {
              return Promise.reject(new Error("cancel failed"));
            },
          });
        };

      (globalThis as unknown as { CompressionStream: unknown }).CompressionStream = makeFailingStream(new Error("boom"));
      await expect(deflateRaw(bigRaw)).rejects.toThrow(/deflate compression failed/);

      (globalThis as unknown as { CompressionStream: unknown }).CompressionStream = makeFailingStream(new ZipError("zip err"));
      await expect(deflateRaw(bigRaw)).rejects.toThrow(/zip err/);

      (globalThis as unknown as { DecompressionStream: unknown }).DecompressionStream = undefined;
      await expect(inflateRaw(bigDeflated, 1024)).rejects.toThrow(/DecompressionStream unavailable/);

      (globalThis as unknown as { DecompressionStream: unknown }).DecompressionStream = makeFailingStream(new Error("bad stream"));
      await expect(inflateRaw(bigDeflated, 1024)).rejects.toThrow(/corrupt deflate data/);
    } finally {
      globalThis.CompressionStream = origComp;
      globalThis.DecompressionStream = origDecomp;
    }
  });
});
