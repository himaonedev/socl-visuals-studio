import type { TimelineClip } from "@/project/model";
import { SubjectEffectsPanel } from "./SubjectEffectsPanel";
/** Effects tools only; speech, karaoke and clipping live in SOCL Edit/Clipping. */
export function AiPanel({ clip }: { clip: TimelineClip }) {
  return <SubjectEffectsPanel clip={clip} />;
}
