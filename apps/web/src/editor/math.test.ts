import { describe, expect, it } from "vitest";
import { parseMath } from "./math";
import { parseMarkdown, toMarkdown } from "@/lib/markdown";

const kinds = (src: string) => parseMath(src).map((n) => n.k);

describe("LaTeX subset parser", () => {
  it("plain text and symbols", () => {
    expect(parseMath("x+y")).toHaveLength(3);
    expect(kinds("\\alpha + \\times")).toEqual(["sym", "space", "txt", "space", "sym"]);
    expect((parseMath("\\alpha")[0] as { v: string }).v).toBe("α");
    expect((parseMath("\\leq")[0] as { v: string }).v).toBe("≤");
  });

  it("fractions nest groups", () => {
    const n = parseMath("\\frac{a+1}{b}");
    expect(n[0].k).toBe("frac");
    const frac = n[0] as { a: unknown[]; b: unknown[] };
    expect(frac.a).toHaveLength(3); // a + 1
    expect(frac.b).toHaveLength(1);
    // 嵌套 \frac{\frac{1}{2}}{3}
    const nested = parseMath("\\frac{\\frac{1}{2}}{3}")[0] as { a: { k: string }[] };
    expect(nested.a[0].k).toBe("frac");
  });

  it("sup/sub with groups and primes", () => {
    expect(parseMath("x^{2n}")[1].k).toBe("sup");
    expect(parseMath("a_i")[1].k).toBe("sub");
    expect(kinds("x^2_3")).toEqual(["txt", "sup", "sub"]);
  });

  it("sqrt with optional index", () => {
    expect(parseMath("\\sqrt{x}")[0].k).toBe("sqrt");
    const withIdx = parseMath("\\sqrt[3]{x}")[0] as { r?: unknown[] };
    expect(withIdx.r).toBeDefined();
  });

  it("big operators carry limits", () => {
    const n = parseMath("\\sum_{i=1}^{n} i")[0] as { k: string; lo?: unknown[]; hi?: unknown[] };
    expect(n.k).toBe("bigop");
    expect(n.lo).toBeDefined();
    expect(n.hi).toBeDefined();
    expect((parseMath("\\int_0^1")[0] as { v: string }).v).toBe("∫");
  });

  it("functions render upright, accents attach", () => {
    expect((parseMath("\\sin x")[0] as { v: string }).v).toBe("sin");
    expect(parseMath("\\hat{x}")[0].k).toBe("accent");
  });

  it("delimiters pair via \\left \\right", () => {
    const n = parseMath("\\left(\\frac{a}{b}\\right)")[0] as { k: string; open: string; close: string };
    expect(n.k).toBe("delim");
    expect(n.open).toBe("(");
    expect(n.close).toBe(")");
  });

  it("matrices split rows and columns", () => {
    const m = parseMath("\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}")[0] as { k: string; rows: unknown[][]; l: string };
    expect(m.k).toBe("matrix");
    expect(m.rows).toHaveLength(2);
    expect(m.rows[0]).toHaveLength(2);
    expect(m.l).toBe("(");
  });

  it("mathbb and text", () => {
    expect((parseMath("\\mathbb{R}")[0] as { v: string }).v).toBe("ℝ");
    expect((parseMath("\\text{且}")[0] as { v: string }).v).toBe("且");
  });
});

describe("markdown $$ round-trip", () => {
  it("single-line and multi-line math blocks", () => {
    const md = "$$x^2+y^2=z^2$$\n\n正文\n\n$$\n\\\\frac{a}{b} = c\n$$\n";
    const blocks = parseMarkdown(md).filter((b) => b.type === "math");
    expect(blocks.map((b) => b.text)).toEqual(["x^2+y^2=z^2", "\\\\frac{a}{b} = c"]);
    const out = toMarkdown(parseMarkdown(md));
    expect(toMarkdown(parseMarkdown(out))).toBe(out); // 幂等
    expect(out).toContain("$$x^2+y^2=z^2$$");
  });
});
