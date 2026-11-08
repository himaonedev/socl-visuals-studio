import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Captions, ClipboardCopy, Copy, Film, Scissors, Snowflake, Sparkles, Trash2 } from "lucide-react";

export interface MenuState {
  x: number;
  y: number;
  clipId: string;
}

interface Props {
  menu: MenuState;
  onSplit: () => void;
  onDelete: () => void;
  onCut: () => void;
  onCopy: () => void;
  onFreeze: () => void;
  /** Present when the clip can use the AI tools (it has sound). */
  onAi?: () => void;
  /** Present with `onAi`: open Auto clips for this clip (it explains itself when the clip is too short). */
  onClips?: () => void;
  /** Present for a text clip: save the texts of its track as a `.srt` file. */
  onSrt?: () => void;
  onResplit?: () => void;
  onMotion?: () => void;
  onClose: () => void;
}

export function ContextMenu({
  menu,
  onSplit,
  onDelete,
  onCut,
  onCopy,
  onFreeze,
  onAi,
  onClips,
  onSrt,
  onResplit,
  onMotion,
  onClose,
}: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: menu.x, top: menu.y });
  useLayoutEffect(() => {
    const place = () => {
      const bounds = ref.current?.getBoundingClientRect();
      if (!bounds) return;
      const gap = 8;
      const width = window.innerWidth;
      const height = window.innerHeight;
      const top = menu.y + bounds.height > height - gap ? menu.y - bounds.height : menu.y;
      setPosition({
        left: Math.max(gap, Math.min(menu.x, width - bounds.width - gap)),
        top: Math.max(gap, Math.min(top, height - bounds.height - gap)),
      });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [menu.x, menu.y]);
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (!(e.target as HTMLElement | null)?.closest("[data-context-menu]")) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const item =
    "flex h-9 w-full items-center gap-2 rounded-sm px-2 text-left text-sm hover:bg-accent-soft pointer-coarse:h-11";
  return createPortal(
    <div
      ref={ref}
      role="menu"
      data-context-menu
      aria-label="Clip actions"
      className="fixed z-50 min-w-44 overflow-y-auto overscroll-contain rounded-md border bg-popover p-1 shadow-lg"
      style={{ ...position, maxHeight: "calc(100dvh - 16px)", maxWidth: "calc(100vw - 16px)" }}
    >
      <button role="menuitem" className={item} onClick={onSplit}>
        <Scissors className="size-4" /> Split at playhead
        <kbd className="ml-auto text-xs text-text-muted">S</kbd>
      </button>
      <button role="menuitem" className={item} onClick={onFreeze}>
        <Snowflake className="size-4" /> Freeze frame
        <kbd className="ml-auto text-xs text-text-muted">Shift F</kbd>
      </button>
      <button role="menuitem" className={item} onClick={onCut}>
        <ClipboardCopy className="size-4" /> Cut
        <kbd className="ml-auto text-xs text-text-muted">Ctrl/⌘ X</kbd>
      </button>
      <button role="menuitem" className={item} onClick={onCopy}>
        <Copy className="size-4" /> Copy
        <kbd className="ml-auto text-xs text-text-muted">Ctrl/⌘ C</kbd>
      </button>
      {onMotion && (
        <button role="menuitem" className={item} onClick={onMotion}>
          <Sparkles className="size-4 text-accent" /> Motion presets…
        </button>
      )}
      {onAi && (
        <button role="menuitem" className={item} onClick={onAi}>
          <Sparkles className="size-4 text-accent" /> Subtitles with AI…
        </button>
      )}
      {onClips && (
        <button role="menuitem" className={item} onClick={onClips}>
          <Film className="size-4 text-accent" /> Find short clips…
        </button>
      )}
      {onResplit && (
        <button role="menuitem" className={item} onClick={onResplit}>
          <Captions className="size-4" /> Re-split long captions
        </button>
      )}
      {onSrt && (
        <button role="menuitem" className={item} onClick={onSrt}>
          <Captions className="size-4" /> Export subtitles (.srt)…
        </button>
      )}
      <button role="menuitem" className={item} onClick={onDelete}>
        <Trash2 className="size-4" /> Delete
        <kbd className="ml-auto text-xs text-text-muted">Del</kbd>
      </button>
    </div>,
    document.body,
  );
}
