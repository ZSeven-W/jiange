import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { buildScenarios, encodeOps, toHex } from "../src/index";

const dir = resolve(dirname(fileURLToPath(import.meta.url)), "../../../spec/vectors");
const scenarios = buildScenarios();
writeFileSync(resolve(dir, "scenarios.json"), JSON.stringify(scenarios, null, 1) + "\n");
const encoding = scenarios.map((s) => ({ name: s.name, ops: s.ops, hex: toHex(encodeOps(s.ops)) }));
writeFileSync(resolve(dir, "encoding.json"), JSON.stringify(encoding, null, 1) + "\n");
console.log(`wrote ${scenarios.length} scenarios to ${dir}`);
