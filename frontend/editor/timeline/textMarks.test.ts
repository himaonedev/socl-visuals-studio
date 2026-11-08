import { invoke } from "@tauri-apps/api/core";
import { makeProject, expectValid } from "@/test/makeProject";
import { defaultTextSpec } from "./text";
import {
  applyTextMark,
  textMarkWindow,
  textMarkSpec,
  createTextMark,
  DEFAULT_TEXT_MARK,
  type PreparedTextMark,
} from "./textMarks";
import { useProjectStore } from "@/store/project";
import { transformAt } from "./transform";
function fixture() {
  const p = makeProject();
  p.assets.push({
    id: "text",
    path: "/m/text.png",
    type: "image",
    width: 1920,
    height: 1080,
    text: { ...defaultTextSpec(1080), content: "one two three" },
  });
  p.tracks[0].clips = [
    {
      id: "caption",
      assetId: "text",
      trackId: "v1",
      timelineStart: 2,
      sourceIn: 0,
      sourceOut: 3,
      volume: 0,
      x: 0,
      y: 0,
      scale: 1,
      opacity: 1,
      keyframes: {
        x: [
          { t: 0, v: 0 },
          { t: 3, v: 0.3 },
        ],
      },
    },
  ];
  return p;
}
function prepared(kind = "highlighter"): PreparedTextMark {
  const root = `/cache/text-markers/0123456789abcdef/${kind}/render/`;
  return {
    originKey: "0123456789abcdef",
    video: { path: root + "animation.webm", mediaType: "video", duration: 2, width: 1920, height: 1080 },
    still: { path: root + "frame.png", mediaType: "image", width: 1920, height: 1080 },
  };
}
let sequence = 0;
const uuid = () => `mark-${++sequence}`;
it("adds a transparent animated and held layer without changing source text, preserving motion", () => {
  const p = fixture(),
    original = structuredClone(p);
  const r = applyTextMark(p, "caption", { ...DEFAULT_TEXT_MARK, delay: 0.5 }, prepared(), uuid);
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expectValid(r.project);
  expect(p).toEqual(original);
  const t = r.project.tracks.find((t) => t.name === "Text highlighter")!;
  expect(t.clips).toHaveLength(2);
  expect(t.clips[0].timelineStart).toBe(2.5);
  expect(t.clips[1].timelineStart).toBeCloseTo(3.1);
  expect(t.clips[1].sourceOut).toBeCloseTo(1.9);
  expect(transformAt(t.clips[0], 2.8).x).toBeCloseTo(transformAt(p.tracks[0].clips[0], 2.8).x);
  expect(r.project.assets.slice(-2).every((a) => a.alpha)).toBe(true);
});
it("replaces the same mark while retaining a different mark and original text", () => {
  let p = fixture();
  for (const kind of ["highlighter", "strike", "highlighter"] as const) {
    const r = applyTextMark(p, "caption", { ...DEFAULT_TEXT_MARK, kind }, prepared(kind), uuid);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    p = r.project;
  }
  expect(p.tracks.filter((t) => t.name === "Text highlighter")).toHaveLength(1);
  expect(p.tracks.filter((t) => t.name === "Text strikethrough")).toHaveLength(1);
  expect(p.tracks[0].clips[0].id).toBe("caption");
  expectValid(p);
});
it("validates word ranges and clamps the sweep to remaining text duration", () => {
  const p = fixture();
  expect(textMarkWindow(p, "caption", { ...DEFAULT_TEXT_MARK, delay: 2.8 }).seconds).toBeCloseTo(0.2);
  expect(() => textMarkWindow(p, "caption", { ...DEFAULT_TEXT_MARK, delay: 3 })).toThrow();
  expect(() =>
    textMarkWindow(p, "caption", { ...DEFAULT_TEXT_MARK, wholeText: false, lastWord: 4 }),
  ).toThrow();
  const w = textMarkWindow(p, "caption", {
    ...DEFAULT_TEXT_MARK,
    wholeText: false,
    firstWord: 2,
    lastWord: 3,
  });
  expect([w.firstWord, w.lastWord]).toEqual([1, 2]);
});
it("passes selected words to native rendering and commits the edit through history", async () => {
  useProjectStore.getState().loadProject(fixture(), "/test.cutvii", []);
  vi.mocked(invoke).mockResolvedValue(prepared());
  const r = await createTextMark("caption", {
    ...DEFAULT_TEXT_MARK,
    wholeText: false,
    firstWord: 2,
    lastWord: 3,
  });
  expect(r.ok).toBe(true);
  expect(invoke).toHaveBeenCalledWith(
    "prepare_text_marker",
    expect.objectContaining({ request: expect.objectContaining({ firstWord: 1, lastWord: 2 }) }),
  );
  useProjectStore.getState().undo();
  expect(useProjectStore.getState().project.tracks).toHaveLength(3);
});
it("does not apply a stale render or an aborted operation", async () => {
  useProjectStore.getState().loadProject(fixture(), "/test.cutvii", []);
  vi.mocked(invoke).mockImplementation(async () => {
    useProjectStore.getState().loadProject(fixture(), "/new.cutvii", []);
    return prepared();
  });
  await expect(createTextMark("caption", DEFAULT_TEXT_MARK)).rejects.toThrow("project changed");
  const controller = new AbortController();
  controller.abort();
  await expect(createTextMark("caption", DEFAULT_TEXT_MARK, controller.signal)).rejects.toThrow();
});

it("removes boxes and active-word styling only from the chosen text, atomically with its mark", async () => {
  const p = fixture();
  p.assets.find((a) => a.id === "text")!.text!.box = {
    color: "#FFFF00",
    opacity: 1,
    shape: "rect",
    padding: 0.1,
    radius: 0.1,
  };
  p.tracks[1].clips = [{ ...p.tracks[0].clips[0], id: "other", trackId: "v2" }];
  useProjectStore.getState().loadProject(p, "/test.cutvii", []);
  vi.mocked(invoke).mockImplementation(async (cmd) =>
    cmd === "render_text" ? "/cache/plain.png" : prepared(),
  );
  const r = await createTextMark("caption", { ...DEFAULT_TEXT_MARK, textLook: "plain" });
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expectValid(r.project);
  const target = r.project.tracks[0].clips[0];
  expect(r.project.assets.find((a) => a.id === target.assetId)!.text!.box).toBeUndefined();
  expect(r.project.tracks[1].clips[0].assetId).toBe("text");
  expect(r.project.assets.find((a) => a.id === "text")!.text!.box).toBeDefined();
  expect(invoke).toHaveBeenCalledWith(
    "prepare_text_marker",
    expect.objectContaining({
      request: expect.objectContaining({ spec: expect.not.objectContaining({ box: expect.anything() }) }),
    }),
  );
  useProjectStore.getState().undo();
  expect(useProjectStore.getState().project.tracks[0].clips[0].assetId).toBe("text");
});
it("custom appearance keeps words, size and position while replacing decorative styling", () => {
  const spec = fixture().assets.find((a) => a.id === "text")!.text!;
  const next = textMarkSpec(spec, {
    ...DEFAULT_TEXT_MARK,
    textLook: "custom",
    textStyle: { color: "#FF0000", bold: false },
  });
  expect(next.content).toBe(spec.content);
  expect(next.fontSize).toBe(spec.fontSize);
  expect(next.x).toBe(spec.x);
  expect(next.color).toBe("#FF0000");
  expect(next.box).toBeUndefined();
});
