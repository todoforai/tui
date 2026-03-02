/**
 * StatusBar — 1-line top bar showing agent, path, connection status.
 * Mirrors CLI output: Agent: name │ Path: ~/path
 */

import { Screen } from "./screen";
import { BRAND, RESET, DIM, GREEN, RED, BG_STATUS, WHITE, CYAN } from "./colors";

export class StatusBar {
  private screen: Screen;
  agentName = "";
  agentPath = "";
  connected = false;
  watching = false;

  constructor(screen: Screen) {
    this.screen = screen;
  }

  render(): void {
    const cols = this.screen.cols;
    const connDot = this.connected ? `${GREEN}●${RESET}${BG_STATUS}` : `${RED}●${RESET}${BG_STATUS}`;
    const watchLabel = this.watching ? `${DIM}watching${RESET}${BG_STATUS}` : "";

    let bar = `${BG_STATUS}${WHITE}`;
    bar += ` ${BRAND}todofor.ai${RESET}${BG_STATUS}${WHITE}`;
    if (this.agentName) bar += ` ${DIM}│${RESET}${BG_STATUS} ${BRAND}${this.agentName}${RESET}${BG_STATUS}`;
    if (this.agentPath) bar += ` ${DIM}│${RESET}${BG_STATUS} ${CYAN}${this.agentPath}${RESET}${BG_STATUS}`;
    if (watchLabel) bar += ` ${DIM}│${RESET}${BG_STATUS} ${watchLabel}`;
    bar += ` ${connDot}`;

    // Pad to fill width
    const visLen = bar.replace(/\x1b\[[0-9;]*m/g, "").length;
    if (visLen < cols) bar += " ".repeat(cols - visLen);

    bar += RESET;
    this.screen.writeLine(this.screen.statusRow, bar);
  }
}
