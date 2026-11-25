import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Doc, ROOT, Tx, idKey } from "@zseven-w/collab";
import { CLIPPABLE_BLOCKS, TEXTLESS } from "@zseven-w/doc-sdk/model";
import {
  AudioBlockView,
  CountdownBlockView,
  DEFAULT_POLL_OPTIONS,
  DEFAULT_TABS,
  PollBlockView,
  TabsBlockView,
  VideoBlockView,
  computeCountdown,
  defaultCountdownTarget,
  fromDateTimeLocalValue,
  isDirectVideoUrl,
  normalizeCountdownTheme,
  parsePollOptions,
  parsePollVotes,
  parseTabsData,
  resolveMediaFileUrl,
  safeMediaUrl,
  toDateTimeLocalValue,
  togglePollVote,
  videoEmbedUrl,
} from "./interactive-blocks";
import { filterItems, SLASH_ITEMS } from "./pinyin";
import { SlashMenu } from "./slash-menu";
import { blockCommentAnchor } from "./comment-anchor";
import { blockClipboardPlain } from "./clipboard-payload";
import { planClipboardAssets, remapClipboardAssets } from "./clipboard-assets";
import { Editor } from "./editor";
import { ReadOnlyDoc } from "@/pages/read-only-doc";
import type { SyncDoc } from "@/lib/use-sync-doc";

describe("media URL validation and video embed parsing", () => {
  it("accepts safe https/http and internal /api/files URLs while rejecting unsafe schemes", () => {
    expect(safeMediaUrl("https://cdn.example.com/song.mp3")).toBe("https://cdn.example.com/song.mp3");
    expect(safeMediaUrl("/api/files/42")).toBe("/api/files/42");
    expect(safeMediaUrl("/api/files/42?version=7")).toBe("/api/files/42?version=7");
    expect(safeMediaUrl("/api/public/tok_123/files/9")).toBe("/api/public/tok_123/files/9");
    expect(safeMediaUrl("javascript:alert(1)")).toBeUndefined();
    expect(safeMediaUrl("data:audio/mpeg;base64,abc")).toBeUndefined();
    expect(safeMediaUrl("/api/files/../secret")).toBeUndefined();
    expect(safeMediaUrl("#/doc/12")).toBeUndefined();
  });

  it("resolves uploaded file IDs for authenticated and public views", () => {
    expect(resolveMediaFileUrl("15")).toBe("/api/files/15");
    expect(resolveMediaFileUrl("15", undefined, 8)).toBe("/api/files/15?version=8");
    expect(resolveMediaFileUrl("15", "share_tok")).toBe("/api/public/share_tok/files/15");
    expect(resolveMediaFileUrl("0")).toBeUndefined();
    expect(resolveMediaFileUrl("../1")).toBeUndefined();
  });

  it("detects direct HTML5 video URLs and YouTube/Bilibili/Vimeo embeds", () => {
    expect(isDirectVideoUrl("https://cdn.example.com/demo.mp4")).toBe(true);
    expect(isDirectVideoUrl("https://cdn.example.com/demo.webm?token=1")).toBe(true);
    expect(isDirectVideoUrl("https://cdn.example.com/demo.ogg")).toBe(true);
    expect(isDirectVideoUrl("https://cdn.example.com/demo.mov")).toBe(true);
    expect(isDirectVideoUrl("/api/files/12")).toBe(true);
    expect(isDirectVideoUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe(false);

    expect(videoEmbedUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toEqual({
      provider: "youtube",
      label: "YouTube",
      embedSrc: "https://www.youtube.com/embed/dQw4w9WgXcQ",
    });
    expect(videoEmbedUrl("https://youtu.be/dQw4w9WgXcQ")).toEqual({
      provider: "youtube",
      label: "YouTube",
      embedSrc: "https://www.youtube.com/embed/dQw4w9WgXcQ",
    });
    expect(videoEmbedUrl("https://www.bilibili.com/video/BV1xx411c7mD/")).toEqual({
      provider: "bilibili",
      label: "Bilibili",
      embedSrc: "https://player.bilibili.com/player.html?bvid=BV1xx411c7mD&high_quality=1&autoplay=0",
    });
    expect(videoEmbedUrl("https://vimeo.com/123456789")).toEqual({
      provider: "vimeo",
      label: "Vimeo",
      embedSrc: "https://player.vimeo.com/video/123456789",
    });
    expect(videoEmbedUrl("javascript:alert(1)")).toBeNull();
    expect(videoEmbedUrl("https://example.com/watch")).toBeNull();
  });
});

describe("poll CRDT per-user vote logic", () => {
  it("aggregates concurrent per-user vote.<userId> registers without overwriting", () => {
    const opts = parsePollOptions(JSON.stringify([
      { id: "opt-1", text: "方案一" },
      { id: "opt-2", text: "方案二" },
      { id: "opt-3", text: "方案三" },
    ]));
    const ids = new Set(opts.map((o) => o.id));
    const votes = parsePollVotes(
      {
        question: "评审选型",
        "vote.1": "opt-1,opt-2",
        "vote.2": "opt-2",
        "vote.3": "opt-2,invalid-id",
        "vote.bad key": "opt-1",
      },
      ids,
    );
    expect(votes.voterCount).toBe(3);
    expect(votes.counts.get("opt-1")).toBe(1);
    expect(votes.counts.get("opt-2")).toBe(3);
    expect(votes.counts.get("opt-3")).toBe(0);
    expect(votes.byUser.get("1")).toEqual(["opt-1", "opt-2"]);
  });

  it("toggles single-choice and multi-choice selections cleanly", () => {
    expect(togglePollVote([], "opt-1", false)).toEqual(["opt-1"]);
    expect(togglePollVote(["opt-1"], "opt-1", false)).toEqual([]);
    expect(togglePollVote(["opt-1"], "opt-2", false)).toEqual(["opt-2"]);

    expect(togglePollVote(["opt-1"], "opt-2", true)).toEqual(["opt-1", "opt-2"]);
    expect(togglePollVote(["opt-1", "opt-2"], "opt-1", true)).toEqual(["opt-2"]);
  });
});

describe("countdown and tabs pure helpers", () => {
  it("computes remaining D/H/M/S and expired states accurately", () => {
    const now = Date.UTC(2026, 10, 24, 10, 0, 0);
    const future = new Date(now + (2 * 86400 + 3 * 3600 + 4 * 60 + 5) * 1000).toISOString();
    expect(computeCountdown(future, now)).toEqual({
      valid: true,
      expired: false,
      days: 2,
      hours: 3,
      minutes: 4,
      seconds: 5,
    });
    const past = new Date(now - 1000).toISOString();
    expect(computeCountdown(past, now)).toEqual({
      valid: true,
      expired: true,
      days: 0,
      hours: 0,
      minutes: 0,
      seconds: 0,
    });
    expect(computeCountdown("not-a-date", now).valid).toBe(false);
    expect(normalizeCountdownTheme("purple")).toBe("purple");
    expect(normalizeCountdownTheme("invalid")).toBe("blue");
    const target7d = defaultCountdownTarget(new Date(now));
    expect(computeCountdown(target7d, now).days).toBe(7);
    expect(fromDateTimeLocalValue(toDateTimeLocalValue(future))).toBeTruthy();
  });

  it("parses tabs JSON and falls back cleanly to starter tabs", () => {
    expect(parseTabsData(undefined)).toEqual(DEFAULT_TABS);
    expect(parseTabsData("invalid-json")).toEqual(DEFAULT_TABS);
    const parsed = parseTabsData(JSON.stringify([
      { id: "a", label: "前端", content: "## 计划" },
      { id: "b", label: "后端", content: "- 接口设计" },
    ]));
    expect(parsed).toEqual([
      { id: "a", label: "前端", content: "## 计划" },
      { id: "b", label: "后端", content: "- 接口设计" },
    ]);
  });
});

describe("interactive block components, slash menu, editor, and read-only rendering", () => {
  it("registers audio, poll, countdown, and tabs in doc-sdk sets and slash items", () => {
    for (const type of ["audio", "video", "poll", "countdown", "tabs"]) {
      expect(CLIPPABLE_BLOCKS.has(type)).toBe(true);
      expect(TEXTLESS.has(type)).toBe(true);
    }
    expect(filterItems("audio").map((i) => i.id)).toContain("audio");
    expect(filterItems("音频").map((i) => i.id)).toContain("audio");
    expect(filterItems("poll").map((i) => i.id)).toContain("poll");
    expect(filterItems("投票").map((i) => i.id)).toContain("poll");
    expect(filterItems("countdown").map((i) => i.id)).toContain("countdown");
    expect(filterItems("倒计时").map((i) => i.id)).toContain("countdown");
    expect(filterItems("tabs").map((i) => i.id)).toContain("tabs");
    expect(filterItems("标签页").map((i) => i.id)).toContain("tabs");

    const slashHtml = renderToStaticMarkup(<SlashMenu x={0} y={0} items={SLASH_ITEMS} index={0} onPick={() => {}} onHover={() => {}} />);
    for (const id of ["audio", "video", "poll", "countdown", "tabs"]) {
      expect(slashHtml).toContain(`data-value="${id}"`);
    }
  });

  it("renders Audio, Video (native + embed + uploaded fileId), Poll, Countdown, and Tabs cleanly", () => {
    const audioHtml = renderToStaticMarkup(<AudioBlockView fileId="21" title="客户访谈录音" name="interview.mp3" />);
    expect(audioHtml).toContain("data-audio-block");
    expect(audioHtml).toContain('src="/api/files/21"');
    expect(audioHtml).toContain("<audio");
    expect(audioHtml).toContain("客户访谈录音");

    const videoFileHtml = renderToStaticMarkup(<VideoBlockView fileId="33" title="演示录屏" />);
    expect(videoFileHtml).toContain("<video");
    expect(videoFileHtml).toContain('src="/api/files/33"');

    const ytHtml = renderToStaticMarkup(<VideoBlockView url="https://www.youtube.com/watch?v=dQw4w9WgXcQ" title="发布演讲" />);
    expect(ytHtml).toContain("<iframe");
    expect(ytHtml).toContain('src="https://www.youtube.com/embed/dQw4w9WgXcQ"');
    expect(ytHtml).toContain('data-video-embed="youtube"');

    const pollHtml = renderToStaticMarkup(
      <PollBlockView
        props={{
          question: "聚餐地点投票",
          options: JSON.stringify(DEFAULT_POLL_OPTIONS),
          multiple: "false",
          "vote.1": "opt-1",
          "vote.2": "opt-1",
        }}
        voterId="1"
        onSetProp={() => {}}
      />,
    );
    expect(pollHtml).toContain("data-poll-block");
    expect(pollHtml).toContain("聚餐地点投票");
    expect(pollHtml).toContain("2 人已投票");
    expect(pollHtml).toContain("100%");

    const expiredCountdown = renderToStaticMarkup(
      <CountdownBlockView title="截止时间" targetAt="2020-01-01T00:00:00Z" theme="orange" readOnly />,
    );
    expect(expiredCountdown).toContain("data-countdown-block");
    expect(expiredCountdown).toContain('data-countdown-expired="true"');
    expect(expiredCountdown).toContain("已到期");

    const tabsHtml = renderToStaticMarkup(
      <TabsBlockView
        raw={JSON.stringify([
          { id: "tab-1", label: "方案 A", content: "**加粗重点** 与 `inline_code`" },
          { id: "tab-2", label: "方案 B", content: "备选内容" },
        ])}
        readOnly
      />,
    );
    expect(tabsHtml).toContain("data-tabs-block");
    expect(tabsHtml).toContain("方案 A");
    expect(tabsHtml).toContain("方案 B");
    expect(tabsHtml).toContain("<strong");
    expect(tabsHtml).toContain("inline_code");
  });

  it("renders all 5 block types end-to-end inside both Editor and ReadOnlyDoc and supports comments & clipboard", () => {
    const doc = new Doc(1);
    const tx = new Tx(doc);
    const audio = tx.create("audio", null, ROOT, { fileId: "11", title: "周会录音" });
    const video = tx.create("video", audio, ROOT, { url: "https://www.bilibili.com/video/BV1xx411c7mD", title: "培训回放" });
    const poll = tx.create("poll", video, ROOT, {
      question: "是否通过？",
      options: JSON.stringify([{ id: "yes", text: "通过" }, { id: "no", text: "驳回" }]),
      multiple: "false",
      "vote.5": "yes",
    });
    const countdown = tx.create("countdown", poll, ROOT, {
      title: "里程碑发布",
      targetAt: "2030-01-01T00:00:00Z",
      theme: "green",
    });
    const tabs = tx.create("tabs", countdown, ROOT, {
      tabs: JSON.stringify([
        { id: "t1", label: "方案 A", content: "执行详情" },
        { id: "t2", label: "方案 B", content: "回滚预案" },
      ]),
    });

    expect(blockCommentAnchor(doc, audio)).toEqual({
      ok: true,
      anchor: { block: idKey(audio), startChar: "", endChar: "", quote: "[音频] 周会录音" },
    });
    expect(blockCommentAnchor(doc, poll)).toEqual({
      ok: true,
      anchor: { block: idKey(poll), startChar: "", endChar: "", quote: "[投票] 是否通过？" },
    });
    expect(blockClipboardPlain({ type: "countdown", props: { title: "里程碑发布" }, chars: [] })).toBe("里程碑发布");

    const plan = planClipboardAssets(
      [{ type: "audio", props: { fileId: "11", title: "周会录音" }, chars: [], source: { origin: "https://app.test", docId: 1 } }],
      "https://app.test",
    );
    expect(plan).toEqual({ ok: true, assets: { sourceDocId: 1, fileIds: [11] } });
    if (plan.ok && plan.assets) {
      const remapped = remapClipboardAssets(
        [{ type: "audio", props: { fileId: "11", title: "周会录音" }, chars: [] }],
        plan.assets,
        { "11": 77 },
        2,
      );
      expect(remapped?.[0].props.fileId).toBe("77");
    }

    const sync = { client: { doc, docId: 1 }, peers: [], version: 0, status: "synced" } as unknown as SyncDoc;
    const editorHtml = renderToStaticMarkup(<Editor sync={sync} userId={5} me={{ name: "测试", color: "#3370ff" }} />);
    expect(editorHtml).toContain("data-audio-block");
    expect(editorHtml).toContain('data-video-embed="bilibili"');
    expect(editorHtml).toContain("data-poll-block");
    expect(editorHtml).toContain("data-countdown-block");
    expect(editorHtml).toContain("data-tabs-block");

    const roHtml = renderToStaticMarkup(<ReadOnlyDoc view={doc.view()} publicToken="pub_tok" />);
    expect(roHtml).toContain('src="/api/public/pub_tok/files/11"');
    expect(roHtml).toContain('data-video-embed="bilibili"');
    expect(roHtml).toContain("是否通过？");
    expect(roHtml).toContain("里程碑发布");
    expect(roHtml).toContain("执行详情");
  });
});
