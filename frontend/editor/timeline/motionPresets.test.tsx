import { act, fireEvent, render, screen } from "@testing-library/react";
import { MotionPresetsPanel } from "@/components/inspector/MotionPresetsPanel";
import { type Project, type TimelineClip, TRANSFORM_LIMITS } from "@/project/model";
import { useProjectStore } from "@/store/project";
import { usePlaybackStore } from "@/store/playback";
import { expectValid, IDS, makeProject } from "@/test/makeProject";
import { addClip } from "./edit";
import { MOTION_PRESETS, setTextMotionOnTrack, setMotionPreset } from "./motionPresets";
import { transformAt } from "./transform";
import { addTextClip, defaultTextSpec } from "./text";

function video(patch: Partial<TimelineClip> = {}): Project {
  const result = addClip(makeProject(), { assetId: IDS.vid, trackId: IDS.v1, id: "clip", start: 2 });
  if (!result.ok) throw new Error(result.error.message);
  result.project.tracks[0].clips[0] = { ...result.project.tracks[0].clips[0], ...patch };
  return result.project;
}
const clipOf = (p: Project) => p.tracks.flatMap((t) => t.clips).find((c) => c.id === "clip")!;
const ok = (result: ReturnType<typeof setMotionPreset>) => {
  if (!result.ok) throw new Error(result.error.message);
  expectValid(result.project);
  return result.project;
};

describe("motion presets", () => {
  it("punches at the playhead and returns to the base scale without moving other properties", () => {
    const p = video({ x: 0.1, scale: 1.2, keyframes: { rotation: [{ t: 0, v: 5 }] } });
    const next = ok(setMotionPreset(p, "clip", "punch-in", "dynamic", 5, 2));
    const c = clipOf(next);
    expect(transformAt(c, 4).scale).toBeCloseTo(1.2);
    expect(transformAt(c, 5.5).scale).toBeCloseTo(1.5);
    expect(transformAt(c, 7.5).scale).toBeCloseTo(1.2);
    expect(c.x).toBe(0.1);
    expect(c.keyframes!.rotation).toEqual(p.tracks[0].clips[0].keyframes!.rotation);
    expect(clipOf(p).keyframes!.scale).toBeUndefined();
  });

  it("maps trim, speed and reverse into the same visible timeline motion", () => {
    for (const reversed of [false, true]) {
      const c = clipOf(
        ok(
          setMotionPreset(
            video({ sourceIn: 2, sourceOut: 8, speed: 2, reversed }),
            "clip",
            "punch-in",
            "subtle",
            3,
            1,
          ),
        ),
      );
      expect(transformAt(c, 2).scale).toBeCloseTo(1);
      expect(transformAt(c, 3.3).scale).toBeCloseTo(1.12);
      expect(transformAt(c, 4.5).scale).toBeCloseTo(1);
    }
  });

  it("clamps late punch-ins to the clip and zoom intensity to the schema bounds", () => {
    const c = clipOf(ok(setMotionPreset(video({ scale: 3.8 }), "clip", "punch-in", "dynamic", 999, 2)));
    expect(transformAt(c, 11).scale).toBe(TRANSFORM_LIMITS.maxScale);
    expect(c.keyframes!.scale!.every((key) => key.t >= 0 && key.t <= 10)).toBe(true);
    const push = clipOf(ok(setMotionPreset(video(), "clip", "slow-push", "subtle", 0)));
    expect(transformAt(push, 2).scale).toBe(1);
    expect(transformAt(push, 12).scale).toBeCloseTo(1.1);
  });

  it("animates text entrance and exit and rejects applying text motion to video", () => {
    const p = makeProject();
    const added = addTextClip(p, {
      picture: "/m/title.png",
      spec: defaultTextSpec(p.settings.height),
      start: 0,
      assetId: "title",
      clipId: "clip",
      trackId: "title-track",
    });
    if (!added.ok) throw new Error(added.error.message);
    const c = clipOf(ok(setMotionPreset(added.project, "clip", "text-pop", "dynamic", 0)));
    expect(transformAt(c, 0).opacity).toBe(0);
    expect(transformAt(c, 0.5).opacity).toBe(1);
    expect(transformAt(c, c.sourceOut).opacity).toBe(0);
    expect(c.keyframes!.y).toBeDefined();
    expect(setMotionPreset(video(), "clip", "text-pop", "subtle", 0).ok).toBe(false);
    expect(setMotionPreset(video({ sourceOut: 0.05 }), "clip", "punch-in", "subtle", 0).ok).toBe(false);
  });

  it("offers style and intensity controls and applies the entire motion as one undo step", () => {
    const p = video();
    useProjectStore.setState({ project: p, past: [], future: [] });
    usePlaybackStore.setState({ playhead: 5 });
    render(<MotionPresetsPanel clip={clipOf(p)} />);
    fireEvent.change(screen.getByLabelText("Motion style"), { target: { value: "slow-push" } });
    fireEvent.change(screen.getByLabelText("Intensity"), { target: { value: "dynamic" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply motion" }));
    expect(useProjectStore.getState().past).toHaveLength(1);
    expect(transformAt(clipOf(useProjectStore.getState().project), 12).scale).toBeCloseTo(1.25);
    act(() => useProjectStore.getState().undo());
    expect(useProjectStore.getState().project).toBe(p);
  });
});

function textProject(patch: Partial<TimelineClip> = {}): Project {
  const p = makeProject();
  const result = addTextClip(p, {
    picture: "/m/title.png",
    spec: defaultTextSpec(p.settings.height),
    start: 2,
    assetId: "title",
    clipId: "clip",
    trackId: "title-track",
  });
  if (!result.ok) throw new Error(result.error.message);
  const c = clipOf(result.project);
  Object.assign(c, { sourceOut: 3 }, patch);
  return result.project;
}
describe("smooth text motion", () => {
  it.each(MOTION_PRESETS.filter((p) => p.text && p.id !== "text-pop"))(
    "eases $name into the original position without overshoot",
    ({ id }) => {
      const p = textProject({
        x: 0.1,
        y: 0.2,
        scale: 1.2,
        opacity: 0.8,
        keyframes: { rotation: [{ t: 0, v: 8 }] },
      });
      const c = clipOf(ok(setMotionPreset(p, "clip", id, "subtle", 2, 0.6)));
      expect(transformAt(c, 2).opacity).toBe(0);
      expect(transformAt(c, 3)).toMatchObject({ x: 0.1, y: 0.2, scale: 1.2, opacity: 0.8, rotation: 8 });
      expect(transformAt(c, 5).opacity).toBe(0);
      const initial = transformAt(c, 2),
        mid = transformAt(c, 2.3),
        base = transformAt(c, 2.6);
      if (id === "slide-left" || id === "slide-right") {
        expect(Math.abs(mid.x - base.x)).toBeLessThan(Math.abs(initial.x - base.x) * 0.2);
        expect(initial.x < base.x).toBe(id === "slide-left");
      } else if (id !== "apple-scale") {
        expect(Math.abs(mid.y - base.y)).toBeLessThan(Math.abs(initial.y - base.y) * 0.2);
        expect(initial.y < base.y).toBe(id === "slide-top");
      }
      expect(c.keyframes!.scale!.length).toBeLessThanOrEqual(64);
      expect(c.keyframes!.rotation).toEqual([{ t: 0, v: 8 }]);
    },
  );
  it("preserves timing through trimmed, sped-up and reversed text", () => {
    for (const reversed of [false, true]) {
      const c = clipOf(
        ok(
          setMotionPreset(
            textProject({ sourceIn: 0.5, sourceOut: 2.5, speed: 2, reversed }),
            "clip",
            "slide-bottom",
            "dynamic",
            2,
            0.45,
          ),
        ),
      );
      expect(transformAt(c, 2).opacity).toBe(0);
      expect(transformAt(c, 2.5)).toMatchObject({ x: 0, y: 0, scale: 1, opacity: 1 });
      expect(transformAt(c, 3).opacity).toBe(0);
      expect(c.keyframes!.y!.every((k) => k.t >= 0.5 && k.t <= 2.5)).toBe(true);
    }
  });
  it("fits short subtitles and removes stale direction keys when switching styles", () => {
    const p = textProject({ sourceOut: 0.2 });
    const first = ok(setMotionPreset(p, "clip", "slide-left", "dynamic", 2, 2));
    const c = clipOf(ok(setMotionPreset(first, "clip", "apple-rise", "subtle", 2, 2)));
    expect(transformAt(c, 2.1).opacity).toBe(1);
    expect(c.keyframes!.x!.every((k) => k.v === c.x)).toBe(true);
    expect(
      clipOf(ok(setMotionPreset(first, "clip", "text-pop", "subtle", 2, 0.3))).keyframes!.x!.every(
        (k) => k.v === 0,
      ),
    ).toBe(true);
  });
  it("applies a subtitle track in one Undo while skipping non-text and very short clips", () => {
    const p = textProject();
    const track = p.tracks.find((t) => t.id === clipOf(p).trackId)!;
    track.clips.push(
      { ...track.clips[0], id: "second", timelineStart: 5 },
      { ...track.clips[0], id: "short", timelineStart: 8, sourceOut: 0.05 },
    );
    const unchanged = p.tracks[0];
    const result = ok(setTextMotionOnTrack(p, track.id, "slide-right", "subtle", 0.45));
    expect(result.tracks.find((t) => t.id === track.id)!.clips[1].keyframes!.x).toBeDefined();
    expect(result.tracks.find((t) => t.id === track.id)!.clips[2]).toBe(track.clips[2]);
    expect(result.tracks[0]).toBe(unchanged);
    useProjectStore.getState().loadProject(p, "/test.cutvii", []);
    render(<MotionPresetsPanel clip={track.clips[0]} text />);
    fireEvent.change(screen.getByLabelText("Motion style"), { target: { value: "slide-right" } });
    fireEvent.click(screen.getByLabelText("Apply to all text / subtitle clips on this track"));
    fireEvent.click(screen.getByRole("button", { name: "Apply text motion to track" }));
    expect(useProjectStore.getState().past).toHaveLength(1);
    act(() => useProjectStore.getState().undo());
    expect(useProjectStore.getState().project).toBe(p);
  });
});
