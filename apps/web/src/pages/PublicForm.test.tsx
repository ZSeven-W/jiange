import { afterEach, describe, expect, it, vi } from "vitest";
import { parseHash } from "@/lib/route";
import { formCells, publicFormPendingKey, publicFormResponseIsDefinite, supportsPublicFormField } from "./PublicForm";
import { closeForm, formLink, isFormToken, publishForm, readFormPublication, saveFormConfig } from "./base/publicFormApi";
import { ApiError } from "@/lib/api";

const token = "a".repeat(43);
afterEach(() => vi.unstubAllGlobals());
describe("published forms", () => {
  it("routes only opaque tokens and treats legacy numeric links as closed", () => {
    expect(parseHash(`#/form/${token}`)).toEqual({ page: "form", token });
    expect(parseHash("#/form/12/34")).toEqual({ page: "legacy-form" });
    expect(parseHash(`#/form/${token}/extra`)).toEqual({ page: "legacy-form" });
    expect(isFormToken(token)).toBe(true);
    expect(isFormToken("1/2")).toBe(false);
    expect(formLink(token, "https://example.test", "/workspace/")).toBe(`https://example.test/workspace/#/form/${token}`);
  });
  it("builds typed cells while excluding unauthorized field types", () => {
    const fields = [{id:1,name:"文本",type:"text"},{id:2,name:"数字",type:"number"},{id:3,name:"多选",type:"multi_select"},{id:4,name:"勾选",type:"checkbox"},{id:5,name:"人员",type:"person"},{id:6,name:"附件",type:"attachment"}];
    expect(formCells(fields, {1:"  原文 ",2:"12.5",3:["甲","乙"],4:false,5:"123",6:"1"})).toEqual({"1":"  原文 ","2":12.5,"3":["甲","乙"],"4":false});
    expect(supportsPublicFormField("link")).toBe(false);
    expect(() => formCells(fields, {2:"not-a-number"})).toThrow("有效数字");
  });
  it("requires the fields marked required without treating zero or false as missing", () => {
    const fields = [{id:1,name:"名称",type:"text",required:true},{id:2,name:"数量",type:"number",required:true},{id:3,name:"确认",type:"checkbox",required:true}];
    expect(() => formCells(fields, {1:" ",2:"0",3:false})).toThrow("名称");
    expect(() => formCells(fields, {1:"已填",2:"0"})).toThrow("确认");
    expect(formCells(fields, {1:"已填",2:"0",3:false})).toEqual({"1":"已填","2":0,"3":false});
  });
  it("uses a SHA-256 digest, never the raw bearer token, for the pending marker", async () => {
    const digest = vi.fn().mockResolvedValue(new Uint8Array(32).fill(0xab).buffer);
    vi.stubGlobal("crypto", { subtle: { digest } });
    const key = await publicFormPendingKey(token);
    expect(digest).toHaveBeenCalledWith("SHA-256", new TextEncoder().encode(token));
    expect(key).toBe(`jiange:form-pending:${"ab".repeat(32)}`);
    expect(key).not.toContain(token);
  });
  it("allows a later manual retry only for server responses known to precede writes", () => {
    expect(publicFormResponseIsDefinite(429, "form_rate_limited")).toBe(true);
    expect(publicFormResponseIsDefinite(503, "form_busy")).toBe(true);
    expect(publicFormResponseIsDefinite(503, "other")).toBe(false);
    expect(publicFormResponseIsDefinite(408, "timeout")).toBe(false);
    expect(publicFormResponseIsDefinite(429, "other")).toBe(false);
  });
  it("uses the one-time token publication contract and never treats an invalid payload as success", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({published:false,revision:0}),{status:200})).mockResolvedValueOnce(new Response(JSON.stringify({token,revision:1}),{status:200})).mockResolvedValueOnce(new Response(JSON.stringify({published:false,revision:2}),{status:200})).mockResolvedValueOnce(new Response(JSON.stringify({token:"bad",revision:3}),{status:200}));
    vi.stubGlobal("fetch", fetchMock);
    expect(await readFormPublication(2, 3)).toEqual({published:false,revision:0});
    expect(await publishForm(2, 3, 0, {fields:[1]}, [{id:1,name:"文本",type:"text",position:1}])).toEqual({token,revision:1});
    expect(await closeForm(2, 3, 1)).toEqual({published:false,revision:2});
    await expect(publishForm(2, 3, 2, {fields:[1]}, [{id:1,name:"文本",type:"text",position:1}])).rejects.toThrow("发布结果无效");
    expect(fetchMock.mock.calls.map((call) => [call[0], call[1].method])).toEqual([["/api/bases/2/views/3/public-form","GET"],["/api/bases/2/views/3/public-form","POST"],["/api/bases/2/views/3/public-form","DELETE"],["/api/bases/2/views/3/public-form","POST"]]);
    expect(fetchMock.mock.calls[0][1].cache).toBe("no-store");
    expect(fetchMock.mock.calls.slice(1).map((call) => JSON.parse(call[1].body).expectedRevision)).toEqual([0,1,2]);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toMatchObject({expectedConfig:{fields:[1]},expectedFields:[{id:1,name:"文本"}]});
  });
  it("preserves permission failures rather than fabricating a publication status", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({error:"forbidden",message:"无权限"}),{status:403})));
    await expect(readFormPublication(2,3)).rejects.toMatchObject({status:403,code:"forbidden"} satisfies Partial<ApiError>);
  });
  it("reports a revision conflict and rejects a non-advancing write response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({error:"conflict",message:"状态已变化"}),{status:409})).mockResolvedValueOnce(new Response(JSON.stringify({published:false,revision:3}),{status:200})));
    await expect(closeForm(2,3,2)).rejects.toMatchObject({status:409,code:"conflict"});
    await expect(closeForm(2,3,3)).rejects.toThrow("关闭结果无效");
  });
  it("sends the exact observed configuration and field schema with a form configuration update", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({config:{fields:[1],required:[1]}}),{status:200}));
    vi.stubGlobal("fetch", fetchMock);
    const schema = [{id:1,name:"文本",type:"text" as const,position:1}];
    expect(await saveFormConfig(2,3,{},schema,{fields:[1],required:[1]})).toEqual({fields:[1],required:[1]});
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({expectedConfig:{},expectedFields:schema,config:{fields:[1],required:[1]}});
  });
});
