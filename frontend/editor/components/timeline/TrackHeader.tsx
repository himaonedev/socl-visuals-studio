import { useState } from "react";
import { Menu } from "@base-ui/react/menu";
import {
  Lock,
  Unlock,
  Check,
  ChevronRight,
  Eye,
  EyeOff,
  Film,
  AudioLines,
  MoreHorizontal,
  Trash2,
  Volume2,
  VolumeX,
} from "lucide-react";
import type { TimelineTrack } from "@/project/model";
import { IconButton } from "@/components/IconButton";
import { useProjectStore } from "@/store/project";
import { useTrackLocksStore, trackLockKey } from "@/store/trackLocks";
import { useTimelineViewStore } from "@/store/timelineView";
import { deleteTimelineTrack, report, toggleTrackFlag } from "@/timeline/editor";
import { cn } from "@/lib/utils";

const item =
  "flex min-h-8 cursor-default items-center gap-2 rounded px-2 py-1.5 text-xs outline-none data-[highlighted]:bg-accent-soft";
const popup =
  "min-w-44 rounded-md border bg-popover p-1 text-text shadow-xl outline-none max-h-[var(--available-height)] overflow-y-auto";

export function TrackHeader({ track: t }: { track: TimelineTrack }) {
  const [open, setOpen] = useState(false);
  const projectId = useProjectStore((s) => s.project.id);
  const locked = useTrackLocksStore((s) => s.locks[trackLockKey(projectId, t.id)] === true);
  const height = useTimelineViewStore((s) => s.trackHeights[t.id] ?? 64);
  const wave = useTimelineViewStore((s) => s.waveformSizes[t.id] ?? 1);
  return (
    <div
      className="group flex h-full flex-col justify-center gap-1 px-1"
      onContextMenu={(e) => {
        e.preventDefault();
        setOpen(true);
      }}
    >
      <div className="flex items-center gap-0.5">
        <span
          title={t.name}
          className="flex w-3 shrink-0 items-center justify-center text-text-muted [&_svg]:size-3"
        >
          {t.type === "video" ? <Film aria-hidden /> : <AudioLines aria-hidden />}
        </span>
        <IconButton
          label={locked ? `Unlock ${t.name}` : `Lock ${t.name}`}
          icon={locked ? <Lock /> : <Unlock />}
          className={cn("size-5 [&_svg]:size-3", locked && "text-accent")}
          aria-pressed={locked}
          onClick={() => useTrackLocksStore.getState().toggle(projectId, t.id)}
        />
        {t.type === "video" && (
          <IconButton
            label={t.hidden ? `Show ${t.name}` : `Hide ${t.name}`}
            icon={t.hidden ? <EyeOff /> : <Eye />}
            className={cn("size-5 [&_svg]:size-3", t.hidden && "text-accent")}
            aria-pressed={t.hidden}
            onClick={() => toggleTrackFlag(t.id, "hidden")}
          />
        )}
        <IconButton
          label={t.muted ? `Unmute ${t.name}` : `Mute ${t.name}`}
          icon={t.muted ? <VolumeX /> : <Volume2 />}
          className={cn("size-5 [&_svg]:size-3", t.muted && "text-accent")}
          aria-pressed={t.muted}
          onClick={() => toggleTrackFlag(t.id, "muted")}
        />
        <Menu.Root open={open} onOpenChange={setOpen}>
          <Menu.Trigger
            aria-label={`Track options for ${t.name}`}
            title={`Track options for ${t.name}`}
            className="flex size-5 shrink-0 items-center justify-center rounded text-text-muted hover:bg-accent-soft hover:text-text outline-none focus-visible:ring-1 focus-visible:ring-accent"
          >
            <MoreHorizontal className="size-3" />
          </Menu.Trigger>
          <Menu.Portal>
            <Menu.Positioner side="right" align="start" sideOffset={6} className="z-[90]">
              <Menu.Popup aria-label={`Options for ${t.name}`} className={popup}>
                <Menu.SubmenuRoot>
                  <Menu.SubmenuTrigger className={item}>
                    Track height
                    <ChevronRight className="ml-auto size-3" />
                  </Menu.SubmenuTrigger>
                  <Menu.Portal>
                    <Menu.Positioner side="right" align="start" sideOffset={4} className="z-[91]">
                      <Menu.Popup aria-label="Track height" className={popup}>
                        <Menu.RadioGroup
                          value={height}
                          onValueChange={(v) =>
                            useTimelineViewStore.getState().setTrackHeight(t.id, Number(v))
                          }
                        >
                          {(
                            [
                              [40, "Compact"],
                              [64, "Normal"],
                              [96, "Large"],
                              [128, "Extra large"],
                            ] as const
                          ).map(([v, label]) => (
                            <Menu.RadioItem key={v} value={v} closeOnClick className={item}>
                              <span className="w-3">{height === v && <Check className="size-3" />}</span>
                              {label}
                            </Menu.RadioItem>
                          ))}
                        </Menu.RadioGroup>
                      </Menu.Popup>
                    </Menu.Positioner>
                  </Menu.Portal>
                </Menu.SubmenuRoot>
                <Menu.SubmenuRoot>
                  <Menu.SubmenuTrigger className={item}>
                    Audio waveform size
                    <ChevronRight className="ml-auto size-3" />
                  </Menu.SubmenuTrigger>
                  <Menu.Portal>
                    <Menu.Positioner side="right" align="start" sideOffset={4} className="z-[91]">
                      <Menu.Popup aria-label="Audio waveform size" className={popup}>
                        <Menu.RadioGroup
                          value={wave}
                          onValueChange={(v) =>
                            useTimelineViewStore.getState().setWaveformSize(t.id, Number(v))
                          }
                        >
                          {(
                            [
                              [0, "Hidden"],
                              [0.5, "Small"],
                              [1, "Normal"],
                              [1.5, "Large"],
                            ] as const
                          ).map(([v, label]) => (
                            <Menu.RadioItem key={v} value={v} closeOnClick className={item}>
                              <span className="w-3">{wave === v && <Check className="size-3" />}</span>
                              {label}
                            </Menu.RadioItem>
                          ))}
                        </Menu.RadioGroup>
                      </Menu.Popup>
                    </Menu.Positioner>
                  </Menu.Portal>
                </Menu.SubmenuRoot>
                <Menu.Separator className="my-1 h-px bg-border" />
                <Menu.Item
                  aria-label={`Delete ${t.name} track`}
                  disabled={locked}
                  className={cn(item, "text-danger")}
                  onClick={() => report(deleteTimelineTrack(t.id))}
                >
                  <Trash2 className="size-3" />
                  Delete track
                </Menu.Item>
              </Menu.Popup>
            </Menu.Positioner>
          </Menu.Portal>
        </Menu.Root>
      </div>
    </div>
  );
}
