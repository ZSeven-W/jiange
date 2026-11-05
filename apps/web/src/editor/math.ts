/**
 * 自研 LaTeX 子集解析器（无 KaTeX/MathJax 依赖）。
 *
 * 支持：\frac \dfrac \tfrac \binom、^ _（上/下标，含组）、\sqrt[n]{}、
 * 希腊字母、常用运算符/关系符/箭头、\sum\prod\int 等大符号（带上下限）、
 * 函数名（sin/cos/lim…）、\text \mathrm \mathbb、\hat\bar\vec\dot\tilde 重音、
 * \left(\right) 定界符、\, \; \quad 空距、matrix/pmatrix/bmatrix/vmatrix 矩阵、
 * \\ 换行、& 对齐（矩阵列）。输出 AST 供 <MathView/> 渲染。
 */

export type MathNode =
  | { k: "txt"; v: string }
  | { k: "sym"; v: string }
  | { k: "fn"; v: string }
  | { k: "frac"; a: MathNode[]; b: MathNode[] }
  | { k: "binom"; a: MathNode[]; b: MathNode[] }
  | { k: "sup"; v: MathNode[] }
  | { k: "sub"; v: MathNode[] }
  | { k: "sqrt"; v: MathNode[]; r?: MathNode[] }
  | { k: "bigop"; v: string; lo?: MathNode[]; hi?: MathNode[] }
  | { k: "accent"; v: MathNode[]; mark: string }
  | { k: "space"; w: string }
  | { k: "delim"; open: string; close: string; v: MathNode[] }
  | { k: "matrix"; rows: MathNode[][][]; l: string; r: string }
  | { k: "row"; items: MathNode[][] };

// —— 符号表 ——
const SYM: Record<string, string> = {
  // 希腊
  alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ε", varepsilon: "ε", zeta: "ζ", eta: "η", theta: "θ", vartheta: "ϑ",
  iota: "ι", kappa: "κ", lambda: "λ", mu: "μ", nu: "ν", xi: "ξ", pi: "π", varpi: "ϖ", rho: "ρ", varrho: "ϱ", sigma: "σ", varsigma: "ς",
  tau: "τ", upsilon: "υ", phi: "φ", varphi: "ϕ", chi: "χ", psi: "ψ", omega: "ω",
  Gamma: "Γ", Delta: "Δ", Theta: "Θ", Lambda: "Λ", Xi: "Ξ", Pi: "Π", Sigma: "Σ", Upsilon: "Υ", Phi: "Φ", Psi: "Ψ", Omega: "Ω",
  // 运算
  times: "×", div: "÷", cdot: "·", pm: "±", mp: "∓", ast: "∗", star: "⋆", circ: "∘", bullet: "∙", otimes: "⊗", oplus: "⊕", odot: "⊙",
  // 关系
  leq: "≤", geq: "≥", neq: "≠", ne: "≠", approx: "≈", equiv: "≡", sim: "∼", simeq: "≃", cong: "≅", propto: "∝", ll: "≪", gg: "≫", prec: "≺", succ: "≻",
  in: "∈", notin: "∉", ni: "∋", subset: "⊂", supset: "⊃", subseteq: "⊆", supseteq: "⊇", emptyset: "∅", varnothing: "∅",
  // 集合/逻辑
  forall: "∀", exists: "∃", nexists: "∄", neg: "¬", land: "∧", lor: "∨", implies: "⇒", iff: "⇔", therefore: "∴", because: "∵",
  // 微积分
  partial: "∂", nabla: "∇", infty: "∞", hbar: "ℏ", ell: "ℓ", Re: "ℜ", Im: "ℑ", aleph: "ℵ",
  // 箭头
  to: "→", rightarrow: "→", leftarrow: "←", leftrightarrow: "↔", Rightarrow: "⇒", Leftarrow: "⇐", Leftrightarrow: "⇔",
  mapsto: "↦", uparrow: "↑", downarrow: "↓", updownarrow: "↕", longrightarrow: "⟶", longleftarrow: "⟵", longleftrightarrow: "⟷",
  // 杂项
  infty2: "∞", degree: "°", prime: "′", dag: "†", ddag: "‡", S: "§", checkmark: "✓", bullet2: "•",
  perp: "⊥", parallel: "∥", angle: "∠", triangle: "△", square: "□", diamond: "⋄", club: "♣", heart: "♥", spade: "♠",
  lceil: "⌈", rceil: "⌉", lfloor: "⌊", rfloor: "⌋", langle: "⟨", rangle: "⟩", backslash: "\\", ldots: "…", cdots: "⋯", vdots: "⋮", ddots: "⋱",
};

const BIGOPS: Record<string, string> = { sum: "∑", prod: "∏", coprod: "∐", int: "∫", iint: "∬", iiint: "∭", oint: "∮", bigcup: "⋃", bigcap: "⋂", bigoplus: "⨁", bigotimes: "⨂", bigvee: "⋁", bigwedge: "⋀" };

const FUNCS = ["sin", "cos", "tan", "cot", "sec", "csc", "arcsin", "arccos", "arctan", "sinh", "cosh", "tanh", "log", "ln", "lg", "exp", "det", "gcd", "max", "min", "sup", "inf", "deg", "dim", "ker", "Pr", "mod", "bmod", "pmod"];

const ACCENTS: Record<string, string> = { hat: "\u0302", bar: "\u0304", vec: "\u20D7", dot: "\u0307", ddot: "\u0308", tilde: "\u0303", breve: "\u0306", check: "\u030C" };

const BB: Record<string, string> = { R: "ℝ", N: "ℕ", Z: "ℤ", Q: "ℚ", C: "ℂ", P: "ℙ", E: "𝔼", F: "𝔽", H: "ℍ" };

class Cur {
  s: string;
  i = 0;
  /** 解析 \left( 时置位：遇到 \right 停止（由 parseUntilRight 消费闭合符） */
  stopAtRight = false;
  constructor(s: string) {
    this.s = s;
  }
  peek(): string {
    return this.s[this.i] ?? "";
  }
  next(): string {
    return this.s[this.i++] ?? "";
  }
  eat(tok: string): boolean {
    if (this.s.startsWith(tok, this.i)) {
      this.i += tok.length;
      return true;
    }
    return false;
  }
  done(): boolean {
    return this.i >= this.s.length;
  }
}

function readCommand(c: Cur): string {
  let name = "";
  while (/[a-zA-Z]/.test(c.peek())) name += c.next();
  return name;
}

function parseGroup(c: Cur, stopBrace = true): MathNode[] {
  const out: MathNode[] = [];
  while (!c.done()) {
    const ch = c.peek();
    if (ch === "}") {
      if (stopBrace) c.next(); // consume
      return out;
    }
    if (ch === "{") {
      c.next();
      out.push({ k: "row", items: [parseGroup(c)] });
      continue;
    }
    if (ch === "\\") {
      c.next();
      const name = readCommand(c);
      if (!name) {
        // 单字符命令 \, \; \\ \{ \} 等
        const sc = c.next();
        if (sc === "," || sc === ";" || sc === ":") out.push({ k: "space", w: "0.17em" });
        else if (sc === " ") out.push({ k: "space", w: "0.25em" });
        else if (sc === "\\") out.push({ k: "space", w: "100%" }, { k: "txt", v: "\n" });
        else if (sc === "{" || sc === "}") out.push({ k: "txt", v: sc });
        else if (sc) out.push({ k: "sym", v: sc });
        continue;
      }
      if (name === "right") {
        if (c.stopAtRight) {
          c.i -= 6; // 回退 "\right"，交给 parseUntilRight
          return out;
        }
        const d = c.next();
        if (d !== "." && d) out.push({ k: "txt", v: d });
        continue;
      }
      if (name === "left") {
        const d = c.next();
        const node: MathNode = { k: "delim", open: d === "." ? "" : d, close: "", v: [] };
        parseUntilRight(c, node as { close: string; v: MathNode[] });
        out.push(node);
        continue;
      }
      if (name === "begin") {
        const env = readEnv(c);
        out.push(parseEnv(c, env));
        continue;
      }
      if (BIGOPS[name]) {
        c.i; // no-op
        const node: MathNode = { k: "bigop", v: BIGOPS[name] };
        // 上下限（可跟随 _ ^，顺序不限）
        for (let n = 0; n < 2 && !c.done(); n++) {
          const p = c.peek();
          if (p === "_") {
            c.next();
            (node as { lo?: MathNode[] }).lo = parseArg(c);
          } else if (p === "^") {
            c.next();
            (node as { hi?: MathNode[] }).hi = parseArg(c);
          } else break;
        }
        out.push(node);
        continue;
      }
      if (name === "frac" || name === "dfrac" || name === "tfrac") {
        const a = parseArg(c);
        const b = parseArg(c);
        out.push({ k: "frac", a, b });
        continue;
      }
      if (name === "binom") {
        const a = parseArg(c);
        const b = parseArg(c);
        out.push({ k: "binom", a, b });
        continue;
      }
      if (name === "sqrt") {
        let r: MathNode[] | undefined;
        if (c.peek() === "[") {
          c.next();
          const src = c.s.slice(c.i, c.s.indexOf("]", c.i));
          c.i = c.s.indexOf("]", c.i) + 1;
          r = parseMath(src);
        }
        const v = parseArg(c);
        out.push({ k: "sqrt", v, r });
        continue;
      }
      if (ACCENTS[name]) {
        const v = parseArg(c);
        out.push({ k: "accent", v, mark: ACCENTS[name] });
        continue;
      }
      if (name === "text" || name === "mathrm" || name === "operatorname" || name === "mbox") {
        const src = readBraceRaw(c);
        out.push({ k: "txt", v: src });
        continue;
      }
      if (name === "mathbb") {
        const src = readBraceRaw(c);
        out.push({ k: "txt", v: [...src].map((x) => BB[x] ?? x).join("") });
        continue;
      }
      if (name === "mathbf" || name === "bm" || name === "boldsymbol" || name === "mathit" || name === "mathcal" || name === "mathfrak") {
        out.push({ k: "row", items: [parseArg(c)] });
        continue;
      }
      if (name === "quad" || name === "qquad") {
        out.push({ k: "space", w: name === "quad" ? "1em" : "2em" });
        continue;
      }
      if (FUNCS.includes(name)) {
        out.push({ k: "fn", v: name === "bmod" || name === "pmod" ? "mod" : name });
        if (name === "pmod") {
          // \pmod{n} → (mod n)
          out.push({ k: "txt", v: " (mod " });
          if (c.peek() === "{") out.push({ k: "row", items: [parseArg(c)] });
          out.push({ k: "txt", v: ")" });
        }
        continue;
      }
      if (SYM[name]) {
        out.push({ k: "sym", v: SYM[name] });
        continue;
      }
      out.push({ k: "txt", v: `\\${name}` }); // 未知命令原样展示
      continue;
    }
    if (ch === "^" || ch === "_") {
      c.next();
      const arg = parseArg(c);
      out.push(ch === "^" ? { k: "sup", v: arg } : { k: "sub", v: arg });
      continue;
    }
    if (ch === " ") {
      c.next();
      out.push({ k: "space", w: "0.25em" });
      continue;
    }
    out.push({ k: "txt", v: c.next() });
  }
  return out;
}

/** 解析到 \right 为止，把结果与闭合符写回 host（host 即 \left 建的 delim）。 */
function parseUntilRight(c: Cur, host: { close: string; v: MathNode[] }): void {
  const prev = c.stopAtRight;
  c.stopAtRight = true;
  const inner: MathNode[] = [];
  while (!c.done()) {
    if (c.peek() === "\\" && c.s.startsWith("\\right", c.i)) {
      c.i += 6;
      const close = c.next();
      host.v = inner;
      host.close = close === "." ? "" : close;
      c.stopAtRight = prev;
      return;
    }
    const save = c.i;
    const step = parseGroup(c, false);
    if (c.i === save) {
      c.next(); // 防御：避免死循环
      continue;
    }
    inner.push(...step);
  }
  host.v = inner;
  c.stopAtRight = prev;
}

function parseArg(c: Cur): MathNode[] {
  if (c.peek() === "{") {
    c.next();
    return parseGroup(c);
  }
  if (c.peek() === "\\") {
    const save = c.i;
    c.next();
    const name = readCommand(c);
    if (name && (SYM[name] || BIGOPS[name] || FUNCS.includes(name) || ACCENTS[name])) {
      c.i = save; // 命令作为整体参数重新解析
      return parseGroup(c, false).slice(0, 1);
    }
    c.i = save;
    return parseGroup(c, false).slice(0, 1); // 单 token
  }
  const ch = c.next();
  if (!ch) return [];
  return [{ k: "txt", v: ch }];
}

function readBraceRaw(c: Cur): string {
  if (c.peek() !== "{") return c.next();
  c.next();
  let depth = 1;
  let out = "";
  while (!c.done() && depth > 0) {
    const ch = c.next();
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) break;
    }
    out += ch;
  }
  return out;
}

function readEnv(c: Cur): string {
  // \begin{matrix}
  const raw = readBraceRaw(c);
  return raw;
}

function parseEnv(c: Cur, env: string): MathNode {
  // 读到 \end{env}，按 \\ 分行、& 分列
  const endTok = `\\end{${env}}`;
  const endIdx = c.s.indexOf(endTok, c.i);
  const body = c.s.slice(c.i, endIdx < 0 ? c.s.length : endIdx);
  c.i = endIdx < 0 ? c.s.length : endIdx + endTok.length;
  const rows: MathNode[][][] = body
    .split("\\\\")
    .map((row) => row.split("&").map((cell) => parseMath(cell)));
  const l = env === "pmatrix" ? "(" : env === "bmatrix" ? "[" : env === "vmatrix" ? "|" : env === "Bmatrix" ? "{" : "";
  const r = env === "pmatrix" ? ")" : env === "bmatrix" ? "]" : env === "vmatrix" ? "|" : env === "Bmatrix" ? "}" : "";
  return { k: "matrix", rows, l, r };
}

/** 解析一段 LaTeX 源码为 AST（幂等：多余空白忽略）。 */
export function parseMath(src: string): MathNode[] {
  const c = new Cur(src);
  return parseGroup(c, false);
}
