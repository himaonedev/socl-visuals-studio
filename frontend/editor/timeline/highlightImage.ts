import type { Keyframes, Project, TimelineClip } from "@/project/model";
import type { FreezeHighlightSettings } from "./freezeHighlight";
import { findClip } from "./clips";
import type { EditResult } from "./edit";

/** Ordinary editable source-time keys: moving a clip on the timeline moves its animation too. */
export function highlightImageKeys(
  s: FreezeHighlightSettings,
  seconds: number,
  x: number,
  y: number,
  scale: number,
): Keyframes {
  const motion = s.backgroundMotion;
  if (motion === "none") return {};
  const duration = seconds / s.backgroundSpeed;
  const clamp = (value: number) => Math.max(-2, Math.min(2, value));
  if (motion === "shake") {
    const keys = (axis: "x" | "y") =>
      Array.from({ length: 49 }, (_, i) => {
        const p = i / 48;
        return {
          t: p * duration,
          v: clamp(
            (axis === "x" ? x : y) +
              Math.sin(p * Math.PI * (axis === "x" ? 24 : 34)) *
                (axis === "x" ? 0.025 : 0.015) *
                Math.sin(p * Math.PI),
          ),
        };
      });
    return { x: keys("x"), y: keys("y") };
  }
  const vertical = motion === "down" || motion === "up";
  const target = vertical ? y : x;
  const centre = vertical ? s.backgroundY : s.backgroundX;
  const size = vertical ? s.backgroundHeight : s.backgroundWidth;
  const from = (motion === "down" || motion === "right" ? -size / 2 - centre : 1 + size / 2 - centre) * scale;
  const keys = Array.from({ length: 9 }, (_, i) => {
    const p = i / 8,
      eased = p * p * (3 - 2 * p);
    return { t: p * duration, v: clamp(target + from * (1 - eased)) };
  });
  return vertical ? { y: keys } : { x: keys };
}

const animatedProps = (clip: TimelineClip) =>
  clip.keyframes?.x || clip.keyframes?.y ? ["x", "y"] : Object.keys(clip.keyframes ?? {});
export function animationTiming(clip: TimelineClip) {
  const keys = animatedProps(clip).flatMap((prop) => clip.keyframes?.[prop as keyof Keyframes] ?? []);
  const origin = Math.min(clip.sourceIn, ...keys.map((k) => k.t));
  const end = Math.max(origin, ...keys.map((k) => k.t));
  return { origin, end, speed: end > origin ? (clip.sourceOut - clip.sourceIn) / (end - origin) : 1 };
}

/** Retimes keys without changing clip duration, media speed, sound, or neighbouring clips. */
export function retimeImageAnimation(project: Project, clipId: string, speed: number): EditResult {
  const found = findClip(project, clipId);
  const invalid = (message: string): EditResult => ({ ok: false, error: { code: "out-of-range", message } });
  if (!found || !Number.isFinite(speed) || speed < 0.1 || speed > 5)
    return invalid("Choose animation speed between 0.1x and 5x");
  const clip = found.clip;
  const { origin, end } = animationTiming(clip);
  if (end <= origin || project.assets.find((a) => a.id === clip.assetId)?.type !== "image")
    return invalid("Select an image with animation keyframes");
  const factor = (clip.sourceOut - clip.sourceIn) / speed / (end - origin);
  const keyframes = Object.fromEntries(
    Object.entries(clip.keyframes!).map(([prop, keys]) => [
      prop,
      animatedProps(clip).includes(prop)
        ? keys.map((k) => ({ ...k, t: origin + (k.t - origin) * factor }))
        : keys,
    ]),
  );
  return {
    ok: true,
    project: {
      ...project,
      tracks: project.tracks.map((t) => ({
        ...t,
        clips: t.clips.map((c) => (c.id === clipId ? { ...c, keyframes } : c)),
      })),
    },
  };
}
