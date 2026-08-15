/**
 * Approval — block approval rendering + key capture for TUI.
 * Renders approval prompts in the output area and captures responses via input bar.
 */

import { FrontendWebSocket } from "@shared/api";
import { getBlockNewPatterns } from "@shared/fbe/permissionUtils";
import { renderDiff } from "todoforai-cli/src/diff-view";
import { OutputBuffer } from "./output";
import { YELLOW, GREEN, RED, DIM, CYAN, RESET } from "./colors";

type DiffEntry = { originalContent: string; modifiedContent: string };

// ── block classification (ported from CLI watch.ts) ──

function classifyBlock(info: any): string {
  const inner = (info.block_type || "").toLowerCase();
  if (["create", "createfile"].includes(inner)) return "create";
  if (["modify", "modifyfile", "update", "edit"].includes(inner)) return "edit";
  if (["catfile", "read", "readfile"].includes(inner)) return "read";
  if (inner === "mcp") return "mcp";
  if (["shell", "bash"].includes(inner) || info.cmd) return "shell";
  return "unknown";
}

function blockDisplay(info: any): [string, string] {
  const labels: Record<string, string> = { create: "File", edit: "Edit", read: "Read File", mcp: "MCP", shell: "Shell" };
  const kind = classifyBlock(info);
  const typeLabel = labels[kind] || info.block_type || "Tool";
  const skipKeys = new Set([
    "userId", "messageId", "todoId", "blockId", "block_type", "edge_id", "timeout", "updates",
    "changes", "originalContent", "modifiedContent", "approvalContext", "generalized_pattern",
    "status", "toolCallId", "result",
  ]);
  const knownKeys = new Set(["path", "filePath", "content", "cmd", "name"]);

  let display = info.path || info.filePath || info.content || info.cmd || info.name || "";
  const rest = Object.entries(info).filter(([k, v]) => !skipKeys.has(k) && !knownKeys.has(k) && v);
  if (rest.length) {
    const extra = rest.map(([k, v]) => `${k}=${v}`).join(" ");
    display = display ? `${display} (${extra})` : extra;
  }
  if (!display) display = "<pending>";
  if (display.length > 200) display = display.slice(0, 200) + "...";
  return [typeLabel, display];
}

export function sendApproval(ws: FrontendWebSocket, blockId: string, messageId: string, todoId: string, decision = "allow_once", patterns?: string[]): void {
  const payload: any = { todoId, messageId, blockId, decision };
  if (patterns?.length) payload.patterns = patterns;
  (ws as any).ws?.send(JSON.stringify({ type: "BLOCK_APPROVAL_INTENT", payload }));
}

export interface ApprovalContext {
  ws: FrontendWebSocket;
  todoId: string;
  output: OutputBuffer;
  blocksStore: Map<string, Record<string, any>>;
  diffStore: Map<string, DiffEntry>;
  diffRendered: Set<string>;
  approveAll: boolean;
  onApproveAllChanged: (val: boolean) => void;
  agentSettings?: any;
}

export async function handleApprovalPrompt(
  ctx: ApprovalContext,
  blocks: any[],
  singleCharFn: (prompt: string) => Promise<string>,
): Promise<void> {
  if (ctx.approveAll) {
    for (const bi of blocks) {
      const [tl, disp] = blockDisplay(bi);
      ctx.output.appendLine(`${YELLOW}⚠ Auto-approving [${tl}]${RESET} ${disp}`);
      sendApproval(ctx.ws, bi.blockId, bi.messageId, ctx.todoId);
    }
    return;
  }

  // Brief pause for diffs to arrive
  const hasFileBlocks = blocks.some(bi => ["create", "edit"].includes(classifyBlock(bi)));
  if (hasFileBlocks) await new Promise(r => setTimeout(r, 1500));

  ctx.output.appendLine(`\n${YELLOW}⚠ ${blocks.length} action(s) awaiting approval:${RESET}`);
  for (const bi of blocks) {
    const [tl, disp] = blockDisplay(bi);
    ctx.output.appendLine(`  ${YELLOW}[${tl}]${RESET} ${disp}`);
    const actx = bi.approvalContext || {};
    if (actx.toolInstalls?.length) {
      ctx.output.appendLine(`  ${CYAN}↳ Install tools: ${actx.toolInstalls.join(", ")}${RESET}`);
    }
    // Show diff if available
    const diff = ctx.diffStore.get(bi.blockId);
    if (diff && !ctx.diffRendered.has(bi.blockId)) {
      ctx.diffRendered.add(bi.blockId);
      const filePath = bi.path || bi.filePath || "file";
      const diffText = renderDiff(diff.originalContent, diff.modifiedContent, filePath);
      if (diffText) {
        for (const line of diffText.split("\n")) ctx.output.appendLine(line);
      }
    }
  }

  const newPatterns = blocks.flatMap(bi => getBlockNewPatterns({
    type: bi.block_type || "unknown",
    generalized_pattern: bi.generalized_pattern,
    cmd: bi.cmd,
  }, ctx.agentSettings?.permissions));
  const stripPrefix = (p: string) => p.replace(/^todoai_(edge|cloud):/, "");
  const patternHint = newPatterns.length ? ` ${DIM}${newPatterns.map(stripPrefix).join(", ")}${RESET}` : "";

  ctx.output.appendLine(`  [Y]es / [n]o / [a]ll / [r]emember${patternHint}?`);
  ctx.output.render(true);

  try {
    const response = await singleCharFn("approval");
    if (response === "a") ctx.onApproveAllChanged(true);

    if (["a", "y", "", "r"].includes(response)) {
      const decision = response === "r" ? "allow_remember" : "allow_once";
      for (const bi of blocks) {
        let patterns: string[] | undefined;
        if (response === "r") {
          patterns = getBlockNewPatterns({
            type: bi.block_type || "unknown",
            generalized_pattern: bi.generalized_pattern,
            cmd: bi.cmd,
          }, ctx.agentSettings?.permissions);
          if (patterns.length) {
            ctx.output.appendLine(`  ${GREEN}✓ Remembering: ${patterns.map(stripPrefix).join(", ")}${RESET}`);
          }
        }
        sendApproval(ctx.ws, bi.blockId, bi.messageId, ctx.todoId, decision, patterns);
      }
    } else {
      for (const bi of blocks) {
        ctx.ws.sendBlockDeny(ctx.todoId, bi.messageId, bi.blockId);
      }
      ctx.output.appendLine(`  ${RED}✗ Denied${RESET}`);
    }
  } catch {
    // Interrupted or read failed — deny. Approving here would let a Ctrl+C
    // (or any stdin error) silently grant whatever the agent asked for.
    for (const bi of blocks) {
      ctx.ws.sendBlockDeny(ctx.todoId, bi.messageId, bi.blockId);
    }
    ctx.output.appendLine(`  ${RED}✗ Denied (interrupted)${RESET}`);
  }
  ctx.output.render(true);
}

export { classifyBlock, blockDisplay };
export type { DiffEntry };
