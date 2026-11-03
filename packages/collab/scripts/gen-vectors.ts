import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { buildScenarios, Doc, encodeClientMsg, encodeOps, encodeServerMsg, toHex } from "../src/index";

const dir = resolve(dirname(fileURLToPath(import.meta.url)), "../../../spec/vectors");
const scenarios = buildScenarios();
writeFileSync(resolve(dir, "scenarios.json"), JSON.stringify(scenarios, null, 1) + "\n");
const encoding = scenarios.map((s) => ({ name: s.name, ops: s.ops, hex: toHex(encodeOps(s.ops)) }));
writeFileSync(resolve(dir, "encoding.json"), JSON.stringify(encoding, null, 1) + "\n");
const state = scenarios.map((s) => {
  const d = new Doc(1);
  for (const op of s.ops) d.apply(op);
  return { name: s.name, hex: toHex(d.encodeState()) };
});
writeFileSync(resolve(dir, "state.json"), JSON.stringify(state, null, 1) + "\n");
const batch = encodeOps(scenarios[0].ops);
const messages = [
  { dir: "c2s", msg: { type: "hello", docId: 42, clientId: 7, lastSeq: 300 }, hex: toHex(encodeClientMsg({ type: "hello", docId: 42, clientId: 7, lastSeq: 300 })) },
  { dir: "c2s", msg: { type: "ops", batchHex: toHex(batch) }, hex: toHex(encodeClientMsg({ type: "ops", batch })) },
  { dir: "c2s", msg: { type: "ack", seq: 129 }, hex: toHex(encodeClientMsg({ type: "ack", seq: 129 })) },
  { dir: "c2s", msg: { type: "aware", state: '{"name":"飞"}' }, hex: toHex(encodeClientMsg({ type: "aware", state: '{"name":"飞"}' })) },
  { dir: "s2c", msg: { type: "welcome", clientId: 7, headSeq: 9, snapshot: null }, hex: toHex(encodeServerMsg({ type: "welcome", clientId: 7, headSeq: 9, snapshot: null })) },
  { dir: "s2c", msg: { type: "welcome", clientId: 7, headSeq: 9, snapSeq: 5, stateHex: state[0].hex }, hex: toHex(encodeServerMsg({ type: "welcome", clientId: 7, headSeq: 9, snapshot: { seq: 5, state: Uint8Array.from(Buffer.from(state[0].hex, "hex")) } })) },
  { dir: "s2c", msg: { type: "ops", firstSeq: 10, batchHex: toHex(batch) }, hex: toHex(encodeServerMsg({ type: "ops", firstSeq: 10, batch })) },
  { dir: "s2c", msg: { type: "ack", firstSeq: 11, count: 3 }, hex: toHex(encodeServerMsg({ type: "ack", firstSeq: 11, count: 3 })) },
  { dir: "s2c", msg: { type: "aware", clientId: 3, state: "" }, hex: toHex(encodeServerMsg({ type: "aware", clientId: 3, state: "" })) },
  { dir: "s2c", msg: { type: "error", code: "rejected", message: "bad op" }, hex: toHex(encodeServerMsg({ type: "error", code: "rejected", message: "bad op" })) },
];
writeFileSync(resolve(dir, "messages.json"), JSON.stringify(messages, null, 1) + "\n");
console.log(`wrote ${scenarios.length} scenarios to ${dir}`);
