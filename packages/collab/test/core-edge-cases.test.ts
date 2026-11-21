import { describe, expect, it } from "vitest";
import { Doc, STATE_TAG } from "../src/doc.js";
import { MAGIC, Reader, TAG, VERSION, Writer, decodeOps, encodeOps, readOp } from "../src/encoding.js";
import { keyBetween } from "../src/fracindex.js";
import { ROOT } from "../src/id.js";
import { MSG, decodeClientMsg, decodeServerMsg, encodeClientMsg, encodeServerMsg } from "../src/protocol.js";
import { Tx, applyMarks, indexAfter } from "../src/tx.js";

describe("fracindex edge cases", () => {
  it("throws when lower bound is greater than or equal to upper bound", () => {
    expect(() => keyBetween("b", "a")).toThrow("keyBetween: b >= a");
    expect(() => keyBetween("a", "a")).toThrow("keyBetween: a >= a");
  });
});

describe("encoding edge cases", () => {
  it("validates varint encoding/decoding, bounds, sides, flags, op tags, version, and trailing bytes", () => {
    const w = new Writer();
    expect(() => w.uvar(-1)).toThrow(RangeError);
    expect(() => w.uvar(1.5)).toThrow(RangeError);
    expect(() => w.uvar(Number.MAX_SAFE_INTEGER + 1)).toThrow(RangeError);

    // 8 continuation bytes -> varint too long
    const longVarint = new Uint8Array([0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80]);
    expect(() => new Reader(longVarint).uvar()).toThrow("varint too long");

    // Truncated string & blob
    const truncStr = new Writer();
    truncStr.uvar(5);
    truncStr.u8(0x41);
    expect(() => new Reader(truncStr.bytes()).str()).toThrow("unexpected end of input");

    const truncBlob = new Writer();
    truncBlob.uvar(4);
    truncBlob.u8(1);
    expect(() => new Reader(truncBlob.bytes()).blob()).toThrow("unexpected end of input");

    // Invalid side in tins op
    const badSide = new Writer();
    badSide.u8(TAG.tins);
    badSide.id({ client: 1, clock: 2 });
    badSide.id({ client: 1, clock: 1 });
    badSide.id(ROOT);
    badSide.u8(2); // invalid side
    badSide.str("a");
    expect(() => readOp(new Reader(badSide.bytes()))).toThrow("bad side 2");

    // Invalid value flag in mark op
    const badMarkFlag = new Writer();
    badMarkFlag.u8(TAG.mark);
    badMarkFlag.id({ client: 1, clock: 3 });
    badMarkFlag.id({ client: 1, clock: 1 });
    badMarkFlag.str("bold");
    badMarkFlag.u8(2); // invalid has flag (> 1)
    expect(() => readOp(new Reader(badMarkFlag.bytes()))).toThrow("bad value flag");

    // Unknown op tag
    const badTag = new Writer();
    badTag.u8(99);
    badTag.id({ client: 1, clock: 1 });
    expect(() => readOp(new Reader(badTag.bytes()))).toThrow("unknown op tag 99");

    // Unsupported version in decodeOps
    expect(() => decodeOps(new Uint8Array([MAGIC, VERSION + 1, 0]))).toThrow(`unsupported version ${VERSION + 1}`);

    // Trailing bytes in decodeOps
    const valid = encodeOps([]);
    const trailing = new Uint8Array(valid.length + 1);
    trailing.set(valid);
    trailing[valid.length] = 0x00;
    expect(() => decodeOps(trailing)).toThrow("trailing bytes");
  });
});

describe("protocol edge cases", () => {
  it("round-trips awareness messages and rejects unknown tags, bad sync mode, and trailing bytes", () => {
    const cAware = encodeClientMsg({ type: "aware", state: '{"caret":1}' });
    expect(decodeClientMsg(cAware)).toEqual({ type: "aware", state: '{"caret":1}' });

    const sAware = encodeServerMsg({ type: "aware", clientId: 7, state: '{"caret":2}' });
    expect(decodeServerMsg(sAware)).toEqual({ type: "aware", clientId: 7, state: '{"caret":2}' });

    // Unknown message types
    expect(() => decodeClientMsg(new Uint8Array([0xff]))).toThrow("unknown client message");
    expect(() => decodeServerMsg(new Uint8Array([0xff]))).toThrow("unknown server message");

    // Trailing bytes on client and server messages
    const cAck = encodeClientMsg({ type: "ack", seq: 3 });
    expect(() => decodeClientMsg(new Uint8Array([...cAck, 0x00]))).toThrow("trailing bytes");

    const sAck = encodeServerMsg({ type: "ack", firstSeq: 1, count: 1 });
    expect(() => decodeServerMsg(new Uint8Array([...sAck, 0x00]))).toThrow("trailing bytes");

    // Welcome with invalid sync mode byte (2)
    const badMode = new Writer();
    badMode.u8(MSG.welcome);
    badMode.uvar(1); // clientId
    badMode.uvar(0); // headSeq
    badMode.u8(0); // no snapshot
    badMode.uvar(1); // historyEpoch
    badMode.u8(2); // invalid mode
    expect(() => decodeServerMsg(badMode.bytes())).toThrow("invalid sync mode");
  });
});

describe("doc edge cases", () => {
  it("validates constructor, block access, text/format bounds, anchors, metadata getters, and dropPending", () => {
    expect(() => new Doc(0)).toThrow("client id must be a positive integer");
    expect(() => new Doc(-5)).toThrow("client id must be a positive integer");
    expect(() => new Doc(1.5)).toThrow("client id must be a positive integer");

    const doc = new Doc(1);
    const b = doc.createBlock("paragraph");
    expect(doc.deletedBlockType(b.id)).toBeNull();
    expect(doc.deletedBlockType({ client: 9, clock: 9 })).toBeNull();

    // blockLocation & propVersion return detached copies
    const loc = doc.blockLocation(b.id);
    expect(loc.parent).toEqual(ROOT);
    expect(loc.version).toEqual(b.id);
    loc.parent.client = 999;
    expect(doc.blockLocation(b.id).parent).toEqual(ROOT);

    const typeVer = doc.propVersion(b.id, "type");
    expect(typeVer).toEqual(b.id);
    typeVer!.clock = 999;
    expect(doc.propVersion(b.id, "type")).toEqual(b.id);
    expect(doc.propVersion(b.id, "missing")).toBeNull();

    // insertText empty & out of range
    expect(doc.insertText(b.id, 0, "")).toBeNull();
    expect(() => doc.insertText(b.id, -1, "a")).toThrow("index out of range");
    expect(() => doc.insertText(b.id, 1, "a")).toThrow("index out of range");

    doc.insertText(b.id, 0, "ab");

    // format out-of-range / empty returns null
    expect(doc.format(b.id, 1, 1, "bold", "1")).toBeNull();
    expect(doc.format(b.id, -1, 1, "bold", "1")).toBeNull();
    expect(doc.format(b.id, 0, 5, "bold", "1")).toBeNull();

    // resolveAnchor on unknown block and unknown char
    expect(doc.resolveAnchor({ client: 9, clock: 9 }, { char: ROOT, side: 1 })).toBe(0);
    expect(doc.resolveAnchor(b.id, { char: { client: 9, clock: 9 }, side: 1 })).toBe(2);

    // byteCmp with prefix-equal prop keys ("a" vs "ab") during encodeState
    doc.setProp(b.id, "ab", "2");
    doc.setProp(b.id, "a", "1");
    const encoded = doc.encodeState();
    const restored = Doc.fromState(2, encoded);
    expect(restored.blockInfo(b.id).props).toEqual({ a: "1", ab: "2" });

    // dropPending clears buffered causally unready ops
    expect(doc.dropPending()).toBe(0);
    doc.apply({ t: "bset", id: { client: 2, clock: 10 }, block: { client: 2, clock: 9 }, key: "k", value: "v" });
    expect(doc.pendingCount).toBe(1);
    expect(doc.dropPending()).toBe(1);
    expect(doc.pendingCount).toBe(0);

    // Deleting block makes text() throw and deletedBlockType() return its type
    doc.deleteBlock(b.id);
    expect(() => doc.text(b.id)).toThrow("unknown block");
    expect(() => doc.text({ client: 9, clock: 9 })).toThrow("unknown block");
    expect(doc.deletedBlockType(b.id)).toBe("paragraph");
  });

  it("validates corrupt or malformed state blobs in Doc.fromState and handles typeless blocks", () => {
    // Bad magic / bad state tag
    expect(() => Doc.fromState(1, new Uint8Array([0x00, STATE_TAG, 1]))).toThrow("not a state blob");
    expect(() => Doc.fromState(1, new Uint8Array([MAGIC, 0x00, 1]))).toThrow("not a state blob");

    // Unsupported state version
    expect(() => Doc.fromState(1, new Uint8Array([MAGIC, STATE_TAG, 3]))).toThrow("unsupported state version 3");

    // Clock exceeding Number.MAX_SAFE_INTEGER (0x20 * 2^49 = 2^54)
    const unsafeClock = new Uint8Array([MAGIC, STATE_TAG, 1, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x20, 0]);
    expect(() => Doc.fromState(1, unsafeClock)).toThrow("state clock exceeds safe integer range");

    // Helper to build minimal raw state blob with 1 block
    const writeSingleBlockHeader = (w: Writer, stateVersion: number, deleted = 0, propCount = 0) => {
      w.u8(MAGIC);
      w.u8(STATE_TAG);
      w.u8(stateVersion);
      w.uvar(5); // clock
      w.uvar(1); // 1 block
      w.id({ client: 1, clock: 1 }); // block id
      w.id(ROOT); // parent
      w.str("a"); // pos
      w.id({ client: 1, clock: 1 }); // loc ts
      w.u8(deleted);
      w.uvar(propCount);
    };

    // Corrupt char side (side = 2)
    const badSide = new Writer();
    writeSingleBlockHeader(badSide, 1);
    badSide.uvar(1); // 1 char
    badSide.id({ client: 1, clock: 2 });
    badSide.u8(2); // invalid side
    badSide.uvar(0); // pi
    badSide.u8(0);
    badSide.str("x");
    badSide.uvar(0); // 0 marks
    expect(() => Doc.fromState(1, badSide.bytes())).toThrow("corrupt state");

    // Corrupt char parent index (pi >= list.length)
    const badParent = new Writer();
    writeSingleBlockHeader(badParent, 1);
    badParent.uvar(1);
    badParent.id({ client: 1, clock: 2 });
    badParent.u8(1);
    badParent.uvar(9); // out of bounds parent index
    badParent.u8(0);
    badParent.str("x");
    badParent.uvar(0);
    expect(() => Doc.fromState(1, badParent.bytes())).toThrow("corrupt state");

    // v2 state with table payload for unknown block
    const badTableBlock = new Writer();
    writeSingleBlockHeader(badTableBlock, 2);
    badTableBlock.uvar(0); // 0 chars
    badTableBlock.uvar(0); // 0 marks
    badTableBlock.uvar(1); // 1 table entry
    badTableBlock.id({ client: 9, clock: 9 }); // unknown block id
    badTableBlock.uvar(1);
    badTableBlock.blob(new Uint8Array([1]));
    expect(() => Doc.fromState(1, badTableBlock.bytes())).toThrow("table payloads for unknown block 9:9");

    // Trailing bytes in state
    const valid = new Doc(1).encodeState();
    expect(() => Doc.fromState(1, new Uint8Array([...valid, 0x00]))).toThrow("trailing bytes in state");

    // Block with 0 props (missing "type" prop): exercises fallback "" in blockInfo, view, deletedBlockType, compactAtBarrier
    const noType = new Writer();
    writeSingleBlockHeader(noType, 1, 0, 0);
    noType.uvar(0);
    noType.uvar(0);
    const typelessDoc = Doc.fromState(1, noType.bytes());
    const bid = { client: 1, clock: 1 };
    expect(typelessDoc.blockInfo(bid).type).toBe("");
    expect(typelessDoc.view().blocks[0].type).toBe("");
    typelessDoc.deleteBlock(bid);
    expect(typelessDoc.deletedBlockType(bid)).toBe("");
    expect(typelessDoc.compactAtBarrier(typelessDoc.lamport)).toBe(0);
  });

  it("compacts deleted blocks (stripping props/marks) and left-side (side=0) leaf tombstones", () => {
    const doc = new Doc(1);
    // Live block with left-side (side === 0) deleted char:
    // insert "ab" -> 'a' is right child of root, 'b' is right child of 'a'
    // insert "x" at index 1 -> 'a'.right is non-empty, so 'x' attaches as left child (side=0) of 'b'
    const live = doc.createBlock("paragraph");
    doc.insertText(live.id, 0, "ab");
    doc.insertText(live.id, 1, "x");
    doc.deleteText(live.id, 1, 1);

    // Deleted block with extra props, marks, and deleted chars
    const delBlock = doc.createBlock("heading");
    doc.setProp(delBlock.id, "level", "2");
    doc.insertText(delBlock.id, 0, "hi");
    doc.format(delBlock.id, 0, 2, "bold", "1");
    doc.deleteText(delBlock.id, 0, 2);
    doc.deleteBlock(delBlock.id);

    const removed = doc.compactAtBarrier(doc.lamport);
    expect(removed).toBe(3); // 'x' (side=0) + 'h' + 'i' (marks cleared on deleted block)
    expect(doc.text(live.id)).toBe("ab");
    expect(doc.deletedBlockType(delBlock.id)).toBe("heading");
  });
});

describe("tx edge cases", () => {
  it("covers indexAfter fallback, applyMarks, insert with marks, no-op guards, create props, and move guards", () => {
    const doc = new Doc(1);
    const tx = new Tx(doc);

    // create with both non-empty and empty prop values
    const b1 = tx.create("paragraph", null, ROOT, { level: "1", skipped: "" });
    const b2 = tx.create("paragraph", b1, ROOT);
    expect(doc.blockInfo(b1).props).toEqual({ level: "1" });

    // indexAfter with unknown/deleted sibling returns kids.length
    expect(indexAfter(doc, ROOT, { client: 99, clock: 99 })).toBe(2);

    // insert empty returns 0
    expect(tx.insert(b1, 0, "")).toBe(0);

    // insert with single mark object and with per-char marks array
    expect(tx.insert(b1, 0, "ab", { bold: "1" })).toBe(2);
    expect(tx.insert(b1, 2, "cd", [{ italic: "1" }, {}])).toBe(2);
    expect(doc.richChars(b1)).toEqual([
      { ch: "a", marks: { bold: "1" } },
      { ch: "b", marks: { bold: "1" } },
      { ch: "c", marks: { italic: "1" } },
      { ch: "d", marks: {} },
    ]);

    // applyMarks directly (including gaps, adjacent equal values, multiple keys, and out-of-range null op)
    doc.insertText(b2, 0, "xyz");
    const markOps = applyMarks(doc, b2, 0, [{ bold: "1" }, { bold: "1", italic: "1" }, {}]);
    expect(markOps.length).toBe(2);
    expect(doc.richChars(b2)).toEqual([
      { ch: "x", marks: { bold: "1" } },
      { ch: "y", marks: { bold: "1", italic: "1" } },
      { ch: "z", marks: {} },
    ]);
    // Out of range `from` causes doc.format to return null inside applyMarks
    expect(applyMarks(doc, b2, 99, [{ bold: "1" }])).toEqual([]);

    // No-op guards in delete, format, setProp, move
    const itemsBefore = tx.items.length;
    tx.delete(b1, 2, 2);
    tx.delete(b1, 3, 1);
    tx.format(b1, 1, 1, "bold", "1");
    tx.format(b1, 0, 2, "bold", "1"); // already bold "1"
    tx.setProp(b1, "type", "paragraph"); // already paragraph
    tx.setProp(b1, "missing", "", ""); // matches fallback
    tx.move(b1, null, ROOT); // already first under ROOT (from.after === after === null)
    tx.move(b2, { client: b1.client, clock: b1.clock }, ROOT); // already right after b1 (eqId match)
    tx.move(b2, b2, ROOT); // moving after itself
    expect(tx.items.length).toBe(itemsBefore);
  });
});
