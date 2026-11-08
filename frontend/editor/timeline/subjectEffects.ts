import { invoke } from "@tauri-apps/api/core";
import type { MediaAsset, Project, TextSpec, TimelineClip } from "@/project/model";
import { findClip, clipDuration } from "./clips";
import type { EditResult } from "./edit";
import { applyUpscaledVideo } from "./upscale";
import { defaultTextSpec } from "./text";

export type SubjectMode = "remove" | "blur" | "behind";
export interface SubjectVideo {
  path: string;
  width: number;
  height: number;
  duration: number;
  alpha: boolean;
}

export function applySubjectVideo(
  project: Project,
  clipId: string,
  video: SubjectVideo,
  assetId: string,
): EditResult {
  const changed = applyUpscaledVideo(project, clipId, video, assetId);
  if (!changed.ok) return changed;
  const generated = changed.project.assets.find((a) => a.path === video.path)!;
  return {
    ok: true,
    project: {
      ...changed.project,
      assets: changed.project.assets.map((a) =>
        a.id === generated.id ? { ...a, alpha: video.alpha || undefined } : a,
      ),
      tracks: changed.project.tracks.map((t) => ({
        ...t,
        clips: t.clips.map((c) =>
          c.id === clipId && video.alpha && c.fitMode === "blur-bg" ? { ...c, fitMode: "fit" } : c,
        ),
      })),
    },
  };
}

export function addTextBehindSubject(
  project: Project,
  clipId: string,
  video: SubjectVideo,
  title: { path: string; spec: TextSpec },
  ids: {
    asset: string;
    titleAsset: string;
    titleTrack: string;
    subjectTrack: string;
    titleClip: string;
    subjectClip: string;
  },
): EditResult {
  const found = findClip(project, clipId);
  if (!found)
    return { ok: false, error: { code: "unknown-clip", message: "The source clip no longer exists" } };
  const generated = applySubjectVideo(project, clipId, { ...video, alpha: true }, ids.asset);
  if (!generated.ok) return generated;
  const subject = findClip(generated.project, clipId)!.clip;
  const titleAsset: MediaAsset = {
    id: ids.titleAsset,
    path: title.path,
    type: "image",
    width: project.settings.width,
    height: project.settings.height,
    text: title.spec,
  };
  const caption: TimelineClip = {
    id: ids.titleClip,
    assetId: titleAsset.id,
    trackId: ids.titleTrack,
    timelineStart: found.clip.timelineStart,
    sourceIn: 0,
    sourceOut: Math.min(3, clipDuration(subject)),
    x: 0,
    y: 0,
    scale: 1,
    opacity: 1,
    volume: 0,
  };
  return {
    ok: true,
    project: {
      ...project,
      assets: [...generated.project.assets, titleAsset],
      tracks: [
        ...project.tracks.map((track) => ({
          ...track,
          order: track.order > found.track.order ? track.order + 2 : track.order,
        })),
        {
          id: ids.titleTrack,
          name: "Behind-subject title",
          type: "video",
          order: found.track.order + 1,
          hidden: false,
          muted: false,
          clips: [caption],
        },
        {
          id: ids.subjectTrack,
          name: "Subject cut-out",
          type: "video",
          order: found.track.order + 2,
          hidden: false,
          muted: true,
          clips: [{ ...subject, id: ids.subjectClip, trackId: ids.subjectTrack, muted: true }],
        },
      ],
    },
  };
}

export async function prepareSubjectEffect(
  clipId: string,
  mode: SubjectMode,
  blur: number,
  title: string,
): Promise<EditResult> {
  const { useProjectStore } = await import("@/store/project");
  const snapshot = useProjectStore.getState().project;
  const found = findClip(snapshot, clipId);
  const asset = found && snapshot.assets.find((a) => a.id === found.clip.assetId);
  if (!found || !asset || asset.type !== "video" || found.track.type !== "video")
    throw new Error("Select a video clip on a video track");
  if (found.clip.reversed)
    throw new Error("Set the clip direction to Forward before processing a subject effect");
  if (mode === "behind" && asset.alpha)
    throw new Error("Use the original video with its background for Text behind subject");
  if (mode === "behind" && !title.trim()) throw new Error("Enter a title first");
  const video = await invoke<SubjectVideo>("process_subject", {
    path: asset.path,
    sourceIn: found.clip.sourceIn,
    sourceOut: found.clip.sourceOut,
    mode: mode === "blur" ? "blur" : "remove",
    blur,
  });
  let drawn: { path: string; spec: TextSpec } | undefined;
  if (mode === "behind") {
    const spec = {
      ...defaultTextSpec(snapshot.settings.height),
      content: title.trim().slice(0, 120),
      fontSize: Math.round(snapshot.settings.width * 0.12),
      font: "Anton",
      uppercase: true,
      y: 0.18,
      wrap: 0.88,
    };
    drawn = {
      spec,
      path: await invoke<string>("render_text", {
        spec,
        width: snapshot.settings.width,
        height: snapshot.settings.height,
      }),
    };
  }
  if (useProjectStore.getState().project !== snapshot)
    throw new Error(
      "The project changed during processing. No edit was applied; retry to use the cached result.",
    );
  return useProjectStore.getState().execute({
    label:
      mode === "behind" ? "Text behind subject" : mode === "blur" ? "Blur background" : "Remove background",
    apply: (project) =>
      drawn
        ? addTextBehindSubject(project, clipId, video, drawn, {
            asset: crypto.randomUUID(),
            titleAsset: crypto.randomUUID(),
            titleTrack: crypto.randomUUID(),
            subjectTrack: crypto.randomUUID(),
            titleClip: crypto.randomUUID(),
            subjectClip: crypto.randomUUID(),
          })
        : applySubjectVideo(project, clipId, video, crypto.randomUUID()),
  });
}
