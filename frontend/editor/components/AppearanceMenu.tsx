import { Popover } from "@base-ui/react/popover";
import { Palette, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ThemeSettings } from "./ThemeSettings";
import { THEMES, useThemeStore } from "@/store/theme";

/** Direct access from the editor header; palette changes are live and kept locally. */
export function AppearanceMenu() {
  const theme = useThemeStore((s) => s.theme);
  return (
    <Popover.Root>
      <Popover.Trigger
        render={<Button variant="ghost" size="sm" />}
        aria-label="Appearance"
        title={`Appearance: ${THEMES.find((t) => t.id === theme)?.name}`}
        className="shrink-0 gap-1.5"
      >
        <Palette className="size-4" />
        <span className="hidden md:inline">Appearance</span>
        <ChevronDown className="size-3" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="end" sideOffset={8} className="z-[80]">
          <Popover.Popup
            aria-label="Appearance"
            className="w-[360px] max-w-[calc(100vw-24px)] max-h-[var(--available-height)] overflow-y-auto rounded-lg border bg-popover p-4 text-text shadow-xl outline-none"
            onKeyDown={(e) => {
              if (e.key !== "Escape") e.stopPropagation();
            }}
          >
            <Popover.Title className="sr-only">Appearance</Popover.Title>
            <ThemeSettings />
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
