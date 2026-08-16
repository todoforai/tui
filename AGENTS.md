# tui — full-screen terminal UI (OpenTUI)

Renders through `@opentui/core`; deps come from sibling checkouts (`../cli`, `../packages/shared-*`).

## Testing

```bash
bun test           # unit — approval prompt fail-closed invariant (approval.test.ts)
bunx tsc --noEmit  # types (crosses into ../cli/src, so cli breakage surfaces here)
```

### Interactive, from an agent shell
Agent shells are real PTYs (edge spawns via `Bun.Terminal`), so the TUI runs — but raw
output is ANSI soup. Wrap it in tmux, which renders the screen for you:

```bash
tmux new-session -d -s tuitest -x 100 -y 30 'bun src/index.ts'
tmux send-keys -t tuitest 'run: echo hi' Enter
sleep 3; tmux capture-pane -t tuitest -p     # readable screen text
tmux send-keys -t tuitest C-c                # or Escape, C-d, y, n…
tmux kill-session -t tuitest
```

### Approval prompt keys (the security-critical bit)
At `[Y]es / [n]o / [a]ll / [r]emember?`: only `y`/`a`/`r`/Enter approve.
Ctrl+C, Ctrl+D, ESC, anything else → deny; stdin EOF → deny (never hang, never approve).
Guarded by `approval.test.ts` + `keys.ts:decodeSingleChar`. Note: Ctrl+C denying (instead
of exiting) relies on `prependInputHandler` ordering — the prompt handler is prepended
after the global one, so it wins. Re-verify with real keys after any OpenTUI upgrade:
boot the renderer + `handleApprovalPrompt` with a fake ws that logs approve/deny, run it
in tmux, send keys, grep the log (see git history of this file / /tmp/approval-harness.ts
pattern).

Reaching the prompt via a live agent needs a command the agent's permissions do NOT
whitelist — plain `echo` etc. auto-approve and the prompt never fires.
