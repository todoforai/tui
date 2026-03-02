/** ASCII block logo — adapted from CLI to return strings instead of writing to stderr */

const LETTERS: Record<string, string[]> = {
  t: [" x  ", "xxxx", " x  ", " xll", " xll", " xxx"],
  o: ["    ", "xxxx", "x  x", "xllx", "xllx", "xxxx"],
  d: ["   x", "xxxx", "x  x", "xllx", "xllx", "xxxx"],
  f: ["  xx", " x  ", "xxxx", "lxll", "lxll", "lxll"],
  r: ["    ", "x xx", "xx  ", "xlll", "xlll", "xlll"],
  c: ["    ", "xxxx", "x   ", "xlll", "xlll", "xxxx"],
  e: ["    ", "xxxx", "x  x", "xxxx", "xlll", "xxxx"],
  a: ["    ", "xxxx", "   x", "xxxx", "xllx", "xxxx"],
  i: ["x", " ", "x", "x", "x", "x"],
  "4": ["    ", "  x ", " xx ", "xlxl", "xxxx", "llxl"],
};

const GAP = " ";
const WORD = "todo4ai";

function renderHalfBlock(top: string, bot: string): string {
  const W = "\x1b[38;2;249;110;46m";
  const G = "\x1b[38;2;140;60;20m";
  const BW = "\x1b[48;2;249;110;46m";
  const BG = "\x1b[48;2;140;60;20m";
  const R = "\x1b[0m";

  if (top === " " && bot === " ") return " ";
  if (top === bot) return `${top === "x" ? W : G}\u2588${R}`;
  if (top === " ") return `${bot === "x" ? W : G}\u2584${R}`;
  if (bot === " ") return `${top === "x" ? W : G}\u2580${R}`;
  const fg = top === "x" ? W : G;
  const bg = bot === "x" ? BW : BG;
  return `${fg}${bg}\u2580${R}`;
}

export function renderLogo(): string[] {
  const rows: string[] = [];
  for (let r = 0; r < 6; r++) {
    let row = "";
    for (let i = 0; i < WORD.length; i++) {
      if (i > 0) row += GAP;
      row += LETTERS[WORD[i]][r];
    }
    rows.push(row);
  }

  const lines: string[] = [];
  for (let pair = 0; pair < 3; pair++) {
    let topRow = rows[pair * 2];
    let botRow = rows[pair * 2 + 1];
    const maxLen = Math.max(topRow.length, botRow.length);
    topRow = topRow.padEnd(maxLen);
    botRow = botRow.padEnd(maxLen);
    let line = "";
    for (let i = 0; i < maxLen; i++) {
      line += renderHalfBlock(topRow[i], botRow[i]);
    }
    lines.push(line);
  }
  return lines;
}
