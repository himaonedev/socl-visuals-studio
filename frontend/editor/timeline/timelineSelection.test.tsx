import { fireEvent, render, screen } from "@testing-library/react";
import { Timeline } from "@/components/layout/Timeline";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useProjectStore } from "@/store/project";
import { useSelectionStore } from "@/store/selection";
import { useTimelineViewStore } from "@/store/timelineView";
import { useTrackLocksStore } from "@/store/trackLocks";
import { usePlaybackStore } from "@/store/playback";
import { makeProject, IDS } from "@/test/makeProject";
import { addClip } from "./edit";
import { defaultTextSpec } from "./text";
import { selectTimelineClip, selectTimelineKind } from "./timelineSelection";
import { useEditorShortcuts } from "./useEditorShortcuts";
function fixture() {
  let p = makeProject();
  p.assets.push({
    id: "caption",
    path: "/m/caption.png",
    type: "image",
    width: 1920,
    height: 1080,
    text: defaultTextSpec(1080),
  });
  for (const [id, assetId, trackId, start, duration] of [
    ["a", IDS.vid, IDS.v1, 0, 1],
    ["b", IDS.vid, IDS.v1, 2, 1],
    ["c", IDS.vid, IDS.v1, 4, 1],
    ["text", "caption", IDS.v2, 1, 2],
    ["audio", IDS.aud, IDS.a1, 0, 4],
  ] as const) {
    const result = addClip(p, { id, assetId, trackId, start, duration });
    if (!result.ok) throw new Error(result.error.message);
    p = result.project;
  }
  return p;
}
const selected = () => useSelectionStore.getState().selectedClipIds;
function Bindings() {
  useEditorShortcuts();
  return null;
}
function setup() {
  return render(
    <TooltipProvider>
      <Bindings />
      <Timeline />
    </TooltipProvider>,
  );
}
beforeEach(() => {
  useProjectStore.getState().loadProject(fixture(), "/test.cutvii", []);
  useSelectionStore.setState({
    selectedClipIds: [],
    clipAnchor: null,
    selectedAssetIds: [],
    area: "timeline",
  });
  useTimelineViewStore.setState({ pps: 50, snapping: false, trackHeights: {} });
  useTrackLocksStore.setState({ locks: {} });
  usePlaybackStore.setState({ playhead: 0, playing: false });
});
it("supports Ctrl toggling and stable Shift ranges including Ctrl+Shift extension", () => {
  const p = useProjectStore.getState().project;
  selectTimelineClip(p, "a");
  selectTimelineClip(p, "c", { shiftKey: true });
  expect(selected()).toEqual(["a", "b", "c"]);
  selectTimelineClip(p, "b", { shiftKey: true });
  expect(selected()).toEqual(["a", "b"]);
  selectTimelineClip(p, "text", { ctrlKey: true });
  expect(selected()).toContain("text");
  selectTimelineClip(p, "text", { metaKey: true });
  expect(selected()).not.toContain("text");
  selectTimelineClip(p, "c", { ctrlKey: true, shiftKey: true });
  expect(selected()).toEqual(["a", "b", "c"]);
});
it("selects generated text, video, audio or all clips without changing the project", () => {
  const p = useProjectStore.getState().project;
  selectTimelineKind(p, "text");
  expect(selected()).toEqual(["text"]);
  selectTimelineKind(p, "video");
  expect(selected()).toEqual(["a", "b", "c"]);
  selectTimelineKind(p, "audio");
  expect(selected()).toEqual(["audio"]);
  selectTimelineKind(p, "all");
  expect(selected()).toHaveLength(5);
  selectTimelineKind(p, "clear");
  expect(selected()).toEqual([]);
  expect(useProjectStore.getState().project).toBe(p);
  expect(useProjectStore.getState().past).toHaveLength(0);
});
it("Ctrl-click focuses the timeline so Ctrl+A selects clips; input Ctrl+A stays native", () => {
  const { container } = setup();
  const clips = container.querySelectorAll('[data-track-id="v1"] [data-clip-id]');
  fireEvent.pointerDown(clips[0], { button: 0, ctrlKey: true });
  fireEvent.pointerDown(clips[2], { button: 0, ctrlKey: true });
  expect(selected()).toEqual(["a", "c"]);
  expect(clips[2]).toHaveFocus();
  fireEvent.keyDown(clips[2], { key: "a", ctrlKey: true });
  expect(selected()).toHaveLength(5);
  useSelectionStore.getState().clear();
  const input = document.createElement("input");
  document.body.append(input);
  input.focus();
  fireEvent.keyDown(input, { key: "a", ctrlKey: true });
  expect(selected()).toEqual([]);
  input.remove();
});
it("supports Shift range through pointer and keyboard and toolbar text selection", () => {
  const { container } = setup();
  const clips = container.querySelectorAll('[data-track-id="v1"] [data-clip-id]');
  fireEvent.pointerDown(clips[0], { button: 0, ctrlKey: true });
  fireEvent.pointerDown(clips[2], { button: 0, shiftKey: true });
  expect(selected()).toEqual(["a", "b", "c"]);
  fireEvent.keyDown(clips[1], { key: "Enter", shiftKey: true });
  expect(selected()).toEqual(["a", "b"]);
  fireEvent.change(screen.getByLabelText("Select timeline clips"), { target: { value: "text" } });
  expect(selected()).toEqual(["text"]);
});
it("box-selects project clips and Escape restores the original selection", () => {
  const { container } = setup();
  const lane = screen.getByRole("group", { name: "Video 1 lane" });
  fireEvent.pointerDown(lane, { button: 0, pointerId: 1, clientX: 60, clientY: 10 });
  fireEvent.pointerMove(window, { pointerId: 1, clientX: 260, clientY: 50 });
  fireEvent.pointerUp(window, { pointerId: 1, clientX: 260, clientY: 50 });
  expect(selected()).toEqual(["b", "c"]);
  fireEvent.pointerDown(lane, { button: 0, pointerId: 2, clientX: 0, clientY: 10 });
  fireEvent.pointerMove(window, { pointerId: 2, clientX: 60, clientY: 50 });
  fireEvent.keyDown(window, { key: "Escape" });
  expect(selected()).toEqual(["b", "c"]);
  expect(container.querySelector('[data-testid="timeline-selection-box"]')).toBeNull();
});
