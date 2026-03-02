/**
 * Screen — alternate buffer, 3 fixed regions, resize handling.
 *
 * Layout:
 *   Row 1              : status bar  (1 line)
 *   Row 2..rows-inputH : output area (scrollable)
 *   Last inputH rows   : input bar   (1-3 lines)
 */

import { RESET } from "./colors";

const CSI = "\x1b[";
const ALT_ON = `${CSI}?1049h`;
const ALT_OFF = `${CSI}?1049l`;
const HIDE_CURSOR = `${CSI}?25l`;
const SHOW_CURSOR = `${CSI}?25h`;
const CLEAR_LINE = `${CSI}2K`;

export class Screen {
  rows = 0;
  cols = 0;
  inputHeight = 1;
  entered = false;

  constructor() {
    this.measure();
  }

  measure(): void {
    this.rows = process.stdout.rows || 24;
    this.cols = process.stdout.columns || 80;
  }

  get statusRow(): number { return 1; }
  get outputTop(): number { return 2; }
  /** Row of the separator line above input */
  get inputSepTop(): number { return this.rows - this.inputHeight - 1; }
  get outputBottom(): number { return this.inputSepTop - 1; }
  get outputHeight(): number { return this.outputBottom - this.outputTop + 1; }
  /** First row of actual input text */
  get inputTop(): number { return this.rows - this.inputHeight; }
  /** Bottom separator row */
  get inputSepBottom(): number { return this.rows; }

  enter(): void {
    if (this.entered) return;
    this.entered = true;
    process.stdout.write(ALT_ON + HIDE_CURSOR);
    this.clear();
  }

  exit(): void {
    if (!this.entered) return;
    this.entered = false;
    process.stdout.write(SHOW_CURSOR + ALT_OFF);
  }

  clear(): void {
    process.stdout.write(`${CSI}2J`);
  }

  /** Move cursor to row,col (1-based) */
  moveTo(row: number, col: number): void {
    process.stdout.write(`${CSI}${row};${col}H`);
  }

  /** Clear a single row and optionally write text */
  writeLine(row: number, text: string): void {
    this.moveTo(row, 1);
    process.stdout.write(CLEAR_LINE + text + RESET);
  }

  /** Write into a region (clears each row first). Lines beyond region are clipped. */
  writeRegion(startRow: number, endRow: number, lines: string[]): void {
    for (let i = 0; i <= endRow - startRow; i++) {
      this.moveTo(startRow + i, 1);
      process.stdout.write(CLEAR_LINE);
      if (i < lines.length) {
        process.stdout.write(lines[i] + RESET);
      }
    }
  }

  /** Show cursor at a specific position */
  showCursorAt(row: number, col: number): void {
    this.moveTo(row, col);
    process.stdout.write(SHOW_CURSOR);
  }

  hideCursor(): void {
    process.stdout.write(HIDE_CURSOR);
  }

  setInputHeight(h: number): void {
    this.inputHeight = Math.max(1, Math.min(h, Math.floor(this.rows / 3)));
  }
}
