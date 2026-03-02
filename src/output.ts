/**
 * OutputBuffer — scrollable line buffer for the output region.
 * Supports PgUp/PgDn scrolling, ring buffer for memory.
 */

import { Screen } from "./screen";
import { RESET, DIM } from "./colors";

const MAX_LINES = 10000;

/** Strip ANSI to get visible length */
function visibleLen(s: string): number {
  return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}

/** Wrap a line to fit within cols, preserving ANSI codes */
function wrapLine(line: string, cols: number): string[] {
  if (cols <= 0) return [line];
  const result: string[] = [];
  let current = "";
  let visible = 0;
  let i = 0;

  while (i < line.length) {
    if (line[i] === "\x1b") {
      const end = line.indexOf("m", i);
      if (end !== -1) {
        current += line.slice(i, end + 1);
        i = end + 1;
        continue;
      }
    }
    if (visible >= cols) {
      result.push(current);
      current = "";
      visible = 0;
    }
    current += line[i];
    visible++;
    i++;
  }
  if (current || result.length === 0) result.push(current);
  return result;
}

export class OutputBuffer {
  private lines: string[] = [];
  private _scrollOffset = 0; // 0 = bottom (auto-scroll), >0 = scrolled up
  private screen: Screen;
  private dirty = false;
  /** Accumulated partial line (no trailing newline yet) */
  private partial = "";

  constructor(screen: Screen) {
    this.screen = screen;
  }

  get lineCount(): number { return this.lines.length; }
  get scrollOffset(): number { return this._scrollOffset; }
  get isAtBottom(): boolean { return this._scrollOffset === 0; }

  /** Append text (may contain newlines, partial lines buffered) */
  append(text: string): void {
    if (!text) return;
    const combined = this.partial + text;
    const parts = combined.split("\n");
    // Last element is the new partial (empty string if text ended with \n)
    this.partial = parts.pop()!;

    for (const line of parts) {
      this.lines.push(line);
      if (this.lines.length > MAX_LINES) {
        this.lines.shift();
        if (this._scrollOffset > 0) this._scrollOffset--;
      }
    }
    this.dirty = true;
  }

  /** Flush partial line as a complete line */
  flushPartial(): void {
    if (this.partial) {
      this.lines.push(this.partial);
      this.partial = "";
      if (this.lines.length > MAX_LINES) this.lines.shift();
      this.dirty = true;
    }
  }

  /** Append a complete line */
  appendLine(line: string): void {
    this.flushPartial();
    this.lines.push(line);
    if (this.lines.length > MAX_LINES) {
      this.lines.shift();
      if (this._scrollOffset > 0) this._scrollOffset--;
    }
    this.dirty = true;
  }

  scrollUp(n?: number): void {
    const pageSize = n ?? this.screen.outputHeight;
    this._scrollOffset += pageSize;
    const maxScroll = Math.max(0, this.getWrappedLines().length - this.screen.outputHeight);
    if (this._scrollOffset > maxScroll) this._scrollOffset = maxScroll;
    this.dirty = true;
  }

  scrollDown(n?: number): void {
    const pageSize = n ?? this.screen.outputHeight;
    this._scrollOffset -= pageSize;
    if (this._scrollOffset < 0) this._scrollOffset = 0;
    this.dirty = true;
  }

  scrollToBottom(): void {
    this._scrollOffset = 0;
    this.dirty = true;
  }

  /** Get all lines wrapped to screen width */
  private getWrappedLines(): string[] {
    const cols = this.screen.cols;
    const wrapped: string[] = [];
    for (const line of this.lines) {
      wrapped.push(...wrapLine(line, cols));
    }
    // Include partial line if any
    if (this.partial) {
      wrapped.push(...wrapLine(this.partial, cols));
    }
    return wrapped;
  }

  /** Render the output region */
  render(force = false): void {
    if (!this.dirty && !force) return;
    this.dirty = false;

    const height = this.screen.outputHeight;
    const wrapped = this.getWrappedLines();
    const total = wrapped.length;

    // Calculate visible window
    const endIdx = total - this._scrollOffset;
    const startIdx = Math.max(0, endIdx - height);

    const visible = wrapped.slice(startIdx, endIdx);

    // Pad to fill region
    const displayLines: string[] = [];
    for (let i = 0; i < height; i++) {
      displayLines.push(i < visible.length ? visible[i] : "");
    }

    this.screen.writeRegion(this.screen.outputTop, this.screen.outputBottom, displayLines);

    // Show scroll indicator if not at bottom
    if (this._scrollOffset > 0) {
      const indicator = `${DIM} ↑ ${this._scrollOffset} lines above ↑${RESET}`;
      this.screen.writeLine(this.screen.outputTop, indicator);
    }
  }
}
