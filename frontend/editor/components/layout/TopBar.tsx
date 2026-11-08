import { Redo2, Undo2 } from "lucide-react";

import { useShallow } from "zustand/react/shallow";


import { IconButton } from "@/components/IconButton";

import { Button } from "@/components/ui/button";




import { canvasLabel, canvasOf } from "@/project/canvas";
import { useUiStore } from "@/store/ui";
import { selectCanRedo, selectCanUndo, useProjectStore } from "@/store/project";
import { redo, undo } from "@/timeline/editor";

export function TopBar() {
  const name = useProjectStore((s) => s.project.name);
  const canUndo = useProjectStore(selectCanUndo);

  const canvas = useProjectStore(useShallow((s) => canvasOf(s.project)));
  const canvasPending = useProjectStore((s) => s.project.settings.canvasPending === true);
  const openCanvas = useUiStore((s) => s.setCanvasDialogOpen);





  const canRedo = useProjectStore(selectCanRedo);
  const undoLabel = useProjectStore((s) => s.past[s.past.length - 1]?.label);
  const redoLabel = useProjectStore((s) => s.future[s.future.length - 1]?.label);
  return (
    <header className="flex h-12 shrink-0 items-center gap-1 border-b bg-surface-1 px-2 sm:px-3">


      <span className="mx-2 hidden max-w-40 truncate text-sm text-text-muted sm:inline">{name}</span>


      <IconButton
        label={undoLabel ? `Undo ${undoLabel}` : "Undo"}
        icon={<Undo2 />}
        shortcut="Ctrl/⌘ Z"
        disabled={!canUndo}
        onClick={undo}
      />
      <IconButton
        label={redoLabel ? `Redo ${redoLabel}` : "Redo"}
        icon={<Redo2 />}
        shortcut="Ctrl/⌘ Shift Z"
        disabled={!canRedo}
        onClick={redo}
      />
      <Button
        variant="ghost"
        size="sm"
        className="max-w-[16rem] truncate pointer-coarse:h-11"
        aria-label={`Canvas: ${canvasPending ? "Original, set by the first video" : canvasLabel(canvas)}`}
        title="Change canvas"
        onClick={() => openCanvas(true)}
      >
        {canvasPending ? "Canvas: Original" : canvasLabel(canvas)}
      </Button>

    </header>
  );
}

