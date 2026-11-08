import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { Inspector } from "@/components/layout/Inspector";
import { MotionPresetsPanel } from "@/components/inspector/MotionPresetsPanel";
import { useProjectStore } from "@/store/project";
import { useSelectionStore } from "@/store/selection";
import { useTrackLocksStore, trackLockKey } from "@/store/trackLocks";
import { useUiStore } from "@/store/ui";
import { makeProject, expectValid, IDS } from "@/test/makeProject";
import { addTextClip, defaultTextSpec } from "./text";
import { findClip } from "./clips";
import { transformAt } from "./transform";
import { setMotionPreset } from "./motionPresets";
import {
  captureTextMotion,
  copyTextMotion,
  pasteTextMotion,
  pasteMotionToSelectedText,
  useTextMotionClipboard,
} from "./textMotionClipboard";
import type { Project } from "@/project/model";
function fixture(): Project {
  let p = makeProject();
  for (const [id, start] of [
    ["source", 0],
    ["target", 6],
    ["other", 12],
  ] as const) {
    const r = addTextClip(p, {
      picture: `/m/${id}.png`,
      spec: { ...defaultTextSpec(1080), content: id },
      start,
      assetId: `${id}-asset`,
      clipId: id,
      trackId: `${id}-track`,
    });
    if (!r.ok) throw new Error(r.error.message);
    p = r.project;
  }
  findClip(p, "source")!.clip.sourceOut = 3;
  findClip(p, "target")!.clip.sourceOut = 5;
  findClip(p, "other")!.clip.sourceOut = 2;
  const r = setMotionPreset(p, "source", "apple-rise", "subtle", 0, 0.45);
  if (!r.ok) throw new Error(r.error.message);
  return r.project;
}
beforeEach(() => {
  useProjectStore.getState().loadProject(fixture(), "/test.cutvii", []);
  useTextMotionClipboard.setState({ motion: null });
  useTrackLocksStore.setState({ locks: {} });
  useSelectionStore.setState({ selectedClipIds: [], clipAnchor: null });
  useUiStore.setState({ sidePanel: "inspector", inspectorTab: {}, notice: null });
});
it("copies keyframes independently without editing or adding Undo history", () => {
  const p = useProjectStore.getState().project;
  expect(copyTextMotion("source").ok).toBe(true);
  expect(useProjectStore.getState().project).toBe(p);
  expect(useProjectStore.getState().past).toHaveLength(0);
  const motion = useTextMotionClipboard.getState().motion!;
  const old = JSON.stringify(motion);
  findClip(p, "source")!.clip.keyframes!.y![0].v = 1;
  expect(JSON.stringify(motion)).toBe(old);
  expect(captureTextMotion(p, "target")).toBeNull();
});
it.each([false, true])(
  "fits copied motion through target trim/speed/reverse=%s and preserves base transform and text",
  (reversed) => {
    const p = useProjectStore.getState().project,
      motion = captureTextMotion(p, "source")!;
    const target = findClip(p, "target")!.clip;
    Object.assign(target, {
      sourceIn: 1,
      sourceOut: 5,
      speed: 2,
      reversed,
      x: 0.2,
      y: 0.3,
      scale: 1.5,
      opacity: 0.6,
    });
    const r = pasteTextMotion(p, ["target"], motion);
    if (!r.ok) throw new Error(r.error.message);
    expectValid(r.project);
    const c = findClip(r.project, "target")!.clip;
    expect(transformAt(c, 6).opacity).toBe(0);
    expect(transformAt(c, 7)).toMatchObject({ x: 0.2, y: 0.3, scale: 1.5, opacity: 0.6 });
    expect(transformAt(c, 8).opacity).toBe(0);
    expect(r.project.assets).toBe(p.assets);
    expect(c).toMatchObject({ sourceIn: 1, sourceOut: 5, timelineStart: 6, speed: 2, reversed });
    expect(findClip(r.project, "other")!.clip).toBe(findClip(p, "other")!.clip);
  },
);
it("pastes onto multiple selected texts in one Undo and ignores video/audio", () => {
  const before = useProjectStore.getState().project;
  expect(copyTextMotion("source").ok).toBe(true);
  expect(pasteMotionToSelectedText(["target", "other", "missing"]).ok).toBe(true);
  expect(useProjectStore.getState().past).toHaveLength(1);
  for (const id of ["target", "other"])
    expect(findClip(useProjectStore.getState().project, id)!.clip.keyframes?.opacity).toBeDefined();
  useProjectStore.getState().undo();
  expect(useProjectStore.getState().project).toBe(before);
});
it("respects locked tracks and leaves the full selection unchanged on failure", () => {
  const p = useProjectStore.getState().project;
  copyTextMotion("source");
  const track = findClip(p, "target")!.track;
  useTrackLocksStore.setState({ locks: { [trackLockKey(p.id, track.id)]: true } });
  expect(pasteMotionToSelectedText(["target", "other"]).ok).toBe(false);
  expect(useProjectStore.getState().project).toBe(p);
  expect(useProjectStore.getState().past).toHaveLength(0);
});
it("offers Copy/Paste on single text and motion editing directly on a mixed selection", () => {
  const p = useProjectStore.getState().project;
  const clip = findClip(p, "source")!.clip;
  const single = render(<MotionPresetsPanel clip={clip} text />);
  fireEvent.click(screen.getByRole("button", { name: "Copy Motion" }));
  expect(useTextMotionClipboard.getState().motion).not.toBeNull();
  single.unmount();
  const asset = p.assets.find((a) => a.id === IDS.vid)!;
  const video = {
    ...clip,
    id: "video",
    assetId: asset.id,
    trackId: IDS.v1,
    timelineStart: 20,
    sourceIn: 0,
    sourceOut: 2,
    keyframes: undefined,
  };
  p.tracks.find((t) => t.id === IDS.v1)!.clips.push(video);
  useSelectionStore.getState().setSelection(["target", "other", "video"]);
  render(<Inspector />);
  const section = screen.getByRole("region", { name: "Selected text motion" });
  expect(within(section).getByRole("button", { name: "Paste Motion" })).toBeEnabled();
  fireEvent.click(within(section).getByRole("button", { name: "Paste Motion" }));
  expect(findClip(useProjectStore.getState().project, "video")!.clip).toBe(video);
  expect(useProjectStore.getState().past).toHaveLength(1);
  fireEvent.change(within(section).getByLabelText("Motion style"), { target: { value: "slide-left" } });
  fireEvent.click(within(section).getByRole("button", { name: "Apply motion to selected text" }));
  expect(useProjectStore.getState().past).toHaveLength(2);
  expectValid(useProjectStore.getState().project);
  act(() => useProjectStore.getState().undo());
});
