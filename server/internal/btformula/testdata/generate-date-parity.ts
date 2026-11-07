// Regenerate with: packages/collab/node_modules/.bin/tsx server/internal/btformula/testdata/generate-date-parity.ts
// Execute the real frontend formula engine in multiple time zones. This is a
// fixed corpus, not a claim that all browser-specific date strings match.
import { evalFormula } from "../../../../apps/web/src/pages/base/formula";

const zones = ["UTC", "Asia/Shanghai", "America/New_York", "Pacific/Apia", "Europe/London"];
const values = [
  "0001-01-01", "0000-01-01", "2026", "2026-02", "2026-02-30", "2024-02-29",
  "2026-01-01T00:00", "2026-01-01T23:59:59.123", "2024-03-10T02:30", "2024-11-03T01:30",
  "2011-12-30T12:00", "2026-02-01T24:00", "2026-02-01T01:02:03.1234Z",
  "2026-02-01t01:02:03.1z", "2026-02-01T00:30+08:00", "2026-02-01T00:30-05:30",
  "+010000-01-01", "-000001-01-01", "+275760-09-13", "-271821-04-20",
  "2026-02-01T24:01", "2026-13-01", "2026-00-01", "2026-01-00", "2026-01-32",
];

// Deterministic dates in the common timezone-data range, covering omitted
// components, local timestamps and numeric offsets without relying on today.
let seed = 0x26a11;
const next = (limit: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % limit; };
const two = (n: number) => String(n).padStart(2, "0");
for (let i = 0; i < 96; i++) {
  const year = 1971 + next(67), month = 1 + next(12), day = 1 + next(31);
  const hour = next(24), minute = next(60), second = next(60);
  const date = `${year}-${two(month)}-${two(day)}`;
  const zone = ["", "Z", "+05:30", "-07:00"][i % 4];
  values.push(i % 8 === 0 ? date.slice(0, 4) : i % 8 === 1 ? date.slice(0, 7) : i % 8 === 2 ? date : `${date}T${two(hour)}:${two(minute)}:${two(second)}.123${zone}`);
}

const vectors = [];
for (const zone of zones) {
  process.env.TZ = zone;
  for (const value of values) {
    for (const fn of ["YEAR", "MONTH", "DAY"]) {
      const expression = `${fn}(${JSON.stringify(value)})`;
      const result = evalFormula(expression);
      vectors.push(Number.isFinite(result) ? { zone, expression, result } : { zone, expression, unsupported: true });
    }
  }
}
process.stdout.write(JSON.stringify(vectors, null, 2) + "\n");
