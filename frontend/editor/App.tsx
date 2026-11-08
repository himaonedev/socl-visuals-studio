import { EditorWorkspace } from "@/components/layout/EditorWorkspace";
import { useWorkspaceStore } from "@/store/workspace";
import { useEffect } from "react";
import { AboutDialog } from "@/components/AboutDialog";
import { SettingsDialog } from "@/components/SettingsDialog";
import { SupportDialog } from "@/components/SupportDialog";
import { UpdateDialog } from "@/components/UpdateDialog";
import { AppDialog } from "@/components/AppDialog";


import { SrtImportDialog } from "@/components/SrtImportDialog";
import { StylePacksDialog } from "@/components/packs/StylePacksDialog";
import { CanvasDialog } from "@/components/canvas/CanvasDialog";
import { CanvasNotice } from "@/components/canvas/CanvasNotice";
import { NewProjectDialog } from "@/components/canvas/NewProjectDialog";
import { NoticeToast } from "@/components/NoticeToast";
import { ExportDialog } from "@/components/ExportDialog";
import { DragChip } from "@/components/DragChip";
import { Inspector } from "@/components/layout/Inspector";
import { MediaLibrary } from "@/components/layout/MediaLibrary";
import { Preview } from "@/components/layout/Preview";
import { Timeline } from "@/components/layout/Timeline";
import { StyleEditorSheet } from "@/components/text/StyleEditor";
import { TextStylesPanel } from "@/components/text/TextStylesPanel";
import { TopBar } from "@/components/layout/TopBar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useUiStore, type SidePanel } from "@/store/ui";
import { cn } from "@/lib/utils";
import { onMenuAction } from "@/lib/menuEvents";
import { useFileDrop } from "@/hooks/useFileDrop";

import { watchTextPictures } from "@/timeline/text";
import { useEditorShortcuts } from "@/timeline/useEditorShortcuts";
import { ProjectHome } from "@/components/ProjectHome";

const TABS: { id: SidePanel; label: string }[] = [
  { id: "library", label: "Media" },
  { id: "text", label: "Text" },
  { id: "inspector", label: "Inspector" },
];

/** Tab switcher for the side panels; only shown on narrow screens. */
function SidePanelTabs() {
  const mode = useWorkspaceStore(s => s.mode);
  const sidePanel = useUiStore((s) => s.sidePanel);
  const setSidePanel = useUiStore((s) => s.setSidePanel);
  return (
    <div role="tablist" aria-label="Side panels" className="flex shrink-0 border-y bg-surface-1 lg:hidden">
      {TABS.filter(t => mode === 'caption' || t.id !== 'text').map((t) => (
        <button
          key={t.id}
          role="tab"
          aria-selected={sidePanel === t.id}
          onClick={() => setSidePanel(t.id)}
          className={cn(
            "h-11 flex-1 text-sm",
            sidePanel === t.id ? "border-b-2 border-accent text-text" : "text-text-muted",
          )}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

function EditorBindings() {
  useEditorShortcuts();
  useFileDrop();
  useEffect(() => watchTextPictures(), []);
  return null;
}

export default function App({ active = true }: { active?: boolean }) {
  const clipBound = useWorkspaceStore(s => s.clipBound);
  const mode = useWorkspaceStore(s => s.mode);
  const appView = useUiStore((s) => s.appView);

  useEffect(() => {
    if (!active) return;
    const menu = onMenuAction();
    return () => {
      void menu.then((off) => off()).catch(() => {});
    };
  }, [active]);
  return (
    <TooltipProvider>
      {appView === "home" && !clipBound ? (
        <ProjectHome />
      ) : (
        <>
          {active && <EditorBindings />}
          <div className="flex h-full flex-col bg-bg">
            <TopBar />
            <CanvasNotice />
            <EditorWorkspace>
              <Preview />
              {/* narrow: tabs + the active panel; wide: wrapper disappears and panels become grid items */}
              <div className="flex min-h-0 flex-col lg:contents">
                <SidePanelTabs />
                <MediaLibrary />
                {mode === 'caption' && <TextStylesPanel />}
                <Inspector />
              </div>
              <Timeline />
            </EditorWorkspace>
          </div>
        </>
      )}
      <DragChip />
      <ExportDialog />
      <SrtImportDialog />
      <StylePacksDialog />
      <NewProjectDialog />
      <CanvasDialog />
      <AppDialog />
      <AboutDialog />
      <SupportDialog />
      <SettingsDialog />
      <UpdateDialog />
      <StyleEditorSheet />
      <NoticeToast />
    </TooltipProvider>
  );
}

