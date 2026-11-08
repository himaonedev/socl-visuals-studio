import { useCallback, useEffect, useState } from "react";
import { ArrowRight, FilePlus2, Film, FolderOpen, Loader2, RefreshCw, Settings } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Logo } from "@/components/Logo";
import { recentProjectFiles, type RecentProject } from "@/lib/projectFile";
import { newProjectFlow, openProjectFlow, openRecentFlow } from "@/project/fileActions";
import { useUiStore } from "@/store/ui";
import { selectIsDirty, useProjectStore } from "@/store/project";

export function ProjectHome() {
  const [projects, setProjects] = useState<RecentProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const hasSession = useUiStore((s) => s.hasSession);
  const name = useProjectStore((s) => s.project.name);
  const dirty = useProjectStore(selectIsDirty);
  const refresh = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const result = await recentProjectFiles();
      setProjects(Array.isArray(result) ? result : []);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void refresh();
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);
  const open = useCallback(
    async (index?: number) => {
      if (busy) return;
      setBusy(true);
      try {
        if (index === undefined) await openProjectFlow();
        else await openRecentFlow(index);
        if (useUiStore.getState().appView === "home") await refresh();
      } finally {
        setBusy(false);
      }
    },
    [busy, refresh],
  );
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (
        !(event.ctrlKey || event.metaKey) ||
        event.altKey ||
        event.shiftKey ||
        busy ||
        useUiStore.getState().dialog ||
        useUiStore.getState().newProjectOpen
      )
        return;
      if (event.key.toLowerCase() === "o") {
        event.preventDefault();
        void open();
      }
      if (event.key.toLowerCase() === "n") {
        event.preventDefault();
        void newProjectFlow();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, busy]);
  return (
    <div className="flex h-full flex-col overflow-y-auto bg-bg text-text">
      <header className="flex h-16 shrink-0 items-center justify-between border-b px-5 sm:px-8">
        <Logo />
        <Button
          variant="ghost"
          size="icon"
          aria-label="Settings"
          onClick={() => useUiStore.getState().setSettingsOpen(true)}
        >
          <Settings />
        </Button>
      </header>
      <main className="mx-auto w-full max-w-6xl flex-1 px-5 py-10 sm:px-8 sm:py-14">
        <p className="mb-3 text-xs font-medium uppercase tracking-[0.2em] text-accent">Your editing space</p>
        <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">Let’s make your next cut.</h1>
        <p className="mt-3 text-sm text-text-muted">Start a new project or pick up where you left off.</p>
        <div className="mt-8 grid gap-3 sm:grid-cols-2">
          <button
            disabled={busy}
            onClick={() => void newProjectFlow()}
            className="flex items-center gap-4 rounded-xl border border-accent/40 bg-accent-soft p-5 text-left transition-colors hover:border-accent disabled:opacity-50"
          >
            <FilePlus2 className="size-8 shrink-0 text-accent" />
            <span className="flex-1">
              <span className="block font-semibold">New Project</span>
              <span className="mt-1 block text-sm text-text-muted">Choose a canvas and start editing</span>
            </span>
            <ArrowRight className="size-5" />
          </button>
          <button
            disabled={busy}
            onClick={() => void open()}
            className="flex items-center gap-4 rounded-xl border bg-surface-1 p-5 text-left transition-colors hover:border-accent disabled:opacity-50"
          >
            <FolderOpen className="size-8 shrink-0 text-accent" />
            <span className="flex-1">
              <span className="block font-semibold">Open Project</span>
              <span className="mt-1 block text-sm text-text-muted">Browse for a saved .cutvii file</span>
            </span>
            <ArrowRight className="size-5" />
          </button>
        </div>
        {hasSession && (
          <button
            disabled={busy}
            onClick={() => useUiStore.getState().setAppView("editor")}
            className="mt-4 flex w-full items-center justify-between gap-3 rounded-lg border border-accent/30 px-4 py-3 text-left text-sm hover:bg-surface-1 disabled:opacity-50"
          >
            <span className="truncate">
              Continue editing: {name}
              <span className="ml-2 text-text-muted">{dirty ? "Unsaved changes" : "Current session"}</span>
            </span>
            <ArrowRight className="size-4 shrink-0" />
          </button>
        )}
        <section aria-label="Recent projects" className="mt-12">
          <div className="mb-5 flex items-center justify-between gap-3">
            <h2 className="text-lg font-semibold">Recent projects</h2>
            <Button
              variant="ghost"
              size="sm"
              aria-label="Refresh projects"
              disabled={loading || busy}
              onClick={() => void refresh()}
            >
              <RefreshCw className="size-4" />
              Refresh
            </Button>
          </div>
          {loading ? (
            <p role="status" className="flex items-center gap-2 text-sm text-text-muted">
              <Loader2 className="size-4 animate-spin" />
              Loading projects…
            </p>
          ) : error ? (
            <p role="alert" className="rounded-lg border p-5 text-sm text-text-muted">
              Could not load recent projects. Refresh to retry, or use Open Project.
            </p>
          ) : projects.length === 0 ? (
            <div className="rounded-xl border border-dashed px-6 py-12 text-center">
              <FolderOpen className="mx-auto mb-3 size-9 text-text-muted" />
              <p className="text-sm font-medium">No saved projects yet</p>
              <p className="mt-1 text-sm text-text-muted">Projects you save or open will appear here.</p>
            </div>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {projects.map((project) => (
                <button
                  key={project.path}
                  disabled={busy || !project.exists}
                  onClick={() => void open(project.index)}
                  title={project.path}
                  className="group overflow-hidden rounded-xl border bg-surface-1 text-left transition-colors hover:border-accent disabled:cursor-default disabled:opacity-50"
                >
                  <div className="flex h-24 items-center justify-center border-b bg-surface-2">
                    <Film className="size-9 text-accent/70" />
                  </div>
                  <div className="p-4">
                    <h3 className="truncate font-medium">{project.name}</h3>
                    <p className="mt-1 truncate text-xs text-text-muted">{project.path}</p>
                    <p className="mt-3 text-xs text-text-muted">
                      {!project.exists
                        ? "File not found"
                        : project.modifiedAt
                          ? `Modified ${new Date(project.modifiedAt * 1000).toLocaleDateString()}`
                          : "Saved project"}
                    </p>
                  </div>
                </button>
              ))}
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
