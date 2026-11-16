import { describe, expect, it } from "vitest";
import { moveShapeOrder, moveSlideLineEndpoint, slideLineEndpoints, type SlideShape } from "../src/index.js";

describe("headless slides model", () => {
  it("moves objects and changes a line endpoint while holding the other end", () => {
    const a: SlideShape = {id:"a",kind:"line",x:20,y:30,width:30,height:5,color:"#1f2329"};
    const b: SlideShape = {id:"b",kind:"rectangle",x:5,y:5,color:"#3370ff"};
    expect(moveShapeOrder([a,b], "a", "front").map((shape) => shape.id)).toEqual(["b","a"]);
    const before = slideLineEndpoints(a,960,540).start;
    const after = slideLineEndpoints(moveSlideLineEndpoint(a,"end",60,50,960,540),960,540).start;
    expect(Math.hypot(after.x-before.x, after.y-before.y)).toBeLessThan(2);
  });
});
