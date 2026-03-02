/**
 * InputBar — multiline input in fixed bottom region.
 * Renders prompt + buffer in the input region of the screen.
 * Raw mode key handling with bracketed paste support.
 */

import { Screen } from "./screen";
import { BRIGHT_WHITE, RESET, DIM } from "./colors";

const SEP_CHAR = "─";

export class InputBar {
  private screen: Screen;
  private buf = "";
  private cursor = 0;
  private pasting = false;
  private done = false;
  private resolveFn: ((value: string) => void) | null = null;
  private rejectFn: ((err: Error) => void) | null = null;
  private dataHandler: ((data: Buffer) => void) | null = null;
  prompt = `${BRIGHT_WHITE}TODO>${RESET} `;
  private promptLen = 6; // visible length of "TODO> " (5 chars + space)
  enabled = false;

  constructor(screen: Screen) {
    this.screen = screen;
  }

  /** Start accepting input. Returns promise that resolves with the input text. */
  read(): { promise: Promise<string>; cancel: () => void } {
    this.buf = "";
    this.cursor = 0;
    this.pasting = false;
    this.done = false;
    this.enabled = true;

    let cancelFn: () => void = () => {};

    const promise = new Promise<string>((resolve, reject) => {
      this.resolveFn = resolve;
      this.rejectFn = reject;
      cancelFn = () => this.finish(true);

      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdout.write("\x1b[?2004h"); // enable bracketed paste

      this.dataHandler = (data: Buffer) => this.onData(data);
      process.stdin.on("data", this.dataHandler);
      this.render();
    });

    return { promise, cancel: cancelFn };
  }

  private finish(cancelled: boolean): void {
    if (this.done) return;
    this.done = true;
    this.enabled = false;
    process.stdout.write("\x1b[?2004l"); // disable bracketed paste
    process.stdin.setRawMode(false);
    process.stdin.pause();
    if (this.dataHandler) {
      process.stdin.removeListener("data", this.dataHandler);
      this.dataHandler = null;
    }
    if (cancelled) this.rejectFn?.(new Error("cancelled"));
    else this.resolveFn?.(this.buf.trim());
  }

  private onData(data: Buffer): void {
    let s = data.toString("utf-8");
    while (s.length > 0 && !this.done) {
      if (this.pasting) {
        const end = s.indexOf("\x1b[201~");
        if (end >= 0) {
          const text = s.slice(0, end).replace(/\r\n?|\n/g, "\n");
          this.insert(text);
          this.pasting = false;
          s = s.slice(end + 6);
        } else {
          this.insert(s.replace(/\r\n?|\n/g, "\n"));
          s = "";
        }
        this.render();
      } else {
        const ps = s.indexOf("\x1b[200~");
        const chunk = ps >= 0 ? s.slice(0, ps) : s;

        for (let i = 0; i < chunk.length && !this.done; i++) {
          const c = chunk.charCodeAt(i);
          if (c === 0x03) { this.finish(true); return; }                // Ctrl+C
          if (c === 0x04) { this.finish(true); return; }                // Ctrl+D
          if (c === 0x0d || c === 0x0a) { this.finish(false); return; } // Enter
          if (c === 0x17) { this.deleteWordBack(); }                     // Ctrl+W
          else if (c === 0x0b) { this.killToEnd(); }                     // Ctrl+K
          else if (c === 0x7f || c === 0x08) { this.backspace(); }       // Backspace
          else if (c === 0x1b) {                                         // ESC
            if (i + 1 < chunk.length && chunk.charCodeAt(i + 1) === 0x0d) {
              this.insert("\n");
              i++;
            } else {
              i = this.handleCSI(chunk, i) - 1;
            }
          }
          else if (c === 0x01) { this.cursor = 0; }                     // Ctrl+A
          else if (c === 0x05) { this.cursor = this.buf.length; }       // Ctrl+E
          else if (c >= 0x20) { this.insert(chunk[i]); }
        }

        if (ps >= 0) { this.pasting = true; s = s.slice(ps + 6); }
        else s = "";
        this.render();
      }
    }
  }

  private insert(text: string): void {
    this.buf = this.buf.slice(0, this.cursor) + text + this.buf.slice(this.cursor);
    this.cursor += text.length;
  }

  private backspace(): void {
    if (this.cursor > 0) {
      this.buf = this.buf.slice(0, this.cursor - 1) + this.buf.slice(this.cursor);
      this.cursor--;
    }
  }

  private deleteWordBack(): void {
    let p = this.cursor;
    while (p > 0 && this.buf[p - 1] === " ") p--;
    while (p > 0 && this.buf[p - 1] !== " ") p--;
    this.buf = this.buf.slice(0, p) + this.buf.slice(this.cursor);
    this.cursor = p;
  }

  private killToEnd(): void {
    this.buf = this.buf.slice(0, this.cursor);
  }

  private wordLeft(): number {
    let p = this.cursor;
    while (p > 0 && this.buf[p - 1] === " ") p--;
    while (p > 0 && this.buf[p - 1] !== " ") p--;
    return p;
  }

  private wordRight(): number {
    let p = this.cursor;
    while (p < this.buf.length && this.buf[p] === " ") p++;
    while (p < this.buf.length && this.buf[p] !== " ") p++;
    return p;
  }

  private handleCSI(chunk: string, start: number): number {
    let i = start + 1;
    if (i >= chunk.length || chunk[i] !== "[") {
      if (i < chunk.length) i++;
      return i;
    }
    i++;
    let params = "";
    while (i < chunk.length && /[0-9;]/.test(chunk[i])) { params += chunk[i]; i++; }
    const final = i < chunk.length ? chunk[i] : "";
    i++;

    const parts = params.split(";");
    const modifier = parts.length > 1 ? parseInt(parts[1]) : 0;
    const code = parts[0] || "";
    const ctrl = modifier === 5;

    switch (final) {
      case "D": // Left
        if (ctrl) this.cursor = this.wordLeft();
        else if (this.cursor > 0) this.cursor--;
        break;
      case "C": // Right
        if (ctrl) this.cursor = this.wordRight();
        else if (this.cursor < this.buf.length) this.cursor++;
        break;
      case "H": this.cursor = 0; break;
      case "F": this.cursor = this.buf.length; break;
      case "A": break; // Up — ignore in input
      case "B": break; // Down — ignore in input
      case "~":
        if (code === "3" && this.cursor < this.buf.length) {
          this.buf = this.buf.slice(0, this.cursor) + this.buf.slice(this.cursor + 1);
        }
        if (code === "5") { /* PgUp — handled by caller */ }
        if (code === "6") { /* PgDn — handled by caller */ }
        break;
    }
    return i;
  }

  /** Render separator lines above and below input */
  private renderSeparators(): void {
    const sep = `${DIM}${SEP_CHAR.repeat(this.screen.cols)}${RESET}`;
    this.screen.writeLine(this.screen.inputSepTop, sep);
    this.screen.writeLine(this.screen.inputSepBottom, sep);
  }

  /** Called when input needs a full redraw (e.g. height changed) */
  onFullRedraw: (() => void) | null = null;

  /** Render the input bar in the bottom region */
  render(): void {
    const inputLines = this.buf.split("\n");
    const needed = Math.max(1, inputLines.length);
    const prevHeight = this.screen.inputHeight;
    this.screen.setInputHeight(needed);

    // If input height changed, need full redraw (output area shrank/grew)
    if (needed !== prevHeight && this.onFullRedraw) {
      this.onFullRedraw();
      return; // full redraw already rendered us
    }

    this.renderSeparators();

    const lines: string[] = [];
    for (let i = 0; i < inputLines.length; i++) {
      const prefix = i === 0 ? this.prompt : " ".repeat(this.promptLen);
      lines.push(prefix + inputLines[i]);
    }

    this.screen.writeRegion(this.screen.inputTop, this.screen.inputTop + needed - 1, lines);

    // Position cursor: promptLen offset on first line, same on continuations
    const cursorLines = this.buf.slice(0, this.cursor).split("\n");
    const cursorRow = cursorLines.length - 1;
    const textCol = cursorLines[cursorLines.length - 1].length;
    const cursorCol = this.promptLen + textCol + 1; // +1 for 1-based terminal col
    this.screen.showCursorAt(this.screen.inputTop + cursorRow, cursorCol);
  }

  /** Render disabled state (e.g. while watching) */
  renderDisabled(message?: string): void {
    this.renderSeparators();
    const text = message || `${DIM}  waiting...${RESET}`;
    this.screen.writeRegion(this.screen.inputTop, this.screen.inputTop, [text]);
    this.screen.hideCursor();
  }
}
