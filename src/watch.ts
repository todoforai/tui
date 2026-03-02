/**
 * Watch — port of CLI watch.ts targeting OutputBuffer instead of stdout.
 * Same protocol handling, different rendering target.
 */

import { FrontendWebSocket } from "todoforai-edge/src/frontend-ws";
import { renderDiff } from "todoforai-cli/src/diff-view";
import { OutputBuffer } from "./output";
import { YELLOW, GREEN, RED, DIM, CYAN, RESET } from "./colors";
import { classifyBlock, blockDisplay, sendApproval, handleApprovalPrompt, type DiffEntry, type ApprovalContext } from "./approval";

const diffStoreByWs = new WeakMap<FrontendWebSocket, Map<string, DiffEntry>>();

export interface WatchOpts {
  json?: boolean;
  autoApprove?: boolean;
  agentSettings?: any;
  replayMessages?: Array<[string, any]>;
  /** Function to read a single char for approval prompts */
  singleCharFn: (prompt: string) => Promise<string>;
  /** Called when output needs re-rendering */
  onRender: () => void;
}

export async function watchTodo(
  ws: FrontendWebSocket,
  todoId: string,
  projectId: string,
  output: OutputBuffer,
  opts: WatchOpts,
): Promise<boolean> {
  const ignore = new Set([
    "todo:msg_start", "todo:msg_done", "todo:msg_stop_sequence",
    "todo:msg_meta_ai", "todo:status", "todo:new_message_created",
    "block:end", "block:sh_msg_start", "block:sh_done",
  ]);
  const blockStartEvents = new Set([
    "block:start_shell", "block:start_createfile",
    "block:start_modifyfile", "block:start_mcp", "block:start_catfile",
  ]);

  // Resolve edge_id + root_path from agent settings
  let edgeId: string | undefined;
  let rootPath = "";
  if (opts.agentSettings) {
    const emc = opts.agentSettings.edgesMcpConfigs || {};
    edgeId = Object.keys(emc)[0];
    if (edgeId) {
      const ec = emc[edgeId];
      const tc = ec?.todoai_edge || ec?.todoai || {};
      rootPath = (tc.workspacePaths || [])[0] || "";
    }
  }

  const blocksStore = new Map<string, Record<string, any>>();
  const diffStore = diffStoreByWs.get(ws) ?? new Map<string, DiffEntry>();
  diffStoreByWs.set(ws, diffStore);
  const diffRendered = new Set<string>();

  let approveAll = !!opts.autoApprove;
  let interruptCount = 0;

  // Ctrl+C handler
  const origHandler = process.listeners("SIGINT").slice();
  process.removeAllListeners("SIGINT");
  process.on("SIGINT", () => {
    interruptCount++;
    if (interruptCount >= 2) {
      process.exit(130);
    }
    output.appendLine(`\n${YELLOW}Interrupting... (Ctrl+C again to force exit)${RESET}`);
    opts.onRender();
    ws.sendInterrupt(projectId, todoId);
  });

  // Approval queue
  const pendingBlocks: any[] = [];
  let approvalPromptActive = false;

  const approvalCtx: ApprovalContext = {
    ws, todoId, output, blocksStore, diffStore, diffRendered, approveAll,
    onApproveAllChanged: (val) => { approveAll = val; approvalCtx.approveAll = val; },
    agentSettings: opts.agentSettings,
  };

  async function processApprovals() {
    if (approvalPromptActive || pendingBlocks.length === 0) return;
    approvalPromptActive = true;

    const blocks = pendingBlocks.splice(0).map(bi => {
      const latest = bi?.blockId ? (blocksStore.get(bi.blockId) || {}) : {};
      return { ...latest, ...bi };
    });

    await handleApprovalPrompt(approvalCtx, blocks, opts.singleCharFn);

    approvalPromptActive = false;
    if (pendingBlocks.length > 0) void processApprovals();
  }

  const callback = (msgType: string, payload: any) => {
    if (msgType === "block:message") {
      output.append(payload.content || "");
      opts.onRender();
    } else if (msgType === "BLOCK_UPDATE") {
      const updates = payload.updates || {};
      const status = updates.status;
      const result = updates.result;

      if (payload.blockId && Object.keys(updates).length) {
        const stored = blocksStore.get(payload.blockId) || {};
        blocksStore.set(payload.blockId, { ...stored, ...updates });
      }
      if (payload.blockId && (updates.originalContent !== undefined || updates.modifiedContent !== undefined)) {
        diffStore.set(payload.blockId, {
          originalContent: updates.originalContent ?? "",
          modifiedContent: updates.modifiedContent ?? "",
        });
      }
      // Render diff when it arrives
      if ((updates.originalContent !== undefined || updates.modifiedContent !== undefined) && !diffRendered.has(payload.blockId)) {
        diffRendered.add(payload.blockId);
        const bi = blocksStore.get(payload.blockId) || {};
        const filePath = bi.path || bi.filePath || updates.path || "file";
        const diffText = renderDiff(updates.originalContent || "", updates.modifiedContent || "", filePath);
        if (diffText) {
          for (const line of diffText.split("\n")) output.appendLine(line);
        }
        opts.onRender();
      }

      if (result) {
        output.appendLine(`\n${DIM}--- Block Result ---${RESET}`);
        output.appendLine(`${DIM}${result}${RESET}`);
        opts.onRender();
      } else if (status === "AWAITING_APPROVAL") {
        const stored = blocksStore.get(payload.blockId) || {};
        pendingBlocks.push({ ...stored, ...payload, ...updates });
        void processApprovals();
      } else if (status && status !== "COMPLETED" && status !== "RUNNING") {
        output.appendLine(`\n[block:update] status=${status}`);
        opts.onRender();
      }
    } else if (msgType === "block:start_universal") {
      const skip = new Set(["userId", "messageId", "todoId", "blockId", "block_type", "edge_id", "timeout"]);
      const blockType = payload.block_type || "UNIVERSAL";
      const isEdit = classifyBlock(payload) === "edit";
      const parts = Object.entries(payload)
        .filter(([k]) => !skip.has(k) && !(isEdit && k === "changes"))
        .map(([k, v]) => `${k}=${v}`);
      const extra = parts.length ? ` ${parts.join(" ")}` : "";
      output.appendLine(`\n${YELLOW}*${RESET} ${YELLOW}${blockType}${RESET}${extra}`);
      if (payload.blockId) blocksStore.set(payload.blockId, payload);
      opts.onRender();
    } else if (msgType === "block:sh_msg_result") {
      const content = payload.content || "";
      if (content) {
        const lines = content.trim().split("\n");
        const preview = lines.slice(0, 4).map((l: string) => `  ${DIM}│${RESET} ${l}`);
        for (const p of preview) output.appendLine(p);
        if (lines.length > 4) output.appendLine(`  ${DIM}│ +${lines.length - 4} lines${RESET}`);
        opts.onRender();
      }
    } else if (blockStartEvents.has(msgType)) {
      if (payload.blockId) blocksStore.set(payload.blockId, payload);
    } else if (!ignore.has(msgType)) {
      output.appendLine(`\n[${msgType}]`);
      opts.onRender();
    }
  };

  // Replay buffered messages
  if (opts.replayMessages) {
    for (const [msgType, payload] of opts.replayMessages) {
      callback(msgType, payload);
    }
  }

  try {
    const result = await ws.waitForCompletion(todoId, callback);
    output.appendLine("");
    if (!result?.success) {
      const t = result?.type || "unknown";
      output.appendLine(`Warning: Stopped: ${t}`);
    }
    opts.onRender();
    return true;
  } catch {
    output.appendLine(`${YELLOW}Interrupted${RESET}`);
    opts.onRender();
    return false;
  } finally {
    process.removeAllListeners("SIGINT");
    for (const fn of origHandler) process.on("SIGINT", fn as any);
  }
}
