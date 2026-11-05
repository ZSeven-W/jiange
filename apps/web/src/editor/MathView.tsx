import { Fragment, type ReactNode } from "react";
import { parseMath, type MathNode } from "./math";

/** 渲染 LaTeX 子集 AST 为排版视图（分数堆叠/上下标/根号/大符号/矩阵）。 */
export function MathView({ src }: { src: string }) {
  const nodes = parseMath(src);
  return <span className="jiange-math">{nodes.map((n, i) => <MathNodeView key={i} n={n} />)}</span>;
}

function MathNodeView({ n }: { n: MathNode }): ReactNode {
  switch (n.k) {
    case "txt":
      if (n.v === "\n") return <br />;
      return <Fragment>{n.v}</Fragment>;
    case "sym":
    case "fn":
      return <span className={n.k === "fn" ? "mr-[1px] font-normal not-italic" : "mx-[1px]"}>{n.k === "fn" ? n.v : n.v}</span>;
    case "space":
      return <span style={{ display: "inline-block", width: n.w }} />;
    case "row":
      return (
        <span>
          {n.items.map((g, i) => (
            <Fragment key={i}>{g.map((m, j) => <MathNodeView key={j} n={m} />)}</Fragment>
          ))}
        </span>
      );
    case "frac":
      return (
        <span className="inline-flex flex-col items-center align-middle text-[0.95em] leading-tight">
          <span className="px-1 pb-0.5">{n.a.map((m, i) => <MathNodeView key={i} n={m} />)}</span>
          <span className="h-px w-full bg-current" />
          <span className="px-1 pt-0.5">{n.b.map((m, i) => <MathNodeView key={i} n={m} />)}</span>
        </span>
      );
    case "binom":
      return (
        <span className="inline-flex items-center align-middle text-[0.95em]">
          <span className="text-[1.5em] font-light leading-none">(</span>
          <span className="inline-flex flex-col items-center px-0.5 leading-tight">
            <span>{n.a.map((m, i) => <MathNodeView key={i} n={m} />)}</span>
            <span>{n.b.map((m, i) => <MathNodeView key={i} n={m} />)}</span>
          </span>
          <span className="text-[1.5em] font-light leading-none">)</span>
        </span>
      );
    case "sup":
      return (
        <sup className="text-[0.72em]">
          {n.v.map((m, i) => <MathNodeView key={i} n={m} />)}
        </sup>
      );
    case "sub":
      return (
        <sub className="text-[0.72em]">
          {n.v.map((m, i) => <MathNodeView key={i} n={m} />)}
        </sub>
      );
    case "sqrt":
      return (
        <span className="inline-flex items-start align-middle">
          {n.r && <sup className="mr-[-2px] text-[0.6em]">{n.r.map((m, i) => <MathNodeView key={i} n={m} />)}</sup>}
          <span className="text-[1.1em] leading-none">√</span>
          <span className="border-t border-current px-0.5">{n.v.map((m, i) => <MathNodeView key={i} n={m} />)}</span>
        </span>
      );
    case "bigop":
      return (
        <span className="inline-flex flex-col items-center align-middle leading-none">
          {n.hi && <span className="text-[0.65em]">{n.hi.map((m, i) => <MathNodeView key={i} n={m} />)}</span>}
          <span className="text-[1.5em]">{n.v}</span>
          {n.lo && <span className="text-[0.65em]">{n.lo.map((m, i) => <MathNodeView key={i} n={m} />)}</span>}
        </span>
      );
    case "accent":
      return (
        <span>
          {n.v.map((m, i) => <MathNodeView key={i} n={m} />)}
          {n.mark}
        </span>
      );
    case "delim":
      return (
        <span className="inline-flex items-center">
          {n.open && <span className="text-[1.2em] leading-none">{n.open}</span>}
          <span className="px-0.5">{n.v.map((m, i) => <MathNodeView key={i} n={m} />)}</span>
          {n.close && <span className="text-[1.2em] leading-none">{n.close}</span>}
        </span>
      );
    case "matrix":
      return (
        <span className="inline-flex items-center">
          {n.l && <span className="text-[1.6em] font-light leading-none">{n.l}</span>}
          <span className="inline-grid gap-x-2 gap-y-0.5 px-1 align-middle" style={{ gridTemplateColumns: `repeat(${Math.max(...n.rows.map((r) => r.length))}, auto)` }}>
            {n.rows.flatMap((row, ri) =>
              row.flatMap((cell, ci) => (
                <span key={`${ri}:${ci}`} className="text-center">
                  {cell.map((m, j) => <MathNodeView key={j} n={m} />)}
                </span>
              )),
            )}
          </span>
          {n.r && <span className="text-[1.6em] font-light leading-none">{n.r}</span>}
        </span>
      );
  }
}
