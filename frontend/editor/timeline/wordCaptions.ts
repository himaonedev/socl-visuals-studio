import type { TextSpec, TextStyle } from "@/project/model";

export const DEFAULT_WORD_HIGHLIGHT = {
  index: 0,
  boxColor: "#FFFFFF",
  opacity: 1,
  padding: 0.12,
  radius: 0.16,
  maxWords: 3,
};

export interface CaptionLine {
  start: number;
  duration: number;
  text: string;
}
export interface ActiveCaption extends CaptionLine {
  activeWord?: number;
}

/** Segment-only transcripts use character-weighted estimates; every boundary is a timeline frame. */
export function activeWordCaptions(
  lines: CaptionLine[],
  style: TextStyle | undefined,
  fps: number,
): ActiveCaption[] {
  const config = style?.highlight?.word;
  if (!config) return lines;
  const out: ActiveCaption[] = [];
  for (const line of lines) {
    const words = line.text.trim().split(/\s+/u).filter(Boolean);
    const from = Math.max(0, Math.round(line.start * fps));
    const to = Math.round((line.start + line.duration) * fps);
    if (to <= from || !words.length) continue;
    // More words than frames cannot have individual visible states; give each frame its current word.
    const weights = words.map((w) => Math.max(1, [...w].length));
    const total = weights.reduce((a, b) => a + b, 0);
    let used = 0;
    let boundary = from;
    for (let i = 0; i < words.length; i++) {
      used += weights[i];
      const end =
        i === words.length - 1 ? to : Math.max(boundary, Math.round(from + ((to - from) * used) / total));
      if (end > boundary) {
        const group = Math.floor(i / config.maxWords) * config.maxWords;
        out.push({
          start: boundary / fps,
          duration: (end - boundary) / fps,
          text: words.slice(group, group + config.maxWords).join(" "),
          activeWord: i - group,
        });
      }
      boundary = end;
    }
  }
  return out;
}

export function withActiveWord(spec: TextSpec, index: number | undefined): TextSpec {
  if (index === undefined || !spec.highlight?.word) return spec;
  return { ...spec, highlight: { ...spec.highlight, word: { ...spec.highlight.word, index } } };
}
