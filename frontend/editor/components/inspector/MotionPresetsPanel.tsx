import {
  useTextMotionClipboard,
  copyTextMotion,
  pasteMotionToSelectedText,
} from "@/timeline/textMotionClipboard";
import { useId, useState } from "react";
import type { TimelineClip } from "@/project/model";
import { usePlaybackStore } from "@/store/playback";
import {
  applyMotionToTextSelection,
  applyTextMotionToTrack,
  applyMotionPreset,
  report,
} from "@/timeline/editor";
import { MOTION_PRESETS, type MotionPresetId, type MotionStrength } from "@/timeline/motionPresets";
import { Button } from "@/components/ui/button";

const field = "h-9 w-full rounded-md border bg-surface-2 px-2 text-sm focus-visible:outline-accent";

export function MotionPresetsPanel({
  clip,
  text = false,
  targetIds,
}: {
  clip: TimelineClip;
  text?: boolean;
  targetIds?: string[];
}) {
  const uid = useId();
  const motion = useTextMotionClipboard((s) => s.motion);
  const [copied, setCopied] = useState(false);
  const [preset, setPreset] = useState<MotionPresetId>(text ? "apple-rise" : "punch-in");
  const [strength, setStrength] = useState<MotionStrength>("subtle");
  const [seconds, setSeconds] = useState(text ? "0.45" : "2");
  const [wholeTrack, setWholeTrack] = useState(false);
  const available = MOTION_PRESETS.filter((p) => p.text === text);
  const selected = available.find((p) => p.id === preset) ?? available[0];
  const duration = Number(seconds);
  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <label htmlFor={`${uid}-preset`} className="text-xs text-text-muted">
          Motion style
        </label>
        <select
          id={`${uid}-preset`}
          className={field}
          value={selected.id}
          onChange={(e) => setPreset(e.target.value as MotionPresetId)}
        >
          {available.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <p className="text-xs text-text-muted">{selected.description}</p>
      </div>
      <div className="space-y-1">
        <label htmlFor={`${uid}-strength`} className="text-xs text-text-muted">
          Intensity
        </label>
        <select
          id={`${uid}-strength`}
          className={field}
          value={strength}
          onChange={(e) => setStrength(e.target.value as MotionStrength)}
        >
          <option value="subtle">Subtle</option>
          <option value="dynamic">Dynamic</option>
        </select>
      </div>
      {(selected.id === "punch-in" || text) && (
        <div className="space-y-1">
          <label htmlFor={`${uid}-seconds`} className="text-xs text-text-muted">
            {text ? "Animation time (seconds)" : "Duration (seconds)"}
          </label>
          <input
            id={`${uid}-seconds`}
            className={field}
            type="number"
            min={text ? "0.1" : "0.2"}
            max={text ? "2" : "10"}
            step={text ? "0.05" : "0.1"}
            value={seconds}
            onChange={(e) => setSeconds(e.target.value)}
          />
        </div>
      )}
      {text && !targetIds && (
        <label className="flex items-start gap-2 text-xs">
          <input type="checkbox" checked={wholeTrack} onChange={(e) => setWholeTrack(e.target.checked)} />
          Apply to all text / subtitle clips on this track
        </label>
      )}
      {text && (
        <p className="text-xs text-text-muted">
          Entry eases out; exit eases in. Short captions automatically use shorter animations. Clips under
          four frames are skipped in track mode. Font, colour, box and word timings stay editable.
        </p>
      )}
      <p className="text-xs text-text-muted">
        Replaces {text ? "scale, position X/Y and opacity" : "scale"} keyframes on this clip. Undo restores
        the previous motion.
      </p>
      <Button
        variant="secondary"
        className="w-full"
        disabled={
          (selected.id === "punch-in" || text) &&
          (!Number.isFinite(duration) || duration < (text ? 0.1 : 0.2) || duration > (text ? 2 : 10))
        }
        onClick={() =>
          report(
            text && targetIds
              ? applyMotionToTextSelection(targetIds, selected.id, strength, duration)
              : text && wholeTrack
                ? applyTextMotionToTrack(clip.trackId, selected.id, strength, duration)
                : applyMotionPreset(
                    clip.id,
                    selected.id,
                    strength,
                    usePlaybackStore.getState().playhead,
                    selected.id === "punch-in" || text ? duration : 2,
                  ),
          )
        }
      >
        {text && targetIds
          ? "Apply motion to selected text"
          : text && wholeTrack
            ? "Apply text motion to track"
            : "Apply motion"}
      </Button>
      {text && (
        <div className="space-y-2 border-t pt-3">
          <div className="grid grid-cols-2 gap-2">
            <Button
              variant="secondary"
              disabled={Boolean(targetIds)}
              onClick={() => {
                const result = copyTextMotion(clip.id);
                report(result);
                if (result.ok) setCopied(true);
              }}
            >
              Copy Motion
            </Button>
            <Button
              variant="secondary"
              disabled={!motion}
              onClick={() => report(pasteMotionToSelectedText(targetIds ?? [clip.id]))}
            >
              Paste Motion
            </Button>
          </div>
          <p className="text-xs text-text-muted">
            {copied
              ? "Motion copied. Select other text clips, then Paste Motion. "
              : "Copy from one animated text clip, then paste onto selected subtitles. "}
            Timing fits each target clip. Font, colour, content and box stay unchanged. One Undo restores all
            targets.
          </p>
        </div>
      )}
    </div>
  );
}
