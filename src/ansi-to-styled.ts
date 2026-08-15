/**
 * Convert ANSI SGR escape sequences to OpenTUI StyledText.
 */
import { StyledText, fg, bg, bold, dim, italic, underline, reverse } from "@opentui/core";

type Chunk = ReturnType<typeof fg>;

interface Attrs {
  fg?: string;
  bg?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  reverse?: boolean;
}

const FG: Record<number, string> = {
  30: "#45475a", 31: "#f38ba8", 32: "#a6e3a1", 33: "#f9e2af",
  34: "#89b4fa", 35: "#cba6f7", 36: "#89dceb", 37: "#cdd6f4",
  90: "#585b70", 91: "#f38ba8", 92: "#a6e3a1", 93: "#f9e2af",
  94: "#89b4fa", 95: "#cba6f7", 96: "#89dceb", 97: "#cdd6f4",
};

const BG: Record<number, string> = {
  40: "#45475a", 41: "#f38ba8", 42: "#a6e3a1", 43: "#f9e2af",
  44: "#89b4fa", 45: "#cba6f7", 46: "#89dceb", 47: "#cdd6f4",
};

function hex(r: number, g: number, b: number) {
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
}

function applyParams(cur: Attrs, params: string): Attrs {
  const codes = params ? params.split(";").map(Number) : [0];
  const r: Attrs = { ...cur };
  let i = 0;
  while (i < codes.length) {
    const c = codes[i];
    if (c === 0) { Object.keys(r).forEach(k => delete (r as any)[k]); }
    else if (c === 1) r.bold = true;
    else if (c === 2) r.dim = true;
    else if (c === 3) r.italic = true;
    else if (c === 4) r.underline = true;
    else if (c === 7) r.reverse = true;
    else if (c === 22) { delete r.bold; delete r.dim; }
    else if (FG[c]) r.fg = FG[c];
    else if (BG[c]) r.bg = BG[c];
    else if (c === 38 && codes[i + 1] === 2) {
      r.fg = hex(codes[i + 2] ?? 0, codes[i + 3] ?? 0, codes[i + 4] ?? 0);
      i += 4;
    } else if (c === 48 && codes[i + 1] === 2) {
      r.bg = hex(codes[i + 2] ?? 0, codes[i + 3] ?? 0, codes[i + 4] ?? 0);
      i += 4;
    }
    i++;
  }
  return r;
}

function chunk(text: string, a: Attrs): Chunk {
  let c: any = { __isChunk: true, text };
  if (a.fg) c = fg(a.fg)(c);
  if (a.bg) c = bg(a.bg)(c);
  if (a.bold) c = bold(c);
  if (a.dim) c = dim(c);
  if (a.italic) c = italic(c);
  if (a.underline) c = underline(c);
  if (a.reverse) c = reverse(c);
  return c;
}

export function ansiToStyled(input: string): StyledText {
  const chunks: Chunk[] = [];
  const re = /\x1b\[([0-9;]*)m/g;
  let last = 0;
  let attrs: Attrs = {};
  for (const m of input.matchAll(re)) {
    const text = input.slice(last, m.index);
    if (text) chunks.push(chunk(text, attrs));
    last = (m.index ?? 0) + m[0].length;
    attrs = applyParams(attrs, m[1]);
  }
  const rest = input.slice(last);
  if (rest) chunks.push(chunk(rest, attrs));
  if (!chunks.length) chunks.push({ __isChunk: true, text: "" } as any);
  return new StyledText(chunks as any);
}
