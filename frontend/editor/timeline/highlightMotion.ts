import { MAX_KEYS, type Keyframes, type TimelineClip } from "@/project/model";
import { clipEnd, clipSpeed, EPS } from "./clips";
import { KEY_PROPS, valueAt, type Key } from "./transform";

/** The rendered video starts at zero and already plays at timeline speed. Retain source motion. */
export function movingHighlightMotion(
  clip: TimelineClip,
  start: number,
  seconds: number,
  zoom: number,
): Partial<TimelineClip> {
  const speed = clipSpeed(clip),
    from = clip.sourceIn + (start - clip.timelineStart) * speed,
    to = from + seconds * speed;
  const keyframes: Keyframes = {};
  for (const prop of KEY_PROPS) {
    const old = clip.keyframes?.[prop];
    if (!old?.length) continue;
    const points = new Map<number, number>([
      [0, valueAt(old, from)],
      [seconds, valueAt(old, to)],
    ]);
    for (const k of old)
      if (k.t >= from - EPS && k.t <= to + EPS)
        points.set(Math.max(0, Math.min(seconds, (k.t - from) / speed)), k.v);
    const keys: Key[] = [...points].sort((a, b) => a[0] - b[0]).map(([t, v]) => ({ t, v }));
    // The evaluator holds its first/last value outside the keys, so these flat boundary keys are redundant.
    if (keys.length > 1 && Math.abs(keys[0].v - keys[1].v) < EPS) keys.shift();
    if (keys.length > 1 && Math.abs(keys.at(-1)!.v - keys.at(-2)!.v) < EPS) keys.pop();
    if (keys.length > MAX_KEYS)
      throw new Error("This range has too many motion keys. Choose a shorter range.");
    keyframes[prop] = keys;
  }
  if (zoom > 1 + EPS) {
    const ramp = Math.min(0.16, seconds / 4);
    const times = new Set([0, ramp, seconds - ramp, seconds, ...(keyframes.scale ?? []).map((k) => k.t)]);
    if (times.size > MAX_KEYS)
      throw new Error("Too many scale keys for an extra zoom. Set Zoom to 1 or choose a shorter range.");
    const old = keyframes.scale;
    keyframes.scale = [...times]
      .sort((a, b) => a - b)
      .map((t) => {
        const amount = Math.max(0, Math.min(1, t / ramp, (seconds - t) / ramp));
        return {
          t,
          v: Math.max(
            0.05,
            Math.min(4, (old?.length ? valueAt(old, t) : clip.scale) * (1 + (zoom - 1) * amount)),
          ),
        };
      });
  }
  return {
    x: clip.x,
    y: clip.y,
    scale: clip.scale,
    rotation: clip.rotation,
    flipH: clip.flipH,
    flipV: clip.flipV,
    opacity: clip.opacity,
    keyframes: Object.keys(keyframes).length ? keyframes : undefined,
    transitionIn: Math.abs(start - clip.timelineStart) < EPS ? clip.transitionIn : undefined,
    transitionOut: Math.abs(start + seconds - clipEnd(clip)) < EPS ? clip.transitionOut : undefined,
  };
}
