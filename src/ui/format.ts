import type { BarStyle } from "../types";

export function toBar(
  progress: number,
  width: number,
  style: BarStyle,
  decimals = 0
): { fill: string; empty: string; percent: string } {
  const clampedProgress = Math.max(0, Math.min(1, progress));
  const filledWidth = Math.round(clampedProgress * width);
  const percent = (clampedProgress * 100).toFixed(decimals) + "%";

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
    case "braille": {
      // Use braille cells as 8 sub-steps per character so we can show
      // partial-cell fills (higher resolution — e.g. ~40%, 60%, 80%).
      const BRAILLE_DOT_ORDER = [1, 2, 3, 7, 4, 5, 6, 8]; // left-to-right, top-to-bottom
      const brailleForLevel = (level: number) => {
        // level: 0..8 -> set first `level` dots in BRAILLE_DOT_ORDER
        let bits = 0;
        for (let i = 0; i < level; i++) {
          const dot = BRAILLE_DOT_ORDER[i];
          if (typeof dot !== "number") {
            continue;
          }
          bits |= 1 << (dot - 1);
        }
        return String.fromCodePoint(0x2800 + bits);
      };

      const fullBraille = String.fromCodePoint(0x28FF); // ⣿ (all dots)
      const emptyBraille = "⣀"; // keep the previous empty-look for compatibility

      const cells = clampedProgress * width;
      let fullCells = Math.floor(cells);
      let subLevel = Math.round((cells - fullCells) * 8); // 0..8 sub-steps

      // if rounding made the partial cell a full one, carry it into fullCells
      if (subLevel === 8) {
        subLevel = 0;
        fullCells = Math.min(width, fullCells + 1);
      }

      const partial = subLevel > 0 ? brailleForLevel(subLevel) : "";
      fill = fullBraille.repeat(fullCells) + partial;
      const usedChars = fullCells + (partial ? 1 : 0);
      empty = emptyBraille.repeat(Math.max(0, width - usedChars));
      break;
    }
    default:
      fill = "█".repeat(filledWidth);
      empty = "░".repeat(width - filledWidth);
  }

  return { fill, empty, percent: `${percent}%` };
}
