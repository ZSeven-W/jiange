const C = { p:"#3370FF", ps:"#E1EAFF", t:"#1F2329", t2:"#646A73", t3:"#8F959E", b:"#DEE0E3", sb:"#F5F6F7", hv:"#EBECED", w:"#FFFFFF", r1:"#F54A45", r2:"#00B42A" };
const txt = (p, s, size, color, weight) => I(p, {type:"text", name:"c"+(color||C.t), content:s, fontSize:size, fill:color||C.t, fontWeight:weight||400});
const row = (p, o) => I(p, Object.assign({type:"frame", layout:"horizontal", alignItems:"center", gap:8}, o||{}));
const col = (p, o) => I(p, Object.assign({type:"frame", layout:"vertical", gap:8}, o||{}));
const avatar = (p, letter, color, size) => { const a = I(p, {type:"frame", width:size||28, height:size||28, cornerRadius:(size||28)/2, fill:color, layout:"horizontal", justifyContent:"center", alignItems:"center", stroke:{thickness:2, fill:C.w}}); txt(a, letter, 12, C.w, 600); return a; };
const logo = (p, size) => { const l = I(p, {type:"frame", width:size, height:size, cornerRadius:size/4, fill:C.p, layout:"horizontal", justifyContent:"center", alignItems:"center"}); txt(l, "J", size*0.55, C.w, 700); return l; };

/* ---------- 1. Login ---------- */
const login = I(null, {type:"frame", name:"Login", x:0, y:0, width:1280, height:800, layout:"horizontal", fill:C.w});
const hero = col(login, {name:"Hero", width:560, height:"fill_container", padding:[64,56,64,56], gap:24, fill:"#F0F4FF", justifyContent:"space_between"});
const brand = row(hero, {gap:10}); logo(brand, 32); txt(brand, "Jiange", 22, C.t, 700);
const heroText = col(hero, {gap:16});
txt(heroText, "一起写，一起想", 40, C.t, 700);
txt(heroText, "开源、可自部署的 AI 原生协作文档与多维表格", 18, C.t2);
const feats = col(heroText, {gap:12, padding:[16,0,0,0]});
for (const f of ["实时多人协作，毫秒级同步", "自研协同内核，离线也能写", "数据完全掌握在自己手里"]) { const r = row(feats, {gap:10}); I(r, {type:"ellipse", width:8, height:8, fill:C.p}); txt(r, f, 15, C.t2); }
txt(hero, "MIT License · github.com/ZSeven-W/jiange", 13, C.t3);
const right = I(login, {type:"frame", width:"fill_container", height:"fill_container", layout:"vertical", justifyContent:"center", alignItems:"center"});
const card = col(right, {name:"LoginCard", width:380, gap:20});
txt(card, "登录 Jiange", 28, C.t, 700);
txt(card, "欢迎回来，使用邮箱继续", 14, C.t2);
for (const [lab, ph] of [["邮箱", "name@company.com"], ["密码", "••••••••"]]) {
  const g = col(card, {width:"fill_container", gap:8}); txt(g, lab, 14, C.t, 500);
  const inp = I(g, {type:"frame", width:"fill_container", height:40, cornerRadius:6, fill:C.w, stroke:{thickness:1, fill:C.b}, layout:"horizontal", alignItems:"center", padding:[0,12,0,12]}); txt(inp, ph, 14, C.t3);
}
const btn = I(card, {type:"frame", name:"PrimaryButton", width:"fill_container", height:40, cornerRadius:6, fill:C.p, layout:"horizontal", justifyContent:"center", alignItems:"center"}); txt(btn, "登录", 15, C.w, 600);
const sw = row(card, {gap:4}); txt(sw, "还没有账号？", 14, C.t2); txt(sw, "免费注册", 14, C.p, 500);

/* ---------- shell builder ---------- */
function shell(name, x, presence) {
  const root = I(null, {type:"frame", name, x, y:0, width:1280, height:800, layout:"horizontal", fill:C.w, clipContent:true});
  const sb = col(root, {name:"Sidebar", width:248, height:"fill_container", fill:C.sb, padding:[12,8,12,8], gap:4, stroke:{thickness:1, fill:C.b}});
  const ws = row(sb, {width:"fill_container", padding:[6,8,6,8], gap:8}); logo(ws, 24); txt(ws, "Kay 的空间", 14, C.t, 600); txt(ws, "⌄", 14, C.t3);
  const search = row(sb, {width:"fill_container", height:32, cornerRadius:6, fill:C.w, stroke:{thickness:1, fill:C.b}, padding:[0,10,0,10]}); txt(search, "⌕  搜索", 13, C.t3); 
  I(sb, {type:"frame", width:"fill_container", height:6});
  const nav = (label, active) => { const r = row(sb, {width:"fill_container", height:32, cornerRadius:6, padding:[0,10,0,10], fill: active? C.hv : "#00000000"}); txt(r, label, 14, active? C.t : C.t2, active?500:400); return r; };
  nav("⌂  主页"); nav("◷  最近访问"); nav("☆  收藏");
  I(sb, {type:"frame", width:"fill_container", height:10});
  txt(sb, "  文档", 12, C.t3, 500);
  const tree = [["▾ ▤ 产品规划", 0, false], ["▤ P2 同步服务设计", 1, true], ["▤ 协同内核规范", 1, false], ["▸ ▤ 周报", 0, false], ["▤ 会议纪要 11-03", 0, false]];
  for (const [l, depth, act] of tree) { const r = row(sb, {width:"fill_container", height:30, cornerRadius:6, padding:[0,10,0,10+depth*16], fill: act? C.ps : "#00000000"}); txt(r, l, 14, act? C.p : C.t, act?500:400); }
  const sp = I(sb, {type:"frame", width:"fill_container", height:"fill_container"});
  const nd = row(sb, {width:"fill_container", height:32, cornerRadius:6, padding:[0,10,0,10]}); txt(nd, "＋  新建文档", 14, C.t2);

  const main = col(root, {name:"Main", width:"fill_container", height:"fill_container", gap:0});
  const top = row(main, {name:"TopBar", width:"fill_container", height:52, padding:[0,20,0,20], justifyContent:"space_between", stroke:{thickness:1, fill:C.b}});
  const bc = row(top, {gap:6}); txt(bc, "产品规划", 14, C.t2); txt(bc, "/", 14, C.t3); txt(bc, "P2 同步服务设计", 14, C.t, 500);
  if (presence) { const st = row(bc, {padding:[0,0,0,8]}); I(st, {type:"ellipse", width:6, height:6, fill:C.r2}); txt(st, "已同步", 12, C.t3); }
  const actions = row(top, {gap:12});
  const avs = row(actions, {gap:-6}); avatar(avs, "K", C.p); if (presence) { avatar(avs, "A", C.r1); avatar(avs, "B", C.r2); }
  const share = I(actions, {type:"frame", height:32, cornerRadius:6, fill:C.p, padding:[0,16,0,16], layout:"horizontal", alignItems:"center"}); txt(share, "分享", 14, C.w, 500);
  txt(actions, "⋯", 18, C.t2);

  const scroll = I(main, {type:"frame", width:"fill_container", height:"fill_container", layout:"vertical", alignItems:"center", padding:[56,0,0,0]});
  const doc = col(scroll, {name:"DocCanvas", width:720, gap:18});
  txt(doc, "P2 同步服务设计", 36, C.t, 700);
  const meta = row(doc, {gap:8}); avatar(meta, "K", C.p, 20); txt(meta, "Kay · 最近修改于 今天 21:50", 13, C.t3);
  I(doc, {type:"frame", width:"fill_container", height:4});
  txt(doc, "目标", 22, C.t, 600);
  const p1 = row(doc, {width:"fill_container", gap:0, alignItems:"start"});
  txt(p1, "服务器只负责鉴权、分配序号、持久化与广播，不做 transform。", 16, C.t);
  if (presence) {
    const cur = col(p1, {gap:0}); const tag = I(cur, {type:"frame", cornerRadius:3, fill:C.r1, padding:[1,5,1,5]}); txt(tag, "Alice", 11, C.w, 500); I(cur, {type:"rectangle", width:2, height:20, fill:C.r1});
  }
  txt(doc, "客户端断线重连时携带 lastSeq，服务端补发增量；差距过大则下发快照。", 16, C.t);
  const p3 = row(doc, {width:"fill_container", gap:0, alignItems:"start"});
  txt(p3, "快照按水位线回收墓碑，所有客户端确认过的序号之前的删除可以安全清理", 16, C.t);
  if (presence) { const cur = col(p3, {gap:0}); const tag = I(cur, {type:"frame", cornerRadius:3, fill:C.r2, padding:[1,5,1,5]}); txt(tag, "Bob", 11, C.w, 500); I(cur, {type:"rectangle", width:2, height:20, fill:C.r2}); }
  const callout = row(doc, {width:"fill_container", padding:[12,16,12,16], cornerRadius:8, fill:"#F0F4FF", stroke:{thickness:1, fill:"#BACEFD"}}); txt(callout, "💡 所有操作在客户端先本地生效，再异步同步。", 15, C.t);
  return root;
}
shell("App · Doc", 1360, false);
shell("App · Presence", 2720, true);

/* ---------- P3: rich block editor, slash menu, format toolbar, nested tree ---------- */
{
  const base = I(null, {type:"frame", name:"Editor · Rich", x:4080, y:0, width:1280, height:800, layout:"horizontal", fill:C.w, clipContent:true});
  const sb = col(base, {name:"Sidebar", width:248, height:"fill_container", fill:C.sb, padding:[12,8,12,8], gap:4, stroke:{thickness:1, fill:C.b}});
  const ws = row(sb, {width:"fill_container", padding:[6,8,6,8], gap:8}); logo(ws, 24); txt(ws, "Kay 的空间", 14, C.t, 600);
  const search = row(sb, {width:"fill_container", height:32, cornerRadius:6, fill:C.w, stroke:{thickness:1, fill:C.b}, padding:[0,10,0,10]}); txt(search, "⌕  搜索", 13, C.t3);
  I(sb, {type:"frame", width:"fill_container", height:8});
  txt(sb, "  文档", 12, C.t3, 500);
  const tree = [["▾  产品规划", 0], ["▾  编辑器", 1], ["P3 块编辑器设计", 2, true], ["输入法与选区", 2], ["▸  同步服务", 1], ["▸  周报", 0], ["会议纪要 11-03", 0]];
  for (const [l, d, act] of tree) { const r = row(sb, {width:"fill_container", height:30, cornerRadius:6, padding:[0,10,0,10+d*16], fill: act? C.ps : "#00000000"}); txt(r, (l.startsWith("▸")||l.startsWith("▾")? "" : "▤ ") + l, 14, act? C.p : C.t, act?500:400); }
  const main = col(base, {width:"fill_container", height:"fill_container", gap:0});
  const top = row(main, {width:"fill_container", height:52, padding:[0,20,0,20], justifyContent:"space_between", stroke:{thickness:1, fill:C.b}});
  const bc = row(top, {gap:6}); txt(bc, "产品规划 / 编辑器 /", 14, C.t2); txt(bc, "P3 块编辑器设计", 14, C.t, 500);
  const acts = row(top, {gap:12}); const avs = row(acts, {gap:-6}); avatar(avs, "K", C.p); avatar(avs, "A", C.r1);
  const sh = I(acts, {type:"frame", height:32, cornerRadius:6, fill:C.p, padding:[0,16,0,16], layout:"horizontal", alignItems:"center"}); txt(sh, "分享", 14, C.w, 500);
  const sc = I(main, {type:"frame", width:"fill_container", height:"fill_container", layout:"vertical", alignItems:"center", padding:[44,0,0,0]});
  const doc = col(sc, {width:720, gap:12});
  txt(doc, "P3 块编辑器设计", 34, C.t, 700);
  txt(doc, "目标", 24, C.t, 600);
  const tbw = row(doc, {padding:[0,0,0,120]});
  // format toolbar over the bold text
  const tb = I(tbw, {type:"frame", name:"FormatToolbar", width:300, height:38, cornerRadius:8, fill:C.w, stroke:{thickness:1, fill:C.b}, layout:"horizontal", alignItems:"center", gap:2, padding:[0,6,0,6]});
  for (const [s, on] of [["正文 ⌄", 0], ["B", 1], ["I", 0], ["U", 0], ["S", 0], ["</>", 0], ["🔗", 0]]) { const b = I(tb, {type:"frame", height:28, cornerRadius:4, padding:[0,8,0,8], fill: on? C.ps : "#00000000", layout:"horizontal", alignItems:"center"}); txt(b, s, 14, on? C.p : C.t, on?700:500); }
  const p = row(doc, {gap:0}); txt(p, "块编辑器完全自研：", 16, C.t); txt(p, "加粗", 16, C.t, 700); txt(p, "、", 16, C.t); txt(p, "行内代码", 14, "#D83931"); txt(p, " 与 ", 16, C.t); txt(p, "链接", 16, C.p);
  for (const s of ["• 斜杠菜单支持拼音缩写", "• 中文输入法组合输入"]) txt(doc, s, 16, C.t);
  for (const [box, s] of [["☑", "Markdown 快捷键"], ["☐", "块拖拽"]]) { const r = row(doc, {gap:8}); txt(r, box, 16, box==="☑"?C.p:C.t3); txt(r, s, 16, box==="☑"?C.t3:C.t); }
  const q = row(doc, {width:"fill_container", gap:12}); I(q, {type:"rectangle", width:3, height:24, fill:C.b}); txt(q, "撤销只回滚自己的操作。", 16, C.t2);
  const code = col(doc, {width:"fill_container", padding:[12,16,12,16], cornerRadius:6, fill:C.sb}); txt(code, "doc.format(block, 0, 4, \"bold\", \"true\")", 14, C.t);
  I(doc, {type:"rectangle", width:720, height:1, fill:C.b});
  const typing = row(doc, {gap:0}); txt(typing, "/bt", 16, C.t); I(typing, {type:"rectangle", width:2, height:20, fill:C.p});
  // slash menu under "/bt"
  const sm = I(doc, {type:"frame", name:"SlashMenu", width:260, height:176, cornerRadius:8, fill:C.w, stroke:{thickness:1, fill:C.b}, layout:"vertical", gap:2, padding:[6,6,6,6]});
  txt(sm, "  基础", 12, C.t3, 500);
  for (const [ic, l, k, on] of [["H1", "一级标题", "yjbt", 1], ["H2", "二级标题", "ejbt", 0], ["H3", "三级标题", "sjbt", 0], ["≡", "有序列表", "yxlb", 0]]) {
    const r = row(sm, {width:"fill_container", height:34, cornerRadius:6, padding:[0,8,0,8], fill: on? C.hv : "#00000000", justifyContent:"space_between"});
    const l2 = row(r, {gap:10}); const ib = I(l2, {type:"frame", width:24, height:24, cornerRadius:4, stroke:{thickness:1, fill:C.b}, layout:"horizontal", justifyContent:"center", alignItems:"center"}); txt(ib, ic, 11, C.t2, 600); txt(l2, l, 14, C.t);
    txt(r, k, 12, C.t3);
  }
}
