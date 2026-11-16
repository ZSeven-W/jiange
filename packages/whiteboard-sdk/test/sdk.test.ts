import { describe, expect, it } from "vitest";
import { flowWrites, readFlow, type FlowGraph } from "../src/index.js";

describe("headless whiteboard model", () => {
  it("round-trips a node and a stroke through the shared document properties", () => {
    const graph: FlowGraph = {theme:"feishu",nodes:[{id:"n1",x:12,y:24,w:140,h:60,shape:"rect",text:"开始"}],edges:[],strokes:[{id:"s1",points:[{x:0,y:0},{x:3,y:4}],color:"#3370ff",width:2}]};
    const read = readFlow(flowWrites({},graph));
    expect(read.nodes[0]).toMatchObject({id:"n1",text:"开始",x:12,y:24});
    expect(read.strokes?.[0]).toMatchObject({id:"s1",color:"#3370ff"});
  });
});
