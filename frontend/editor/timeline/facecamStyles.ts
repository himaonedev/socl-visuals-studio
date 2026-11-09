import { invoke } from "@tauri-apps/api/core";
import type { Project } from "@/project/model";
import { useProjectStore } from "@/store/project";
import { useSelectionStore } from "@/store/selection";
import { usePlaybackStore } from "@/store/playback";
import { defaultTextSpec } from "./text";
import { sourceTimeAt, type EditResult } from "./edit";
import { clipSpeed, EPS } from "./clips";
import {
  applyFreezeHighlight,
  DEFAULT_FREEZE_HIGHLIGHT,
  freezeWindow,
  type PreparedFreeze,
} from "./freezeHighlight";

export const FACECAM_STYLES = [
  {
    id: 'cinema-label',
    name: 'Cinema Label',
    description: 'Label judul dua baris dengan garis aksen vertikal, seperti judul serial di pojok video.',
    text: true,
  },
  {
    id: "lean-in",
    name: "Lean-in / Punch-in",
    description: "Fast eased zoom, a gentle drift, then return.",
    text: false,
  },
  {
    id: "slow-push",
    name: "Slow Push",
    description: "Smooth push-in; optional separated subject and room parallax.",
    text: false,
  },
  {
    id: "text-behind",
    name: "Text Behind",
    description: "A title rises behind the person while the video keeps moving.",
    text: true,
  },
  {
    id: "backdrop-word",
    name: "Backdrop Word",
    description: "Letters drop in one at a time behind the person.",
    text: true,
  },
  {
    id: "spotlight",
    name: "Spotlight",
    description: "Dim the room, keep the subject lit and add a warm rim.",
    text: true,
  },
  {
    id: "name-tag",
    name: "Name Tag",
    description: "A rounded lower-third slides in and leaves by moving.",
    text: true,
  },
  {
    id: "silhouette-intro",
    name: "Silhouette Intro",
    description: "Open on a coloured silhouette, then reveal the moving footage.",
    text: false,
  },
  {
    id: "bottom-fade",
    name: "Bottom Fade",
    description: "A soft dark gradient keeps the lower frame readable.",
    text: false,
  },
  {
    id: "glass-card",
    name: "Glass Card / Counter",
    description: "A frosted 2D card, animated number and optional decorative graph.",
    text: true,
  },
  {
    id: "freeze-sticker",
    name: "Freeze Sticker",
    description: "Hold the frame with a coloured outline, gentle zoom and a name tag.",
    text: true,
  },
] as const;
export type FacecamStyle = (typeof FACECAM_STYLES)[number]["id"];
export interface FacecamSettings {
  style: FacecamStyle;
  duration: number;
  text: string;
  font: string;
  textSize: number;
  strength: number;
  zoom: number;
  x: number;
  y: number;
  frameX: number;
  frameY: number;
  frameZoom: number;
  entry: 'none' | 'slide' | 'pop' | 'slide-pop';
  entryDirection: 'left' | 'right' | 'top' | 'bottom';
  entryDuration: number;
  entryDelay: number;
  exit: 'follow' | 'none' | 'slide' | 'pop' | 'slide-pop';
  exitDirection: 'follow' | 'left' | 'right' | 'top' | 'bottom';
  exitDuration: number;
  accent: string;
  textColor: string;
  background: string;
  parallax: boolean;
  fromValue: number;
  toValue: number;
  graph: boolean;
}
export const DEFAULT_FACECAM: FacecamSettings = {
  style: "lean-in",
  duration: 3,
  text: "Your text",
  font: "Noto Sans",
  textSize: 0.14,
  strength: 0.8,
  zoom: 1.25,
  x: 0.5,
  y: 0.28,
  frameX: 0.5,
  frameY: 0.5,
  frameZoom: 1,
  entry: 'none',
  entryDirection: 'left',
  entryDuration: 0.45,
  entryDelay: 0,
  exit: 'follow',
  exitDirection: 'follow',
  exitDuration: 0.45,
  accent: "#E5733A",
  textColor: "#FFFFFF",
  background: "#14141C",
  parallax: false,
  fromValue: 0,
  toValue: 100,
  graph: false,
};
export const facecamNeedsSubject = (s: FacecamSettings) =>
  ["text-behind", "backdrop-word", "spotlight", "silhouette-intro", "freeze-sticker"].includes(s.style) ||
  (s.style === "slow-push" && s.parallax);
export const facecamWindowSettings = (s: FacecamSettings) => ({
  ...DEFAULT_FREEZE_HIGHLIGHT,
  playback: "moving" as const,
  style: "mono" as const,
  duration: s.duration,
  zoom: 1,
  audio: "none" as const,
});
export function facecamWindow(project: Project, clipId: string, time: number, s: FacecamSettings) {
  const definition = FACECAM_STYLES.find((t) => t.id === s.style);
  if (
    !definition ||
    !['follow','none','slide','pop','slide-pop'].includes(s.exit) ||
    !['follow','left','right','top','bottom'].includes(s.exitDirection) ||
    !Number.isFinite(s.exitDuration) || s.exitDuration < .1 || s.exitDuration > 3 ||
    !['none','slide','pop','slide-pop'].includes(s.entry) ||
    !['left','right','top','bottom'].includes(s.entryDirection) ||
    ![s.entryDuration,s.entryDelay].every(Number.isFinite) ||
    s.entryDuration < 0.1 || s.entryDuration > 3 || s.entryDelay < 0 || s.entryDelay > 5 ||
    ![s.duration, s.strength, s.zoom, s.x, s.y, s.frameX, s.frameY, s.frameZoom, s.textSize, s.fromValue, s.toValue].every(Number.isFinite) ||
    s.frameX < 0 || s.frameX > 1 || s.frameY < 0 || s.frameY > 1 || s.frameZoom < 0.5 || s.frameZoom > 2.5 ||
    s.duration < 0.2 ||
    s.duration > 30 ||
    s.strength < 0 ||
    s.strength > 1 ||
    s.zoom < 1 ||
    s.zoom > 1.6 ||
    s.textSize < 0.03 ||
    s.textSize > 0.25 ||
    s.x < 0 ||
    s.x > 1 ||
    s.y < 0 ||
    s.y > 1 ||
    Math.abs(s.fromValue) > 1e9 ||
    Math.abs(s.toValue) > 1e9 ||
    ![s.accent, s.textColor, s.background].every((c) => /^#[\da-f]{6}$/i.test(c)) ||
    typeof s.parallax !== "boolean" ||
    typeof s.graph !== "boolean" ||
    !s.font.trim() ||
    s.font.length > 100 ||
    [...s.text].length > 48 ||
    (definition.text && s.style !== "spotlight" && !s.text.trim())
  )
    throw new Error(
      "Choose valid facecam settings, text up to 48 characters and a duration of 0.2–30 seconds",
    );
  const window = freezeWindow(project, clipId, time, facecamWindowSettings(s));
  const exitMode = s.exit === 'follow' ? s.entry : s.exit;
  if (definition.text && exitMode !== 'none' && s.exitDuration + (s.entry === 'none' ? 0 : s.entryDelay+s.entryDuration) > window.stop-window.start+EPS)
    throw new Error('Durasi masuk dan keluar melebihi durasi Facecam. Kurangi durasi animasi.');
  if (s.entry !== 'none' && s.entryDelay+s.entryDuration > window.stop-window.start+EPS)
    throw new Error('Durasi masuk + delay melebihi durasi Facecam yang tersedia. Kurangi durasi/delay atau pindahkan playhead.');
  if (window.clip.reversed)
    throw new Error("Set the video direction to Forward before applying a facecam style");
  return window;
}
export function applyFacecamStyle(
  project: Project,
  clipId: string,
  time: number,
  settings: FacecamSettings,
  prepared: PreparedFreeze,
): EditResult {
  try {
    facecamWindow(project, clipId, time, settings);
  } catch (error) {
    return {
      ok: false,
      error: { code: "out-of-range", message: error instanceof Error ? error.message : String(error) },
    };
  }
  return applyFreezeHighlight(project, clipId, time, facecamWindowSettings(settings), prepared);
}
export async function createFacecamStyle(
  clipId: string,
  time: number,
  settings: FacecamSettings,
  signal?: AbortSignal,
): Promise<EditResult> {
  signal?.throwIfAborted();
  const snapshot = useProjectStore.getState().project;
  const window = facecamWindow(snapshot, clipId, time, settings);
  if (!window.asset.width || !window.asset.height)
    throw new Error("The video dimensions are unavailable. Reimport the source.");
  usePlaybackStore.getState().pause();
  const factor = Math.min(1, 1920 / Math.max(window.asset.width, window.asset.height));
  const width = Math.max(2, Math.floor(Math.round(window.asset.width * factor) / 2) * 2);
  const height = Math.max(2, Math.floor(Math.round(window.asset.height * factor) / 2) * 2);
  const definition = FACECAM_STYLES.find((t) => t.id === settings.style)!;
  const pieces =
    !definition.text || !settings.text.trim()
      ? []
      : settings.style === 'cinema-label'
        ? settings.text.trim().split(/\n/).slice(0, 2).filter(line => line.trim())
      : settings.style === "backdrop-word"
        ? [...settings.text.trim()]
        : [settings.text.trim()];
  const plates: string[] = [];
  const cached = new Map<string, string>();
  // Render glyphs sequentially and reuse repeated characters: bounded native text work.
  for (const piece of pieces) {
    signal?.throwIfAborted();
    if (!piece.trim()) {
      plates.push("");
      continue;
    }
    let path = cached.get(piece);
    if (!path) {
      path = await invoke<string>("render_text", {
        spec: {
          ...defaultTextSpec(height),
          content: piece,
          font: settings.font,
          color: settings.textColor,
          fontSize: Math.max(8, Math.round(width * settings.textSize)),
          x: 0.5,
          y: 0.5,
          wrap: 0.88,
        },
        width,
        height,
      });
      cached.set(piece, path);
    }
    plates.push(path);
  }
  if (useProjectStore.getState().project !== snapshot)
    throw new Error("The project changed during preparation. No edit applied.");
  const first = sourceTimeAt(window.clip, window.start),
    last = sourceTimeAt(window.clip, window.stop);
  signal?.throwIfAborted();
  const { duration: _duration, text: _text, font: _font, textSize: _textSize, ...renderSettings } = settings;
  void _duration;
  void _text;
  void _font;
  void _textSize;
  const cancel = () => {
    void invoke("cancel_ai_job").catch(() => undefined);
  };
  signal?.addEventListener("abort", cancel, { once: true });
  let prepared: PreparedFreeze;
  try {
    prepared = await invoke<PreparedFreeze>("prepare_facecam_style", {
      request: {
        path: window.asset.path,
        sourceIn: Math.min(first, last),
        sourceOut: Math.max(first, last),
        seconds: window.stop - window.start,
        speed: clipSpeed(window.clip),
        fps: snapshot.settings.fps,
        plates,
        settings: renderSettings,
      },
    });
  } finally {
    signal?.removeEventListener("abort", cancel);
  }
  signal?.throwIfAborted();
  if (useProjectStore.getState().project !== snapshot)
    throw new Error("The project changed during rendering. No edit applied; retry to use the cached result.");
  const result = useProjectStore
    .getState()
    .execute({
      label: `Facecam: ${definition.name}`,
      apply: (p) => applyFacecamStyle(p, clipId, time, settings, prepared),
    });
  if (result.ok) {
    const asset = result.project.assets.find((a) => a.path === prepared.image.path);
    const clip = result.project.tracks
      .flatMap((t) => t.clips)
      .find((c) => c.assetId === asset?.id && Math.abs(c.timelineStart - window.start) < EPS);
    if (clip) useSelectionStore.getState().select(clip.id);
  }
  return result;
}
