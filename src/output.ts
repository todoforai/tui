/**
 * OutputBuffer — wraps ScrollBoxRenderable for scrollable streaming output.
 * stickyScroll: true keeps the view pinned to the bottom automatically;
 * user can scroll up to review history, scroll down to re-pin.
 */
import { BoxRenderable, TextRenderable } from "@opentui/core";
import { ScrollBoxRenderable } from "@opentui/core";
import type { CliRenderer } from "@opentui/core";
import { ansiToStyled } from "./ansi-to-styled";

const MAX_LINES = 5000;

export class OutputBuffer {
  readonly scrollBox: ScrollBoxRenderable;
  private lines: TextRenderable[] = [];
  private partial = "";
  private partialNode: TextRenderable | null = null;
  private renderer: CliRenderer;

  constructor(renderer: CliRenderer, container: BoxRenderable) {
    this.renderer = renderer;
    this.scrollBox = new ScrollBoxRenderable(renderer, {
      id: "output-scroll",
      stickyScroll: true,
      stickyStart: "bottom",
      scrollY: true,
      scrollX: false,
      flexGrow: 1,
      scrollbarOptions: {
        trackOptions: { foregroundColor: "#585b70", backgroundColor: "#1e1e2e" },
      },
      contentOptions: { paddingLeft: 1 },
    });
    container.add(this.scrollBox);
  }

  private addRenderable(node: TextRenderable) {
    this.scrollBox.add(node);
    this.lines.push(node);
    if (this.lines.length > MAX_LINES) {
      const old = this.lines.shift()!;
      this.scrollBox.remove(old.id);
      old.destroy();
    }
  }

  private newLineNode(text: string): TextRenderable {
    return new TextRenderable(this.renderer, {
      id: `line-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      content: ansiToStyled(text),
      width: "100%",
    });
  }

  /** Append streaming text (may have embedded newlines) */
  append(text: string): void {
    if (!text) return;
    const combined = this.partial + text;
    const parts = combined.split("\n");
    this.partial = parts.pop()!;

    for (const line of parts) {
      if (this.partialNode) {
        // Finalize the partial node with the completed line
        this.partialNode.content = ansiToStyled(line);
        this.partialNode = null;
      } else {
        this.addRenderable(this.newLineNode(line));
      }
    }

    // Update/create partial node for remaining text
    if (this.partial) {
      if (!this.partialNode) {
        this.partialNode = this.newLineNode(this.partial);
        this.addRenderable(this.partialNode);
      } else {
        this.partialNode.content = ansiToStyled(this.partial);
      }
    }
  }

  /** Flush any partial line */
  flushPartial(): void {
    if (this.partial || this.partialNode) {
      this.partialNode = null;
      this.partial = "";
    }
  }

  /** Append a complete line */
  appendLine(line: string): void {
    this.flushPartial();
    this.addRenderable(this.newLineNode(line));
  }

  scrollUp(): void {
    // Disable sticky so it doesn't snap back after manual scroll
    this.scrollBox.stickyScroll = false;
    this.scrollBox.scrollBy(-1, "viewport");
  }

  scrollDown(): void {
    this.scrollBox.scrollBy(1, "viewport");
    const viewportHeight = (this.scrollBox as any).viewport?.height ?? 0;
    const atBottom = this.scrollBox.scrollTop >= this.scrollBox.scrollHeight - viewportHeight - 2;
    if (atBottom) this.scrollBox.stickyScroll = true;
  }

  scrollToBottom(): void {
    // Re-enable sticky — next content addition will pin to bottom
    this.scrollBox.stickyScroll = true;
    const viewportHeight = (this.scrollBox as any).viewport?.height as number | undefined;
    const max = Math.max(0, this.scrollBox.scrollHeight - (viewportHeight ?? 0));
    if (max > 0) this.scrollBox.scrollTop = max;
  }

  /** No-op — OpenTUI renders automatically */
  render(_force = false): void {}
}
