import { useEffect, useId, useState } from "react";
import type { TimelineClip } from "@/project/model";
import type { SubjectMode } from "@/timeline/subjectEffects";
import { useSubjectEffectsStore } from "@/store/subjectEffects";
import { useProjectStore } from "@/store/project";
import { Button } from "@/components/ui/button";

export function SubjectEffectsPanel({ clip }: { clip: TimelineClip }) {
  const uid = useId();
  const state = useSubjectEffectsStore();
  const [mode, setMode] = useState<SubjectMode>("remove");
  const [title, setTitle] = useState("YOUR TITLE");
  const [blur, setBlur] = useState(20);
  const video = useProjectStore((s) => s.project.assets.find((a) => a.id === clip.assetId)?.type === "video");
  useEffect(() => {
    if (video) void useSubjectEffectsStore.getState().check();
  }, [video]);
  if (!video) return <p className="text-xs text-text-muted">Subject effects need a video clip.</p>;
  return (
    <section aria-label="Subject effects" className="space-y-3 border-t pt-3">
      <h3 className="text-sm font-medium">Subject effects</h3>
      <label htmlFor={`${uid}-effect`} className="block text-xs text-text-muted">
        Effect
      </label>
      <select
        id={`${uid}-effect`}
        value={mode}
        disabled={state.busy}
        onChange={(e) => setMode(e.target.value as SubjectMode)}
        className="h-9 w-full rounded-md border bg-surface-2 px-2 text-sm"
      >
        <option value="remove">Remove background</option>
        <option value="blur">Blur background</option>
        <option value="behind">Text behind subject</option>
      </select>
      {mode === "behind" && (
        <label className="block space-y-1 text-xs text-text-muted">
          Title
          <input
            value={title}
            maxLength={120}
            onChange={(e) => setTitle(e.target.value)}
            disabled={state.busy}
            className="h-9 w-full rounded-md border bg-surface-2 px-2 text-sm text-text"
          />
        </label>
      )}
      {mode === "blur" && (
        <label className="block text-xs text-text-muted">
          Blur strength
          <input
            type="range"
            min="2"
            max="40"
            value={blur}
            disabled={state.busy}
            onChange={(e) => setBlur(Number(e.target.value))}
            className="w-full accent-[var(--accent)]"
          />
        </label>
      )}
      <p className="text-xs text-text-muted">
        Local portrait segmentation. Best for one person; hair and fast motion may need review. Processes only
        this clip, up to ten minutes, at up to 30 fps and 1920 px on its longer side.
      </p>
      {mode === "remove" && (
        <p className="text-xs text-text-muted">
          Creates a transparent cut-out. Add a track below it for a new background.
        </p>
      )}
      {state.ready === false && (
        <p role="status" className="text-xs text-text-muted">
          {state.reason ?? "Local Python segmentation runtime is unavailable."}
        </p>
      )}
      {state.ready !== true && (
        <Button variant="secondary" onClick={() => void state.check()}>
          Check local runtime
        </Button>
      )}
      {state.busy ? (
        <>
          <p role="status" className="text-xs text-text-muted">
            Processing subject… {Math.round(state.fraction * 100)}%
          </p>
          <Button variant="secondary" onClick={state.cancel}>
            Cancel subject processing
          </Button>
        </>
      ) : (
        <Button
          variant="secondary"
          className="w-full"
          disabled={state.ready !== true || clip.reversed || (mode === "behind" && !title.trim())}
          onClick={() => void state.run(clip.id, mode, blur, title)}
        >
          Apply subject effect
        </Button>
      )}
      {clip.reversed && (
        <p className="text-xs text-text-muted">Set direction to Forward before processing.</p>
      )}
      {state.note && (
        <p role="status" className="text-xs text-text-muted">
          {state.note}
        </p>
      )}
    </section>
  );
}
