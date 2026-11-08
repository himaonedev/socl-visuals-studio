import type { TimelineClip } from "@/project/model";
import { useProjectStore } from "@/store/project";
import { animationTiming, retimeImageAnimation } from "@/timeline/highlightImage";
import { report } from "@/timeline/editor";
import { Button } from "@/components/ui/button";

export function ImageAnimationSpeedPanel({ clip }: { clip: TimelineClip }) {
  const image = useProjectStore((s) => s.project.assets.find((a) => a.id === clip.assetId)?.type === "image");
  if (!image || !clip.keyframes || animationTiming(clip).end <= animationTiming(clip).origin) return null;
  const speed = animationTiming(clip).speed;
  const apply = (value: number) =>
    report(
      useProjectStore
        .getState()
        .execute({ label: "Image animation speed", apply: (p) => retimeImageAnimation(p, clip.id, value) }),
    );
  return (
    <section aria-label="Image animation speed" className="space-y-2 border-t py-3">
      <p className="text-sm font-medium">Image animation speed</p>
      <div className="flex gap-1">
        {[0.5, 1, 2, 4].map((v) => (
          <Button key={v} variant="secondary" onClick={() => apply(v)}>
            {v}x
          </Button>
        ))}
      </div>
      <label className="block text-xs text-text-muted">
        Speed: {Number(speed.toFixed(2))}x
        <input
          aria-label="Image animation speed"
          type="range"
          min={0.1}
          max={5}
          step={0.05}
          value={Math.max(0.1, Math.min(5, speed))}
          onChange={(e) => apply(Number(e.target.value))}
          className="w-full accent-[var(--accent)]"
        />
      </label>
      <p className="text-xs text-text-muted">
        Changes animation timing only. Drag this image clip on the timeline to change when it appears; use
        Transform to move or resize it.
      </p>
    </section>
  );
}
