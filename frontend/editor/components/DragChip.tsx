import { useState } from "react";
import { Film, Image as ImageIcon, Music2, Sparkles } from "lucide-react";
import { useDragDropStore } from "@/store/dragDrop";
import { thumbnailUrl } from "@/lib/media";

function DragThumbnail({ path, type }: { path?: string; type?: "video" | "image" | "audio" }) {
  const [failed, setFailed] = useState(false);
  const Icon = type === "audio" ? Music2 : type === "image" ? ImageIcon : Film;
  return (
    <div
      data-testid="drag-thumbnail"
      className="relative flex h-12 w-20 shrink-0 items-center justify-center overflow-hidden rounded bg-black text-text-muted"
    >
      {path && !failed ? (
        <img
          src={thumbnailUrl(path)}
          alt=""
          draggable={false}
          className="h-full w-full object-cover"
          onError={() => setFailed(true)}
        />
      ) : (
        <Icon className="size-5" />
      )}
    </div>
  );
}

/** A cached media thumbnail follows the pointer; never intercepts the drop target. */
export function DragChip() {
  const dragging = useDragDropStore((s) => s.dragging);
  const overTimeline = useDragDropStore((s) => s.preview !== null);
  if (!dragging || dragging.source === "os") return null;
  const media = dragging.source === "library";
  const width = media ? 224 : 176,
    height = media ? 64 : 32;
  const viewportWidth = typeof window !== "undefined" ? window.innerWidth : 1000;
  const viewportHeight = typeof window !== "undefined" ? window.innerHeight : 800;
  const left = Math.max(8, Math.min(dragging.x + 12, viewportWidth - width - 8));
  const top = Math.max(
    8,
    Math.min(
      dragging.y + 12 + height > viewportHeight ? dragging.y - height - 12 : dragging.y + 12,
      viewportHeight - height - 8,
    ),
  );
  return (
    <div
      aria-hidden
      data-testid="drag-chip"
      className="pointer-events-none fixed z-[100] flex items-center gap-2 rounded-lg border border-accent/50 bg-popover p-2 text-xs shadow-xl"
      style={{ left, top, width, maxWidth: "calc(100vw - 16px)", opacity: overTimeline ? 0.85 : 1 }}
    >
      {media ? (
        <DragThumbnail
          key={dragging.thumbnailPath ?? dragging.mediaType}
          path={dragging.thumbnailPath}
          type={dragging.mediaType}
        />
      ) : (
        <Sparkles className="size-4 shrink-0 text-accent" />
      )}
      <div className="min-w-0">
        <p className="truncate font-medium text-text">{dragging.label}</p>
        {media && (
          <p className="mt-1 text-[10px] text-text-muted">
            {dragging.mediaType === "audio" ? "Audio" : dragging.mediaType === "image" ? "Image" : "Video"}
          </p>
        )}
      </div>
    </div>
  );
}
