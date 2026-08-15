/**
 * The approval prompt must fail closed: anything that is not an explicit
 * yes/all/remember/Enter has to deny, including interrupts and a lost stdin.
 */
import { test, expect } from "bun:test";
import { handleApprovalPrompt } from "./approval";
import { decodeSingleChar } from "./keys";

function makeCtx() {
  const approved: string[] = [];
  const denied: string[] = [];
  const ws: any = {
    // sendApproval reaches through to the raw socket, deny uses the wrapper.
    ws: { send: (raw: string) => approved.push(JSON.parse(raw).payload.blockId) },
    sendBlockDeny: (_t: string, _m: string, b: string) => denied.push(b),
  };
  const ctx: any = {
    ws,
    todoId: "todo-1",
    output: { appendLine: () => {}, render: () => {} },
    blocksStore: new Map([["block-1", { cmd: "rm -rf /" }]]),
    diffStore: new Map(),
    diffRendered: new Set(),
    approveAll: false,
    onApproveAllChanged: (v: boolean) => { ctx.approveAll = v; },
    agentSettings: {},
  };
  return { ctx, approved, denied };
}

const blocks = [{ blockId: "block-1", messageId: "msg-1", block_type: "cmd", cmd: "rm -rf /" }];

async function decide(reply: () => Promise<string>) {
  const { ctx, approved, denied } = makeCtx();
  await handleApprovalPrompt(ctx, blocks, reply);
  return { approved, denied };
}

test.each([
  ["Ctrl+C", "\x03"],
  ["Ctrl+D", "\x04"],
  ["ESC", "\x1b"],
  ["n", "n"],
  ["garbage", "q"],
])("%s denies", async (_name, seq) => {
  const { approved, denied } = await decide(async () => seq);
  expect(approved).toEqual([]);
  expect(denied).toEqual(["block-1"]);
});

test("a lost stdin denies instead of approving", async () => {
  const { approved, denied } = await decide(async () => { throw new Error("stdin closed"); });
  expect(approved).toEqual([]);
  expect(denied).toEqual(["block-1"]);
});

test.each([
  ["Enter (the [Y] default)", ""],
  ["y", "y"],
  ["a", "a"],
  ["r", "r"],
])("%s approves", async (_name, seq) => {
  const { approved, denied } = await decide(async () => seq);
  expect(approved).toEqual(["block-1"]);
  expect(denied).toEqual([]);
});

// The keypress → answer half of the same guarantee.
test("only Enter decodes to the approving empty string", () => {
  expect(decodeSingleChar("\r")).toBe("");
  expect(decodeSingleChar("\n")).toBe("");
  for (const seq of ["\x03", "\x04", "\x1b", "n", "q"]) {
    expect(decodeSingleChar(seq)).not.toBe("");
  }
});

test("multi-char escapes are not an answer", () => {
  for (const seq of ["\x1b[A", "\x1b[6~"]) expect(decodeSingleChar(seq)).toBeNull();
});
