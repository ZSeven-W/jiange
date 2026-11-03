/**
 * Minimal fractional indexing over base-62 digits (keys read as fractions
 * 0.d1d2d3...). Keys compare with plain byte-wise string comparison, which is
 * exactly what the Go side does. Generated keys never end in "0".
 */
const DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const BASE = DIGITS.length;

function mid(a: string, b: string): string {
  // invariant: a < b; b === "" means 1.0
  if (b !== "") {
    let n = 0;
    while ((a[n] ?? "0") === b[n]) n++;
    if (n > 0) return b.slice(0, n) + mid(a.slice(n), b.slice(n));
  }
  const da = a ? DIGITS.indexOf(a[0]) : 0;
  const db = b ? DIGITS.indexOf(b[0]) : BASE;
  if (db - da > 1) return DIGITS[Math.round((da + db) / 2)];
  if (b.length > 1) return b[0];
  return DIGITS[da] + mid(a.slice(1), "");
}

/** Returns a key strictly between a and b ("" means unbounded on that side). */
export function keyBetween(a: string, b: string): string {
  if (a !== "" && b !== "" && a >= b) throw new Error(`keyBetween: ${a} >= ${b}`);
  return mid(a, b);
}
