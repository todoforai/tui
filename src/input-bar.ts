/**
 * InputBar — multi-line input using OpenTUI TextareaRenderable.
 * Enter = submit, Alt+Enter = newline, max 5 lines.
 */
import {
  BoxRenderable, TextRenderable, TextareaRenderable,
  StyledText, fg, bold, dim,
} from "@opentui/core";
import type { CliRenderer } from "@opentui/core";

const BRAND = "#f96e2e";
const str = (s: string): any => ({ __isChunk: true, text: s });

export class InputBar {
  private box: BoxRenderable;
  private sepText: TextRenderable;
  private inputField: TextareaRenderable;
  private statusText: TextRenderable;

  enabled = false;
  /** Called when the user cancels (Ctrl+C during input) */
  triggerCancel: (() => void) | null = null;

  constructor(renderer: CliRenderer, container: BoxRenderable) {
    this.box = new BoxRenderable(renderer, {
      id: "input-bar",
      width: "100%",
      flexDirection: "column",
      flexShrink: 0,
      backgroundColor: "#1e1e2e",
    });

    // Separator line
    const sepBox = new BoxRenderable(renderer, {
      id: "input-sep",
      height: 1,
      width: "100%",
      backgroundColor: "#313244",
    });
    this.sepText = new TextRenderable(renderer, { id: "sep-text", content: "" });
    sepBox.add(this.sepText);
    this.box.add(sepBox);

    // Input row
    const inputRow = new BoxRenderable(renderer, {
      id: "input-row",
      flexDirection: "row",
      width: "100%",
      paddingLeft: 1,
      paddingRight: 1,
    });

    const prompt = new TextRenderable(renderer, {
      id: "input-prompt",
      content: new StyledText([bold(fg(BRAND)("TODO›")), str(" ")]),
      flexShrink: 0,
    });

    this.inputField = new TextareaRenderable(renderer, {
      id: "input-field",
      flexGrow: 1,
      minHeight: 1,
      maxHeight: 5,
      wrapMode: "word",
      placeholder: "type a message…",
      keyBindings: [
        { name: "return", action: "submit" },
        { name: "return", meta: true, action: "newline" },
      ],
    });

    inputRow.add(prompt);
    inputRow.add(this.inputField);
    this.box.add(inputRow);

    // Status line (shown when disabled)
    const statusRow = new BoxRenderable(renderer, {
      id: "status-row",
      height: 1,
      width: "100%",
      paddingLeft: 1,
    });
    this.statusText = new TextRenderable(renderer, { id: "status-text-input", content: "" });
    statusRow.add(this.statusText);
    this.box.add(statusRow);

    container.add(this.box);
  }

  read(): { promise: Promise<string>; cancel: () => void } {
    this.enabled = true;
    this.inputField.setText("");
    this.inputField.focus();
    this.statusText.content = "";

    let resolveFn!: (v: string) => void;
    let rejectFn!: (e: Error) => void;

    const promise = new Promise<string>((res, rej) => {
      resolveFn = res;
      rejectFn = rej;
    });

    const onSubmit = () => {
      this.triggerCancel = null;
      this.enabled = false;
      this.inputField.onSubmit = undefined;
      const text = this.inputField.plainText;
      this.inputField.setText("");
      this.inputField.blur();
      resolveFn(text.trim());
    };

    this.inputField.onSubmit = onSubmit;

    const cancel = () => {
      this.triggerCancel = null;
      this.enabled = false;
      this.inputField.onSubmit = undefined;
      this.inputField.setText("");
      this.inputField.blur();
      rejectFn(new Error("cancelled"));
    };

    this.triggerCancel = cancel;
    return { promise, cancel };
  }

  /** Insert text at the current cursor position (used for Ctrl+V paste) */
  insertText(text: string): void {
    if (!this.enabled) return;
    this.inputField.insertText(text);
  }

  render(): void {} // OpenTUI renders automatically

  renderDisabled(message?: string): void {
    this.enabled = false;
    this.inputField.blur();
    const msg = message ?? "";
    // Strip ANSI for simple display in status row
    const plain = msg.replace(/\x1b\[[0-9;]*m/g, "");
    this.statusText.content = new StyledText([plain ? dim(plain) : dim("waiting…")] as any);
  }
}
