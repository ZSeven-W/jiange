import { useMemo, useReducer, useState } from "react";
import { Doc, encodeOps, type Op, type OpId } from "@jiange/collab";
import { diff } from "@/lib/textdiff";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

interface Replica {
  doc: Doc;
  outbox: Op[];
}

/**
 * P1 demo: two in-browser replicas of the self-written CRDT. Edits stay local
 * until you sync, so you can create genuinely concurrent edits and watch them converge.
 */
export function Playground() {
  const [, rerender] = useReducer((x: number) => x + 1, 0);
  const [bytes, setBytes] = useState(0);
  const { replicas, block } = useMemo(() => {
    const a = new Doc(1);
    const b = new Doc(2);
    const create = a.createBlock("paragraph");
    const ins = a.insertText(create.id, 0, "你好，Jiange")!;
    b.apply(create);
    b.apply(ins);
    return { replicas: [{ doc: a, outbox: [] }, { doc: b, outbox: [] }] as Replica[], block: create.id as OpId };
  }, []);

  const edit = (r: Replica, value: string) => {
    const d = diff(r.doc.text(block), value);
    if (!d) return;
    if (d.remove) r.outbox.push(...r.doc.deleteText(block, d.index, d.remove));
    const op = r.doc.insertText(block, d.index, d.insert);
    if (op) r.outbox.push(op);
    rerender();
  };

  const bold = (r: Replica) => {
    const n = [...r.doc.text(block)].length;
    const op = r.doc.format(block, 0, Math.min(2, n), "bold", "true");
    if (op) r.outbox.push(op);
    rerender();
  };

  const sync = () => {
    const [a, b] = replicas;
    const toB = a.outbox.splice(0);
    const toA = b.outbox.splice(0);
    setBytes(encodeOps([...toA, ...toB]).length);
    // deliver in reverse order to exercise out-of-order integration
    [...toB].reverse().forEach((op) => b.doc.apply(op));
    [...toA].reverse().forEach((op) => a.doc.apply(op));
    rerender();
  };

  const converged = JSON.stringify(replicas[0].doc.view()) === JSON.stringify(replicas[1].doc.view());

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={sync}>同步两个副本</Button>
        <span className="text-sm text-muted-foreground">
          上次同步 {bytes} 字节 · {converged ? "已收敛" : "未同步"}
        </span>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        {replicas.map((r, i) => (
          <Card key={i}>
            <CardHeader>
              <CardTitle>副本 {i + 1}（client {r.doc.client}）</CardTitle>
              <CardDescription>待发送操作：{r.outbox.length}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <textarea
                className="h-28 w-full rounded-md border p-2 text-sm"
                value={r.doc.text(block)}
                onChange={(e) => edit(r, e.target.value)}
              />
              <Button variant="outline" size="sm" onClick={() => bold(r)}>
                前两个字加粗
              </Button>
              <p className="text-sm">
                {r.doc.view().blocks[0]?.spans.map((s, k) => (
                  <span key={k} className={s.marks.bold ? "font-bold" : undefined}>
                    {s.text}
                  </span>
                ))}
              </p>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
