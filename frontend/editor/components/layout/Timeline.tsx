import { useMarqueeSelection } from "@/timeline/useMarqueeSelection";
import { useWorkspaceStore } from "@/store/workspace";
import { selectTimelineClip, selectTimelineKind, type ClipSelectionKind } from "@/timeline/timelineSelection";
import { formatTimecode } from "@/lib/timecode";
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {


  Magnet,
  Maximize2,


  Scissors,

  Trash2,
  Type,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { useTrackLocksStore, trackLockKey } from "@/store/trackLocks";
import { TrackHeader } from "@/components/timeline/TrackHeader";
import { ClipView } from "@/components/timeline/ClipView";
import { TransitionBlock } from "@/components/timeline/TransitionBlock";
import { TooLongBadge } from "@/components/inspector/CaptionCheck";
import { ContextMenu, type MenuState } from "@/components/timeline/ContextMenu";
import { Ruler } from "@/components/timeline/Ruler";
import { IconButton } from "@/components/IconButton";
import { Panel } from "@/components/Panel";
import { assetName } from "@/lib/media";
import { cn } from "@/lib/utils";
import { useDragDropStore } from "@/store/dragDrop";
import { usePlaybackStore } from "@/store/playback";
import { useProjectStore } from "@/store/project";
import { useSelectionStore } from "@/store/selection";
import { useTimelineViewStore } from "@/store/timelineView";
import { clipDuration, projectDuration, findClip } from "@/timeline/clips";



import { exportSrt, textTrackOf } from "@/timeline/srt";
import { resplitNotice, resplitTrack } from "@/timeline/resplit";
import { useUiStore } from "@/store/ui";
import { copySelected, cutSelected } from "@/timeline/clipboard";
import { freezeFrameAtPlayhead } from "@/timeline/freeze";
import { deleteSelected, report, splitAtPlayhead } from "@/timeline/editor";
import { transitionOf, transitionOutOf } from "@/timeline/transitions";
import {
  contentWidth,
  HEADER_WIDTH,
  ROW_HEIGHT,
  RULER_HEIGHT,
  timeToX,
  visibleClips,
  xToTime,
} from "@/timeline/geometry";
import { addTextAtPlayhead } from "@/timeline/text";
import { waveWindow } from "@/timeline/waveform";
import { canZoomIn, canZoomOut, zoomPercent } from "@/timeline/zoom";
import { zoomStep, zoomToFit } from "@/timeline/zoomController";
import { layerLayout } from "@/timeline/layerLayout";
import { useTimelineDrag } from "@/timeline/useTimelineDrag";

const FALLBACK_VIEWPORT = 1000;
const BUFFER_PX = 200;

function Playhead({ pps, ruler = false }: { pps: number; ruler?: boolean }) {
  const playhead = usePlaybackStore((s) => s.playhead);
  return (
    <div
      aria-hidden
      data-testid={ruler ? "ruler-playhead" : "playhead"}
      className="pointer-events-none absolute top-0 bottom-0 z-20 w-px bg-accent"
      style={{ left: timeToX(playhead, pps), top: ruler ? 0 : RULER_HEIGHT }}
    >
      <div className="-ml-[5px] h-[10px] w-[11px] rounded-b-sm bg-accent" />
    </div>
  );
}

export function Timeline() {
  const mode = useWorkspaceStore(s => s.mode);
  const project = useProjectStore((s) => s.project);

  const trackLocks = useTrackLocksStore((s) => s.locks);
  const selectedIds = useSelectionStore((s) => s.selectedClipIds);
  const pps = useTimelineViewStore((s) => s.pps);
  const trackHeights = useTimelineViewStore((s) => s.trackHeights);
  const snapping = useTimelineViewStore((s) => s.snapping);
  const toggleSnapping = useTimelineViewStore((s) => s.toggleSnapping);
  const scrollTarget = useTimelineViewStore((s) => s.scrollTarget);
  const dropPreview = useDragDropStore((s) => s.preview);

  const scrollerRef = useRef<HTMLDivElement>(null);
  const lanesRef = useRef<HTMLDivElement>(null);
  const marquee = useMarqueeSelection(lanesRef);
  const [viewport, setViewport] = useState({ left: 0, width: 0, height: 0 });
  const [menu, setMenu] = useState<MenuState | null>(null);
  const { drag, begin } = useTimelineDrag(lanesRef);

  // Track scroll position and size so only visible ticks/clips are rendered.
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const measure = () =>
      setViewport((previous) => {
        const next = {
          left: el.scrollLeft,
          width: Math.max(0, el.clientWidth - HEADER_WIDTH),
          height: el.clientHeight,
        };
        return previous.left === next.left && previous.width === next.width && previous.height === next.height
          ? previous
          : next;
      });
    measure();
    el.addEventListener("scroll", measure, { passive: true });
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    ro?.observe(el);
    return () => {
      el.removeEventListener("scroll", measure);
      ro?.disconnect();
    };
  }, []);

  const view = drag?.preview ?? project;
  const assets = useMemo(() => new Map(project.assets.map((a) => [a.id, a])), [project.assets]);
  const selected = useMemo(() => new Set(selectedIds), [selectedIds]);
  const missingPaths = useProjectStore((s) => s.missingPaths);
  const missing = useMemo(() => new Set(missingPaths), [missingPaths]);
  const vw = viewport.width || FALLBACK_VIEWPORT;
  const from = xToTime(viewport.left - BUFFER_PX, pps);
  const to = xToTime(viewport.left + vw + BUFFER_PX, pps);
  const width = contentWidth(projectDuration(view), vw, pps);
  const appliedScrollTarget = useRef<typeof scrollTarget>(null);
  // Width can shrink below the previous scroll after zoom/delete/resize. Clamp before windowing
  // visible clips, including when the browser does not dispatch another scroll event.
  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const laneWidth = el.clientWidth ? Math.max(0, el.clientWidth - HEADER_WIDTH) : FALLBACK_VIEWPORT;
    const requested =
      scrollTarget && scrollTarget !== appliedScrollTarget.current ? scrollTarget.left : el.scrollLeft;
    el.scrollLeft = Math.max(0, Math.min(Math.max(0, width - laneWidth), requested));
    appliedScrollTarget.current = scrollTarget;
    setViewport((previous) => {
      const next = { left: el.scrollLeft, width: el.clientWidth ? laneWidth : 0, height: el.clientHeight };
      return previous.left === next.left && previous.width === next.width && previous.height === next.height
        ? previous
        : next;
    });
  }, [scrollTarget, width]);

  const onBodyPointerDown = useCallback(
    (e: React.PointerEvent, clip: { id: string }) => {
      if (e.button !== 0) return;
      if (e.currentTarget instanceof HTMLElement) e.currentTarget.focus({ preventScroll: true });
      e.preventDefault();
      const additive = e.shiftKey || e.metaKey || e.ctrlKey;
      const sel = useSelectionStore.getState();
      if (additive || !sel.selectedClipIds.includes(clip.id))
        selectTimelineClip(useProjectStore.getState().project, clip.id, e);
      if (!additive) begin(e, clip.id, "move");
    },
    [begin],
  );
  const onTrimPointerDown = useCallback(
    (e: React.PointerEvent, clip: { id: string }, edge: "start" | "end") => {
      useSelectionStore.getState().select(clip.id);
      begin(e, clip.id, { trim: edge });
    },
    [begin],
  );
  const onContextMenu = useCallback((e: React.MouseEvent, clip: { id: string }) => {
    e.preventDefault();
    const sel = useSelectionStore.getState();
    if (!sel.selectedClipIds.includes(clip.id)) sel.select(clip.id);
    setMenu({ x: e.clientX, y: e.clientY, clipId: clip.id });
  }, []);
  const onActivate = useCallback(
    (clip: { id: string }, modifiers: { shiftKey?: boolean; ctrlKey?: boolean; metaKey?: boolean }) => {
      selectTimelineClip(useProjectStore.getState().project, clip.id, modifiers);
    },
    [],
  );
  const closeMenu = useCallback(() => setMenu(null), []);

  // while a drop would create a track, draw the row it will occupy
  const newTrackRow = dropPreview && dropPreview.trackId === null;
  const layout = layerLayout(view.tracks, trackHeights);
  const height = RULER_HEIGHT + layout.height;
  const insertionTop = newTrackRow
    ? dropPreview.beforeTrackId && layout.tracks.some((t) => t.id === dropPreview.beforeTrackId)
      ? layout.top(dropPreview.beforeTrackId)
      : layout.zones[dropPreview.trackType]
    : 0;
  const ghost = dropPreview && (
    <div
      data-testid="drop-ghost"
      className="pointer-events-none absolute top-1 bottom-1 z-10 flex items-center overflow-hidden rounded-md border-2 border-dashed border-accent bg-accent-soft px-2 text-xs text-text"
      style={{
        left: timeToX(dropPreview.start, pps),
        width: Math.max(24, timeToX(dropPreview.duration, pps)),
      }}
    >
      <span className="truncate">{dropPreview.hint ?? dropPreview.label}</span>
    </div>
  );

  return (
    <Panel
      title="Timeline"
      className="min-h-0 overflow-hidden border-t lg:col-span-3 lg:row-start-2"
      headerClassName="h-auto min-h-10 flex-wrap gap-2 py-1"
      actions={
        <div className="flex min-w-0 flex-wrap items-center justify-end gap-y-1">
          
          
          
          
          
          {mode === 'caption' && <IconButton label="Add text at playhead" icon={<Type />} onClick={() => void addTextAtPlayhead()} />}
          <IconButton
            label="Split at playhead (S)"
            icon={<Scissors />}
            onClick={() => report(splitAtPlayhead())}
          />
          <select
            aria-label="Select timeline clips"
            title="Ctrl+click: toggle · Shift+click: range · Drag empty space: box select · Ctrl+A: all"
            value=""
            className="h-8 w-24 rounded-md border bg-surface-2 px-2 text-xs"
            onChange={(e) => {
              selectTimelineKind(useProjectStore.getState().project, e.target.value as ClipSelectionKind);
              lanesRef.current?.focus({ preventScroll: true });
            }}
          >
            <option value="" disabled>
              Select…
            </option>
            <option value="all">All clips</option>
            <option value="text">Text / subtitles</option>
            <option value="video">Videos</option>
            <option value="audio">Audio</option>
            <option value="image">Images</option>
            <option value="clear">Clear selection</option>
          </select>
          <IconButton
            label="Delete selected (Del)"
            icon={<Trash2 />}
            disabled={selectedIds.length === 0}
            onClick={() => deleteSelected()}
          />
          <IconButton
            label={snapping ? "Snapping on" : "Snapping off"}
            icon={<Magnet />}
            aria-pressed={snapping}
            className={cn(snapping && "text-accent")}
            onClick={toggleSnapping}
          />
          <IconButton
            label="Zoom out"
            shortcut="Ctrl/⌘ −"
            icon={<ZoomOut />}
            disabled={!canZoomOut(pps)}
            onClick={() => zoomStep(-1)}
          />
          <span
            className="w-12 text-center text-xs text-text-muted tabular-nums"
            aria-label="Zoom level"
            aria-live="off"
          >
            {zoomPercent(pps)}%
          </span>
          <IconButton
            label="Zoom in"
            shortcut="Ctrl/⌘ +"
            icon={<ZoomIn />}
            disabled={!canZoomIn(pps)}
            onClick={() => zoomStep(1)}
          />
          <IconButton label="Fit project" shortcut="Ctrl/⌘ 0" icon={<Maximize2 />} onClick={zoomToFit} />
        </div>
      }
    >
      {/* One scroll owner keeps tracks, headers and ruler in the same coordinate system. */}
      <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden select-none" data-timeline-area>
        <div
          ref={scrollerRef}
          data-timeline-scroller
          data-timeline-shared-scroll
          className="relative isolate flex min-h-0 min-w-0 flex-1 items-start overflow-auto overscroll-contain"
        >
          <div
            data-timeline-surface
            className="relative flex shrink-0 items-start"
            style={{ width: HEADER_WIDTH + width, minHeight: Math.max(height, viewport.height) }}
          >
            {/* track headers */}
            <div
              className="sticky left-0 z-40 shrink-0 border-r bg-surface-1"
              data-timeline-headers
              style={{ width: HEADER_WIDTH, minHeight: Math.max(height, viewport.height) }}
            >
              <div
                style={{ height: RULER_HEIGHT }}
                className="sticky top-0 z-50 border-b bg-surface-1"
                data-timeline-corner
              />
              {layout.tracks.map((t) => (
                <div
                  key={t.id}
                  style={{
                    height: layout.rowHeight(t.id),
                    position: "absolute",
                    top: RULER_HEIGHT + layout.top(t.id),
                    left: 0,
                    right: 0,
                  }}
                  className="border-b"
                >
                  <TrackHeader track={t} />
                </div>
              ))}
              {(["video", "audio"] as const).map((type) => (
                <div
                  key={type}
                  className="absolute inset-x-0 flex items-center border-b border-dashed px-2 text-[10px] text-text-muted"
                  style={{ top: RULER_HEIGHT + layout.zones[type], height: ROW_HEIGHT }}
                >
                  {type === "video" ? "VIDEO / IMAGES" : "AUDIO"}
                </div>
              ))}
            </div>

            <div
              className="relative shrink-0"
              data-timeline-content
              style={{ width, height: Math.max(height, viewport.height) }}
            >
              <div
                className="sticky top-0 z-30 bg-surface-1"
                style={{ height: RULER_HEIGHT }}
                data-timeline-ruler
              >
                <Ruler pps={pps} from={from} to={to} />
                <Playhead pps={pps} ruler />
              </div>

              <div
                ref={lanesRef}
                data-timeline-lanes
                tabIndex={-1}
                onPointerDown={marquee.begin}
                className="absolute inset-x-0"
                style={{ top: RULER_HEIGHT, height: layout.height }}
              >
                {marquee.box && (
                  <div
                    data-testid="timeline-selection-box"
                    className="pointer-events-none absolute z-20 border border-accent bg-accent/15"
                    style={marquee.box}
                  />
                )}
                {layout.tracks.map((track) => (
                  <div
                    key={track.id}
                    role="group"
                    aria-label={`${track.name} lane`}
                    data-track-id={track.id}
                    data-locked={trackLocks[trackLockKey(project.id, track.id)] || undefined}
                    className={cn(
                      "absolute inset-x-0 border-b bg-surface-2/40",
                      trackLocks[trackLockKey(project.id, track.id)] &&
                        "[&_[data-clip-id]]:cursor-not-allowed",
                      dropPreview?.trackId === track.id &&
                        "bg-accent-soft outline outline-1 -outline-offset-1 outline-accent",
                    )}
                    data-drop-active={dropPreview?.trackId === track.id || undefined}
                    style={{ height: layout.rowHeight(track.id), top: layout.top(track.id) }}
                  >
                    {visibleClips(track.clips, from, to).map((clip) => {
                      const asset = assets.get(clip.assetId);
                      const hasWave = asset && asset.type !== "image" && !missing.has(asset.path);
                      const wave = hasWave
                        ? waveWindow(
                            timeToX(clip.timelineStart, pps),
                            timeToX(clipDuration(clip), pps),
                            viewport.left - BUFFER_PX,
                            viewport.left + vw + BUFFER_PX,
                          )
                        : null;
                      const coming = transitionOf(clip);
                      const going = transitionOutOf(clip);
                      return (
                        <Fragment key={clip.id}>
                          <ClipView
                            clip={clip}
                            name={asset ? assetName(asset) : "Missing media"}
                            // a video's detached sound looks like the audio it is
                            type={track.type === "audio" ? "audio" : (asset?.type ?? "video")}
                            pps={pps}
                            selected={selected.has(clip.id)}
                            missing={asset ? missing.has(asset.path) : true}
                            wavePath={wave ? asset?.path : undefined}
                            waveFrom={wave?.from}
                            waveTo={wave?.to}
                            muted={track.muted || (clip.muted ?? false)}
                            onBodyPointerDown={onBodyPointerDown}
                            onTrimPointerDown={onTrimPointerDown}
                            onContextMenu={onContextMenu}
                            onActivate={onActivate}
                          />
                          {asset?.text && (
                            <TooLongBadge spec={asset.text} left={timeToX(clip.timelineStart, pps) + 2} />
                          )}
                          {/* a transition is a block of its own over its end of the clip, not part of the clip */}
                          {coming && clip.transitionIn && (
                            <TransitionBlock clip={clip} way="in" seconds={coming.seconds} pps={pps} />
                          )}
                          {going && clip.transitionOut && (
                            <TransitionBlock clip={clip} way="out" seconds={going.seconds} pps={pps} />
                          )}
                        </Fragment>
                      );
                    })}
                    {dropPreview?.trackId === track.id && ghost}
                    {/* ghost for a rejected move, so the user sees where it would have landed */}
                    {drag?.kind === "move" && !drag.valid && drag.trackId === track.id && (
                      <div
                        data-testid="drag-ghost"
                        className="pointer-events-none absolute top-1 bottom-1 rounded-md border-2 border-dashed border-danger bg-danger/10"
                        style={{ left: timeToX(drag.start, pps), width: timeToX(drag.duration, pps) }}
                      />
                    )}
                  </div>
                ))}
                {(["video", "audio"] as const).map((type) => (
                  <div
                    key={type}
                    data-layer-zone={type}
                    aria-label={`Add ${type === "video" ? "video or image" : "audio"} layer`}
                    className="absolute inset-x-0 flex items-center border-b border-dashed bg-surface-1/60 px-4 text-xs text-text-muted"
                    style={{ top: layout.zones[type], height: ROW_HEIGHT }}
                  >
                    <span className="sticky left-32">
                      {type === "video"
                        ? "Drop video or image here to create a new visual layer"
                        : "Drop audio here to create a new audio layer"}
                    </span>
                  </div>
                ))}
                {newTrackRow && (
                  <div
                    data-testid="new-track-row"
                    className="pointer-events-none absolute inset-x-0 z-10 border-t-2 border-dashed border-accent bg-accent-soft"
                    style={{ height: ROW_HEIGHT, top: insertionTop }}
                  >
                    <span className="pointer-events-none sticky top-1 left-32 text-[10px] text-text-muted">
                      New {dropPreview.trackType} layer
                    </span>
                    {ghost}
                  </div>
                )}
              </div>

              {project.tracks.every((t) => t.clips.length === 0) && (
                <p
                  className="pointer-events-none absolute right-0 left-0 z-0 px-4 text-center text-xs text-text-muted"
                  style={{ top: RULER_HEIGHT + layout.height + 12 }}
                >
                  Drag media from the library onto a track, or use the “Add to timeline” button on a file.
                </p>
              )}
              {/* while a clip is moved: how far it has gone, next to the pointer */}
              {drag?.kind === "move" && (
                <div
                  aria-hidden
                  data-testid="move-delta"
                  className="pointer-events-none fixed z-[70] rounded-md border bg-popover px-2 py-1 text-xs tabular-nums shadow-lg"
                  style={{ left: drag.pointer.x + 14, top: drag.pointer.y + 18 }}
                >
                  {drag.copy && <span>Copy · </span>}
                  {drag.delta < 0 ? "-" : "+"}
                  {formatTimecode(Math.abs(drag.delta), project.settings.fps)}
                </div>
              )}
              {drag?.guide != null && (
                <div
                  aria-hidden
                  data-testid="snap-guide"
                  className="pointer-events-none absolute top-0 bottom-0 z-10 w-px bg-accent-hover"
                  style={{ left: timeToX(drag.guide, pps) }}
                />
              )}
              <Playhead pps={pps} />
            </div>
          </div>
        </div>
      </div>

      {menu && (
        <ContextMenu
          menu={menu}
          onClose={closeMenu}
          onMotion={
            findClip(project, menu.clipId)?.track.type === "video"
              ? () => {
                  const found = findClip(project, menu.clipId)!;
                  const asset = project.assets.find((a) => a.id === found.clip.assetId);
                  closeMenu();
                  useSelectionStore.getState().select(menu.clipId);
                  const ui = useUiStore.getState();
                  ui.setSidePanel("inspector");
                  ui.setInspectorTab(asset?.type === "video" ? "video" : "image", "motion");
                  ui.focusInspectorTab("motion");
                }
              : undefined
          }
          onSplit={() => {
            closeMenu();
            report(splitAtPlayhead());
          }}
          onFreeze={() => {
            closeMenu();
            void freezeFrameAtPlayhead();
          }}
          onCut={() => {
            closeMenu();
            cutSelected();
          }}
          onCopy={() => {
            closeMenu();
            copySelected();
          }}
          onDelete={() => {
            closeMenu();
            deleteSelected();
          }}
          onAi={undefined}
          onClips={undefined}
          onSrt={
            textTrackOf(project, menu.clipId)
              ? () => {
                  closeMenu();
                  void exportSrt(menu.clipId);
                }
              : undefined
          }
          onResplit={
            textTrackOf(project, menu.clipId)
              ? () => {
                  closeMenu();
                  const trackId = textTrackOf(project, menu.clipId)!;
                  void resplitTrack(trackId).then((r) => useUiStore.getState().setNotice(resplitNotice(r)));
                }
              : undefined
          }
        />
      )}
    </Panel>
  );
}
