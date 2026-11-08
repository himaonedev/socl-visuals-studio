import { Check } from "lucide-react";
import { THEMES, useThemeStore } from "@/store/theme";
import { cn } from "@/lib/utils";

export function ThemeSettings() {
  const current = useThemeStore((s) => s.theme);
  const choices = THEMES;
  return (
    <fieldset className="space-y-2 border-b pb-4">
      <legend className="mb-2 text-sm font-medium">Appearance</legend>
      <div
        role="radiogroup"
        aria-label="Colour theme"
        className="grid grid-cols-3 gap-2"
        onKeyDown={(e) => {
          if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(e.key)) return;
          e.preventDefault();
          const index = choices.findIndex((t) => t.id === current);
          const next =
            e.key === "Home"
              ? 0
              : e.key === "End"
                ? choices.length - 1
                : (index + (["ArrowLeft", "ArrowUp"].includes(e.key) ? -1 : 1) + choices.length) %
                  choices.length;
          useThemeStore.getState().setTheme(choices[next].id);
          e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]')[next]?.focus();
        }}
      >
        {choices.map((theme) => (
          <button
            key={theme.id}
            type="button"
            role="radio"
            tabIndex={current === theme.id ? 0 : -1}
            aria-checked={current === theme.id}
            aria-label={theme.name}
            onClick={() => useThemeStore.getState().setTheme(theme.id)}
            className={cn(
              "relative rounded-md border p-2 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent",
              current === theme.id ? "border-accent bg-accent-soft" : "border-border hover:border-accent/60",
            )}
          >
            <span
              className="mb-2 flex h-9 items-center gap-1 rounded px-2"
              style={{ backgroundColor: theme.bg, border: `1px solid ${theme.border}` }}
            >
              <span className="h-5 w-2 rounded-sm" style={{ background: theme.accent }} />
              <span className="h-3 flex-1 rounded-sm" style={{ background: theme.video }} />
              <span className="h-3 w-4 rounded-sm" style={{ background: theme.audio }} />
            </span>
            <span className="flex items-center justify-between gap-1 text-[11px] text-text">
              {theme.name}
              {current === theme.id && <Check className="size-3 shrink-0 text-accent" />}
            </span>
          </button>
        ))}
      </div>
      <p className="text-xs text-text-muted">
        Applies immediately and is remembered on this computer. Video and subtitle colours stay the same.
      </p>
    </fieldset>
  );
}
