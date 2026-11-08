import type { Project } from "@/project/model";
import type { EditResult } from "./edit";
import { isTrackLocked } from "@/store/trackLocks";

/** One gate for drag, keyboard commands, Inspector, Cut/Paste and generated effects. */
export function protectLockedTracks(before: Project, result: EditResult): EditResult {
  if (!result.ok || result.project === before) return result;
  const after = result.project;
  for (const track of before.tracks) {
    if (!isTrackLocked(before.id, track.id)) continue;
    const next = after.tracks.find((t) => t.id === track.id);
    const blocked = () => ({
      ok: false as const,
      error: {
        code: "out-of-range" as const,
        message: `Track "${track.name}" is locked. Unlock it before editing.`,
      },
    });
    if (!next || JSON.stringify(next.clips) !== JSON.stringify(track.clips)) return blocked();
    const ids = new Set(
      track.clips.flatMap((c) => [c.assetId, ...(c.fitBackground?.assetId ? [c.fitBackground.assetId] : [])]),
    );
    for (const id of ids)
      if (
        JSON.stringify(before.assets.find((a) => a.id === id)) !==
        JSON.stringify(after.assets.find((a) => a.id === id))
      )
        return blocked();
  }
  return result;
}
