/**
 * StatusBar — single-row top bar showing connection/agent/model info.
 */
import { BoxRenderable, TextRenderable, StyledText, fg, bold, dim } from "@opentui/core";
import type { CliRenderer } from "@opentui/core";

const BRAND = "#f96e2e";
const str = (s: string): any => ({ __isChunk: true, text: s });

export class StatusBar {
  private text: TextRenderable;

  connected = false;
  watching = false;
  agentName = "";
  agentPath = "";
  agentModel = "";

  constructor(renderer: CliRenderer, container: BoxRenderable) {
    const box = new BoxRenderable(renderer, {
      id: "status-bar",
      height: 1,
      width: "100%",
      flexShrink: 0,
      backgroundColor: "#1e1e2e",
      paddingLeft: 1,
      paddingRight: 1,
    });
    this.text = new TextRenderable(renderer, { id: "status-text", content: "" });
    box.add(this.text);
    container.add(box);
  }

  render(): void {
    const chunks: any[] = [bold(fg(BRAND)("todoai")), str(" ")];
    chunks.push(this.connected ? fg("#a6e3a1")("●") : fg("#f38ba8")("○"));
    if (this.agentName) chunks.push(dim(" │ "), fg("#cdd6f4")(this.agentName));
    if (this.agentPath) chunks.push(dim(" " + this.agentPath));
    if (this.agentModel) chunks.push(dim(" [" + this.agentModel + "]"));
    if (this.watching) chunks.push(dim(" │ "), fg("#f9e2af")("working…"));
    this.text.content = new StyledText(chunks);
  }
}
