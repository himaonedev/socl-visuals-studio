import { layersAt } from "@/playback/engine";
import { fireEvent, render, screen, act } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { FreezeHighlightPanel } from "@/components/inspector/FreezeHighlightPanel";
import { CaptionEffectRangePanel } from "@/components/inspector/CaptionEffectRangePanel";
import {
  DEFAULT_EFFECT_SUBTITLE_STYLE,
  prepareEffectSubtitles,
  applyEffectSubtitles,
} from "./effectSubtitles";
import { createFreezeHighlight, DEFAULT_FREEZE_HIGHLIGHT } from "./freezeHighlight";
import { useProjectStore } from "@/store/project";
import { usePlaybackStore } from "@/store/playback";
import { useTrackLocksStore, trackLockKey } from "@/store/trackLocks";
import { makeProject, IDS, expectValid } from "@/test/makeProject";
import { defaultTextSpec } from "./text";
import { DEFAULT_WORD_HIGHLIGHT } from "./wordCaptions";
import { findClip, clipEnd } from "./clips";
import { transformAt } from "./transform";
import type { TimelineClip } from "@/project/model";
function fixture() {
  const p = makeProject();
  const base: TimelineClip = {
    id: "video",
    assetId: IDS.vid,
    trackId: IDS.v1,
    timelineStart: 0,
    sourceIn: 0,
    sourceOut: 8,
    x: 0,
    y: 0,
    scale: 1,
    opacity: 1,
    volume: 1,
  };
  p.tracks[0].clips = [base];
  p.tracks[1].name = "Subtitles";
  const text = {
    ...defaultTextSpec(1080),
    content: "bahwa pernikahan adalah ujian",
    highlight: { color: "#000000", lines: "last" as const, word: { ...DEFAULT_WORD_HIGHLIGHT, index: 1 } },
    box: { color: "#000000", opacity: 0.8, shape: "rect" as const, padding: 0.1, radius: 0.15 },
  };
  p.assets.push({ id: "caption", path: "/m/caption.png", type: "image", text, width: 1920, height: 1080 });
  p.tracks[1].clips = [
    {
      ...base,
      id: "caption",
      assetId: "caption",
      trackId: IDS.v2,
      timelineStart: 1,
      sourceIn: 1,
      sourceOut: 5,
      volume: 0,
      keyframes: {
        x: [
          { t: 1, v: 0 },
          { t: 5, v: 0.2 },
        ],
      },
    },
  ];
  p.tracks.push({
    id: "translation",
    name: "Translation",
    type: "video",
    order: 3,
    hidden: false,
    muted: false,
    clips: [{ ...p.tracks[1].clips[0], id: "translation", trackId: "translation" }],
  });
  return p;
}
const override = { trackIds: [IDS.v2], style: DEFAULT_EFFECT_SUBTITLE_STYLE };
beforeEach(() => {
  useProjectStore.getState().loadProject(fixture(), "/test.cutvii", []);
  usePlaybackStore.setState({ playhead: 2, playing: false });
  useTrackLocksStore.setState({ locks: {} });
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation(async (cmd) =>
    cmd === "render_text"
      ? "/cache/effect-text.png"
      : cmd === "prepare_freeze_highlight"
        ? {
            image: { path: "/cache/freeze.png", mediaType: "image", width: 1920, height: 1080 },
            audio: null,
            hasAudio: true,
          }
        : undefined,
  );
});
it("switches only inside the effect, restores original assets afterwards and preserves active word/motion", async () => {
  const p = fixture(),
    original = p.tracks[1].clips[0],
    originalAsset = p.assets.find((a) => a.id === "caption")!;
  const plans = await prepareEffectSubtitles(p, 2, 4, override);
  expect(plans).toHaveLength(1);
  expect(plans[0].parts[0].asset.text!.highlight!.word!.index).toBe(1);
  const r = applyEffectSubtitles(p, plans);
  if (!r.ok) throw new Error(r.error.message);
  expectValid(r.project);
  const captions = r.project.tracks.find((t) => t.id === IDS.v2)!.clips;
  expect(captions.map((c) => [c.timelineStart, clipEnd(c)])).toEqual([
    [1, 2],
    [2, 4],
    [4, 5],
  ]);
  expect(captions.map((c) => c.assetId)).toEqual(["caption", plans[0].parts[0].asset.id, "caption"]);
  expect(r.project.assets.find((a) => a.id === "caption")).toBe(originalAsset);
  for (const [i, t] of [
    [0, 1.5],
    [1, 3],
    [2, 4.5],
  ] as const)
    expect(transformAt(captions[i], t)).toEqual(transformAt(original, t));
  expect(r.project.tracks.find((t) => t.id === "translation")).toBe(
    p.tracks.find((t) => t.id === "translation"),
  );
});
it.each([false, true])(
  "splits trimmed/speed-adjusted subtitle source times correctly, reverse=%s",
  async (reversed) => {
    const p = fixture(),
      c = p.tracks[1].clips[0];
    Object.assign(c, { sourceIn: 2, sourceOut: 10, speed: 2, reversed });
    const plans = await prepareEffectSubtitles(p, 2, 4, override),
      r = applyEffectSubtitles(p, plans);
    if (!r.ok) throw new Error(r.error.message);
    expectValid(r.project);
    const clips = r.project.tracks[1].clips;
    expect(clips.map((c) => [c.sourceIn, c.sourceOut])).toEqual(
      reversed
        ? [
            [8, 10],
            [4, 8],
            [2, 4],
          ]
        : [
            [2, 4],
            [4, 8],
            [8, 10],
          ],
    );
  },
);
it("retains exact existing word intervals and uses estimates only for originally plain captions", async () => {
  const p = fixture();
  delete p.assets.find((a) => a.id === "caption")!.text!.highlight;
  const plans = await prepareEffectSubtitles(p, 1, 5, override);
  expect(plans[0].parts.map((p) => p.asset.text!.highlight!.word!.index)).toEqual([0, 1, 2, 3]);
  expect(plans[0].parts.every((p) => p.asset.text!.content === "bahwa pernikahan adalah ujian")).toBe(true);
  const r = applyEffectSubtitles(p, plans);
  if (!r.ok) throw new Error(r.error.message);
  expectValid(r.project);
  expect(r.project.tracks[1].clips.reduce((sum, c) => sum + clipEnd(c) - c.timelineStart, 0)).toBeCloseTo(4);
});
it("applies video and subtitles together in a single Undo", async () => {
  const before = useProjectStore.getState().project;
  const result = await createFreezeHighlight("video", 2, DEFAULT_FREEZE_HIGHLIGHT, { subtitles: override });
  expect(result.ok).toBe(true);
  expectValid(useProjectStore.getState().project);
  expect(useProjectStore.getState().past).toHaveLength(1);
  expect(useProjectStore.getState().project.tracks[1].clips).toHaveLength(3);
  act(() => useProjectStore.getState().undo());
  expect(useProjectStore.getState().project).toBe(before);
});
it("does not apply partial changes when drawing fails, a subtitle is locked or no captions overlap", async () => {
  const p = useProjectStore.getState().project;
  useTrackLocksStore.setState({ locks: { [trackLockKey(p.id, IDS.v2)]: true } });
  await expect(
    createFreezeHighlight("video", 2, DEFAULT_FREEZE_HIGHLIGHT, { subtitles: override }),
  ).rejects.toThrow(/locked/);
  useTrackLocksStore.setState({ locks: {} });
  await expect(prepareEffectSubtitles(p, 6, 7, override)).rejects.toThrow(/No subtitles overlap/);
  vi.mocked(invoke).mockRejectedValue(new Error("Cannot draw"));
  await expect(
    createFreezeHighlight("video", 2, DEFAULT_FREEZE_HIGHLIGHT, { subtitles: override }),
  ).rejects.toThrow(/Cannot draw/);
  expect(useProjectStore.getState().project).toBe(p);
  expect(useProjectStore.getState().past).toHaveLength(0);
});
it("rejects stale or cancelled subtitle preparation before starting the video job", async () => {
  const before = useProjectStore.getState().project,
    controller = new AbortController();
  vi.mocked(invoke).mockImplementation(async () => {
    controller.abort();
    return "/cache/text.png";
  });
  await expect(
    createFreezeHighlight("video", 2, DEFAULT_FREEZE_HIGHLIGHT, {
      subtitles: override,
      signal: controller.signal,
    }),
  ).rejects.toThrow();
  expect(invoke).not.toHaveBeenCalledWith("prepare_freeze_highlight", expect.anything());
  expect(useProjectStore.getState().project).toBe(before);
  vi.mocked(invoke).mockImplementation(async () => {
    useProjectStore.setState({ project: { ...before, name: "Changed" } });
    return "/cache/text.png";
  });
  await expect(
    createFreezeHighlight("video", 2, DEFAULT_FREEZE_HIGHLIGHT, { subtitles: override }),
  ).rejects.toThrow(/project changed/i);
  expect(useProjectStore.getState().past).toHaveLength(0);
});
it("offers track choice and customization in Edit's effect-range panel", () => {
  render(<CaptionEffectRangePanel />);
  fireEvent.click(screen.getByRole("checkbox", { name: "Subtitle style during effect" }));
  expect(screen.getByLabelText("Effect subtitle preset")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Customize effect subtitle" }));
  expect(screen.getByRole("group", { name: "Style editor" })).toBeInTheDocument();
  expect(screen.queryByLabelText("Fade in and out (s)")).not.toBeInTheDocument();
  expect(screen.queryByLabelText("Words per caption")).not.toBeInTheDocument();
});

it("keeps caption styling out of the visual Effects panel", () => {
  render(<FreezeHighlightPanel clip={findClip(useProjectStore.getState().project, 'video')!.clip} />);
  expect(screen.queryByRole('checkbox', { name: 'Subtitle style during effect' })).not.toBeInTheDocument();
});

it("does not keep the Halftone caption underneath the next normal caption's entrance transition", async () => {
  const p = fixture(),
    caption = p.tracks[1].clips[0];
  p.tracks = p.tracks.filter((t) => t.id !== "translation");
  p.tracks[1].clips.push({
    ...caption,
    id: "next-caption",
    timelineStart: 5,
    sourceIn: 0,
    sourceOut: 2,
    transitionIn: { kind: "dissolve", duration: 0.5 },
  });
  const plans = await prepareEffectSubtitles(p, 2, 5, override),
    result = applyEffectSubtitles(p, plans);
  if (!result.ok) throw new Error(result.error.message);
  const visibleText = (time: number) =>
    layersAt(result.project, time, 0).filter((l) => l.visible && l.asset.text);
  expect(visibleText(4.99)).toHaveLength(1);
  expect(visibleText(5)).toHaveLength(1);
  expect(visibleText(5.1).map((l) => l.clip.id)).toEqual(["next-caption"]);
});
