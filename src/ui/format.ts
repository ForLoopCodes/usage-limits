import type { BarStyle } from "../types";

export function toBar(
  progress: number,
  width: number,
  style: BarStyle
): { fill: string; empty: string; percent: string } {
  const clampedProgress = Math.max(0, Math.min(1, progress));
  const filledWidth = Math.round(clampedProgress * width);
  const percent = Math.round(clampedProgress * 100);

  let fill: string;
  let empty: string;

  switch (style) {
    case "solid":
      fill = "█".repeat(filledWidth);
      empty = "░".repeat(width - filledWidth);
      break;
    case "shaded":
      fill = "▓".repeat(filledWidth);
      empty = "░".repeat(width - filledWidth);
      break;
    case "ascii":
      fill = "=".repeat(filledWidth);
      empty = "-".repeat(width - filledWidth);
      break;
    case "dots":
      fill = "●".repeat(filledWidth);
      empty = "○".repeat(width - filledWidth);
      break;
    case "pipe":
      fill = "|".repeat(filledWidth);
      empty = " ".repeat(width - filledWidth);
      break;
    default:
      fill = "█".repeat(filledWidth);
      empty = "░".repeat(width - filledWidth);
  }

  return { fill, empty, percent: `${percent}%` };
}
