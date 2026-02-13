import type { BarStyle } from "../types";

export const BAR_STYLE_OPTIONS: BarStyle[] = ["solid", "shaded", "ascii", "dots", "pipe"];

export const REFRESH_PRESETS = [
  { seconds: 10, label: "10s" },
  { seconds: 30, label: "30s" },
  { seconds: 60, label: "1m" },
  { seconds: 300, label: "5m" },
  { seconds: 600, label: "10m" },
  { seconds: 1800, label: "30m" },
  { seconds: 3600, label: "1h" },
];

export const SETTINGS_PAGES = [
  { key: "model-settings" as const, label: "Model Settings" },
  { key: "ui-settings" as const, label: "UI Settings" },
];
