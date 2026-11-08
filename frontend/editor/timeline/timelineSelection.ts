import type { Project } from "@/project/model";
import { useSelectionStore } from "@/store/selection";
import { layerLayout } from "./layerLayout";

export type ClipSelectionKind = "all" | "text" | "video" | "audio" | "image" | "clear";
export function selectTimelineKind(project: Project, kind: ClipSelectionKind) {
  const assets = new Map(project.assets.map((a) => [a.id, a]));
  const ids = project.tracks.flatMap((t) =>
    t.clips
      .filter((c) => {
        const a = assets.get(c.assetId);
        return (
          kind === "all" ||
          (kind === "text" && !!a?.text) ||
          (kind === "audio" && (t.type === "audio" || a?.type === "audio")) ||
          (kind === "video" && t.type === "video" && a?.type === "video") ||
          (kind === "image" && a?.type === "image" && !a.text)
        );
      })
      .map((c) => c.id),
  );
  useSelectionStore.getState().setSelection(kind === "clear" ? [] : ids);
  useSelectionStore.getState().setArea("timeline");
}
export function selectTimelineClip(
  project: Project,
  id: string,
  modifiers: { shiftKey?: boolean; ctrlKey?: boolean; metaKey?: boolean } = {},
) {
  const selection = useSelectionStore.getState();
  const order = layerLayout(project.tracks).tracks.flatMap((t) =>
    [...t.clips]
      .sort((a, b) => a.timelineStart - b.timelineStart || a.id.localeCompare(b.id))
      .map((c) => c.id),
  );
  if (!order.includes(id)) return;
  const toggle = !!(modifiers.ctrlKey || modifiers.metaKey);
  if (modifiers.shiftKey) {
    const anchor =
      selection.clipAnchor &&
      selection.selectedClipIds.includes(selection.clipAnchor) &&
      order.includes(selection.clipAnchor)
        ? selection.clipAnchor
        : (selection.selectedClipIds.find((c) => order.includes(c)) ?? id);
    const a = order.indexOf(anchor),
      b = order.indexOf(id);
    const range = order.slice(Math.min(a, b), Math.max(a, b) + 1);
    useSelectionStore.setState({
      selectedClipIds: toggle ? [...new Set([...selection.selectedClipIds, ...range])] : range,
      clipAnchor: anchor,
      area: "timeline",
    });
  } else selection.select(id, toggle);
}
