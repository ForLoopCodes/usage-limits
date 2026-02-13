export interface ThemeDefinition {
  key: string;
  label: string;
  appBg: string;
  panelBg: string;
  panelBorder: string;
  text: string;
  muted: string;
  warning: string;
  danger: string;
  success: string;
  selectionBg: string;
  selectionText: string;
}

export const THEMES: ThemeDefinition[] = [
  {
    key: "neon-night",
    label: "Neon Night",
    appBg: "#0b1020",
    panelBg: "#121a30",
    panelBorder: "#2c3f7b",
    text: "#d7e2ff",
    muted: "#7f8cb3",
    warning: "#ffcb6b",
    danger: "#ff6b8a",
    success: "#8cff98",
    selectionBg: "#2e447f",
    selectionText: "#ffffff",
  },
  {
    key: "midnight-blue",
    label: "Midnight Blue",
    appBg: "#0a1222",
    panelBg: "#121f35",
    panelBorder: "#36507a",
    text: "#dce9ff",
    muted: "#90a8c8",
    warning: "#ffd166",
    danger: "#ff6f91",
    success: "#72f1b8",
    selectionBg: "#2a3f64",
    selectionText: "#ffffff",
  },
  {
    key: "solarized-dark",
    label: "Solarized Dark",
    appBg: "#002b36",
    panelBg: "#073642",
    panelBorder: "#586e75",
    text: "#eee8d5",
    muted: "#93a1a1",
    warning: "#b58900",
    danger: "#dc322f",
    success: "#859900",
    selectionBg: "#268bd2",
    selectionText: "#fdf6e3",
  },
  {
    key: "tokyo-night",
    label: "Tokyo Night",
    appBg: "#1a1b26",
    panelBg: "#24283b",
    panelBorder: "#414868",
    text: "#c0caf5",
    muted: "#7aa2f7",
    warning: "#e0af68",
    danger: "#f7768e",
    success: "#9ece6a",
    selectionBg: "#2f3f63",
    selectionText: "#ffffff",
  },
  {
    key: "dracula",
    label: "Dracula",
    appBg: "#282a36",
    panelBg: "#343746",
    panelBorder: "#6272a4",
    text: "#f8f8f2",
    muted: "#9ea8c7",
    warning: "#f1fa8c",
    danger: "#ff5555",
    success: "#50fa7b",
    selectionBg: "#44475a",
    selectionText: "#f8f8f2",
  },
  {
    key: "nord",
    label: "Nord",
    appBg: "#2e3440",
    panelBg: "#3b4252",
    panelBorder: "#4c566a",
    text: "#eceff4",
    muted: "#88c0d0",
    warning: "#ebcb8b",
    danger: "#bf616a",
    success: "#a3be8c",
    selectionBg: "#434c5e",
    selectionText: "#eceff4",
  },
  {
    key: "monokai-pro",
    label: "Monokai Pro",
    appBg: "#2d2a2e",
    panelBg: "#403e41",
    panelBorder: "#5b595c",
    text: "#fcfcfa",
    muted: "#bdbbb7",
    warning: "#ffd866",
    danger: "#ff6188",
    success: "#a9dc76",
    selectionBg: "#5c5a5e",
    selectionText: "#ffffff",
  },
  {
    key: "forest-matrix",
    label: "Forest Matrix",
    appBg: "#051b11",
    panelBg: "#0a2a1a",
    panelBorder: "#1f5a3d",
    text: "#c8ffd8",
    muted: "#7cc99d",
    warning: "#f7d560",
    danger: "#ff6b6b",
    success: "#4dff9a",
    selectionBg: "#14402b",
    selectionText: "#eafff1",
  },
  {
    key: "sunset-ember",
    label: "Sunset Ember",
    appBg: "#2b1e1a",
    panelBg: "#3a2924",
    panelBorder: "#7b4d3f",
    text: "#ffe7d6",
    muted: "#d6a88f",
    warning: "#ffbe76",
    danger: "#ff7675",
    success: "#55efc4",
    selectionBg: "#5c3f36",
    selectionText: "#fff3ec",
  },
  {
    key: "lavender-night",
    label: "Lavender Night",
    appBg: "#1f1a2c",
    panelBg: "#2c2440",
    panelBorder: "#5e4b8b",
    text: "#f1eaff",
    muted: "#bca8e9",
    warning: "#ffd166",
    danger: "#ff7096",
    success: "#8cf7c5",
    selectionBg: "#473866",
    selectionText: "#ffffff",
  },
  {
    key: "terminal-light",
    label: "Terminal Light",
    appBg: "#f5f7fb",
    panelBg: "#ffffff",
    panelBorder: "#c7d0e0",
    text: "#1f2937",
    muted: "#6b7280",
    warning: "#b45309",
    danger: "#b91c1c",
    success: "#047857",
    selectionBg: "#dbe7ff",
    selectionText: "#0f172a",
  },
];

export function getTheme(themeKey: string): ThemeDefinition {
  const found = THEMES.find((item) => item.key === themeKey);
  if (found) {
    return found;
  }

  const fallback = THEMES[0];
  if (!fallback) {
    throw new Error("No themes configured.");
  }

  return fallback;
}

export function nextTheme(themeKey: string): ThemeDefinition {
  const fallback = THEMES[0];
  if (!fallback) {
    throw new Error("No themes configured.");
  }

  const index = THEMES.findIndex((item) => item.key === themeKey);
  if (index === -1) {
    return fallback;
  }

  const nextIndex = (index + 1) % THEMES.length;
  return THEMES[nextIndex] ?? fallback;
}
