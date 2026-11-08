import { create } from "zustand";

export const THEMES = [
  { id: 'socl', name: 'SOCL Lime', accent: '#D5FF40', hover: '#E4FF84', bg: '#0A0B08', surface1: '#141610', surface2: '#1C2016', border: '#303626', video: '#586D22', audio: '#315B50', image: '#746126', transition: '#685397' },
  {
    id: "orange",
    name: "Orange",
    accent: "#E5733A",
    hover: "#F08450",
    bg: "#0B0B0C",
    surface1: "#141416",
    surface2: "#1C1C1F",
    border: "#2A2A2E",
    video: "#8A4524",
    audio: "#3F5A5C",
    image: "#7D6428",
    transition: "#5B49A8",
  },
  {
    id: "blue",
    name: "Ocean Blue",
    accent: "#6BACF4",
    hover: "#8CBFFD",
    bg: "#0B0F16",
    surface1: "#121923",
    surface2: "#1B2532",
    border: "#2C3B4E",
    video: "#284F7A",
    audio: "#315C58",
    image: "#71572C",
    transition: "#62519A",
  },
  {
    id: "violet",
    name: "Violet",
    accent: "#B89AF4",
    hover: "#CEB7FF",
    bg: "#100C16",
    surface1: "#191421",
    surface2: "#241D30",
    border: "#3B304B",
    video: "#5E3F7C",
    audio: "#345C5E",
    image: "#75562F",
    transition: "#3C5786",
  },
  {
    id: "mint",
    name: "Mint",
    accent: "#64D3BF",
    hover: "#88E5D4",
    bg: "#0A1110",
    surface1: "#111D1B",
    surface2: "#1A2926",
    border: "#2D423D",
    video: "#285D54",
    audio: "#3B4F78",
    image: "#75522F",
    transition: "#69518C",
  },
  {
    id: "rose",
    name: "Rose",
    accent: "#F297B1",
    hover: "#FFB2C7",
    bg: "#150C10",
    surface1: "#21141B",
    surface2: "#2E1D26",
    border: "#49313E",
    video: "#793E56",
    audio: "#345C65",
    image: "#71602E",
    transition: "#65518E",
  },
  {
    id: "graphite",
    name: "Graphite",
    accent: "#C1C9D5",
    hover: "#E1E6ED",
    bg: "#0C0E11",
    surface1: "#15181D",
    surface2: "#20242B",
    border: "#343B46",
    video: "#48515F",
    audio: "#375B5B",
    image: "#696047",
    transition: "#5A5177",
  },
  {
    id: "gold",
    name: "Gold",
    accent: "#E5C15C",
    hover: "#F2D582",
    bg: "#121008",
    surface1: "#1C1911",
    surface2: "#282319",
    border: "#423A27",
    video: "#6C5727",
    audio: "#35565C",
    image: "#70502C",
    transition: "#60517E",
  },
  {
    id: "cyan",
    name: "Cyan",
    accent: "#6BD5EF",
    hover: "#99E4F7",
    bg: "#091115",
    surface1: "#111D23",
    surface2: "#1A2A32",
    border: "#2B424D",
    video: "#285D70",
    audio: "#355C50",
    image: "#716030",
    transition: "#60528A",
  },
  {
    id: "emerald",
    name: "Emerald",
    accent: "#7ED897",
    hover: "#A3E9B6",
    bg: "#0A120D",
    surface1: "#121E17",
    surface2: "#1C2B21",
    border: "#304635",
    video: "#326344",
    audio: "#395675",
    image: "#6D5C2D",
    transition: "#65507C",
  },
  {
    id: "crimson",
    name: "Crimson",
    accent: "#EF8290",
    hover: "#FFA6B0",
    bg: "#150B0E",
    surface1: "#211317",
    surface2: "#2F1C22",
    border: "#4B2F37",
    video: "#783C48",
    audio: "#345B61",
    image: "#73602E",
    transition: "#605080",
  },
  {
    id: "sunset",
    name: "Sunset",
    accent: "#F3A483",
    hover: "#FFC2A7",
    bg: "#160E12",
    surface1: "#23171F",
    surface2: "#30212C",
    border: "#4A3443",
    video: "#79503E",
    audio: "#3B5B62",
    image: "#77602D",
    transition: "#66507D",
  },
  {
    id: "coffee",
    name: "Coffee",
    accent: "#D5AA83",
    hover: "#E9C7A5",
    bg: "#120F0C",
    surface1: "#1D1915",
    surface2: "#29231E",
    border: "#41382F",
    video: "#69503A",
    audio: "#3F5955",
    image: "#70602F",
    transition: "#605476",
  },
] as const;
export type ThemeId = (typeof THEMES)[number]["id"];
export const THEME_STORAGE_KEY = "socl-editor-theme-v1";
export const validTheme = (id: unknown): id is ThemeId => THEMES.some((t) => t.id === id);
export function readTheme(): ThemeId {
  try {
    const id = localStorage.getItem(THEME_STORAGE_KEY);
    // Retired custom palettes open with a ready-made blue palette.
    if (id === "custom") return "blue";
    return validTheme(id) ? id : "socl";
  } catch {
    return "socl";
  }
}
/** Build palette rules once; switches only change a single root attribute. */
function ensureThemeStyles() {
  if (document.getElementById("cutvii-theme-palettes")) return;
  const stylesheet = document.createElement("style");
  stylesheet.id = "cutvii-theme-palettes";
  stylesheet.textContent = THEMES.map((theme) => {
    const colour = theme.accent;
    const rgb = [1, 3, 5].map((i) => parseInt(colour.slice(i, i + 2), 16)).join(", ");
    const values = {
      "--text": "#F2F0ED",
      "--text-muted": "#9A968F",
      "--accent": colour,
      "--accent-hover": theme.hover,
      "--accent-soft": `rgba(${rgb}, 0.15)`,
      "--bg": theme.bg,
      "--surface-1": theme.surface1,
      "--surface-2": theme.surface2,
      "--border": theme.border,
      "--clip-video": theme.video,
      "--clip-audio": theme.audio,
      "--clip-image": theme.image,
      "--clip-transition": theme.transition,
    };
    return `:root[data-theme="${theme.id}"] {${Object.entries(values)
      .map(([key, value]) => `${key}:${value};`)
      .join("")}}`;
  }).join("\n");
  document.head.append(stylesheet);
}
let switchFrame: number | undefined;
export function applyTheme(id: ThemeId) {
  if (typeof document === "undefined") return;
  ensureThemeStyles();
  const root = document.documentElement;
  if (root.dataset.theme === id) return;
  // Avoid animating every coloured control during an app-wide palette change.
  root.dataset.themeSwitching = "";
  root.dataset.theme = id;
  if (switchFrame !== undefined) cancelAnimationFrame(switchFrame);
  switchFrame = requestAnimationFrame(() => {
    switchFrame = requestAnimationFrame(() => {
      delete root.dataset.themeSwitching;
      switchFrame = undefined;
    });
  });
}
export const useThemeStore = create<{
  theme: ThemeId;
  setTheme: (id: ThemeId) => void;
}>((set, get) => ({
  theme: readTheme(),
  setTheme: (id) => {
    if (!validTheme(id) || (get().theme === id && document.documentElement.dataset.theme === id)) return;
    set({ theme: id });
    applyTheme(id);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, id);
    } catch {
      /* Preferences stay usable without storage. */
    }
  },
}));
/** Apply the saved palette before mounting React. */
export function initializeTheme() {
  applyTheme(useThemeStore.getState().theme);
}

