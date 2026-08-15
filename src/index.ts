#!/usr/bin/env bun
/**
 * TODOforAI TUI — full-screen terminal interface powered by OpenTUI
 * Usage: todoai-tui "prompt text" | todoai-tui --resume <id> | todoai-tui -c
 */

import { realpathSync } from "fs";
import { resolve } from "path";
import { homedir } from "os";

import { ApiClient, FrontendWebSocket } from "@shared/api";
import { normalizeApiUrl, readCredential } from "@shared/credentials";

import { DEFAULT_API_URL, getEnv, parseCliArgs } from "todoforai-cli/src/args";
import { ConfigStore, ScopedConfig } from "todoforai-cli/src/config";
import { getAgentWorkspacePaths, autoCreateAgent } from "todoforai-cli/src/agent";
import { getDisplayName, getItemId } from "todoforai-cli/src/select";
import { randomTip } from "todoforai-cli/src/tips";
import { getFrontendUrl } from "todoforai-cli/src/urls";
import { renderLogo } from "./logo";

import { createCliRenderer, BoxRenderable } from "@opentui/core";
import type { CliRenderer } from "@opentui/core";
import { OutputBuffer } from "./output";
import { StatusBar } from "./status-bar";
import { InputBar } from "./input-bar";
import { decodeSingleChar } from "./keys";
import { watchTodo } from "./watch";
import { CYAN, DIM, GREEN, RED, RESET } from "./colors";

// ── helpers ──

function formatPathWithTilde(path: string): string {
  const home = homedir();
  return path.startsWith(home) ? path.replace(home, "~") : path;
}

function printUsage(): void {
  console.log(`
todoai-tui — TODOforAI TUI (full-screen terminal interface)

Usage:
  todoai-tui "prompt text"              # Start with a prompt
  todoai-tui -c                         # Continue most recent todo
  todoai-tui --resume <todo-id>         # Resume specific todo

Options:
  --path <dir>             Workspace path (default: cwd)
  --project <id>           Project ID
  --agent, -a <name>       Agent name (partial match)
  --model, -m <model>      Override agent model
  --api-url <url>          API URL
  --api-key <key>          API key
  --resume, -r [todo-id]   Resume existing todo
  --continue, -c           Continue most recent todo
  --json                   Output as JSON
  --safe                   Validate API key upfront
  --debug, -d              Debug output
  --show-config            Show config
  --reset-config           Reset config file
  --help, -h               Show this help

Key bindings:
  Enter         Submit input
  Alt+Enter     Newline in input
  PgUp/PgDn     Scroll output
  Ctrl+C        Interrupt / exit
  Ctrl+D        Exit
`);
}

// ── Clipboard ──

async function readClipboard(): Promise<string> {
  if (process.platform === "darwin") {
    try {
      const proc = Bun.spawn(["pbpaste"], { stdout: "pipe", stderr: "pipe" });
      const text = await new Response(proc.stdout).text();
      await proc.exited;
      return text;
    } catch { return ""; }
  }
  if (process.env.WAYLAND_DISPLAY) {
    try {
      const proc = Bun.spawn(["wl-paste", "--no-newline"], { stdout: "pipe", stderr: "pipe" });
      const text = await new Response(proc.stdout).text();
      await proc.exited;
      return text;
    } catch { return ""; }
  }
  // X11: try xclip, fall back to xsel
  for (const cmd of [
    ["xclip", "-selection", "clipboard", "-o"],
    ["xsel", "--clipboard", "--output"],
  ]) {
    try {
      const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
      const text = await new Response(proc.stdout).text();
      const code = await proc.exited;
      if (code === 0) return text;
    } catch { continue; }
  }
  return "";
}

// ── TUI App ──

class TuiApp {
  private renderer: CliRenderer | null = null;
  private output: OutputBuffer | null = null;
  private status: StatusBar | null = null;
  private input: InputBar | null = null;
  private ws: FrontendWebSocket | null = null;
  private api: ApiClient | null = null;
  private cfg: ConfigStore | null = null;
  private cfgScope: ScopedConfig | null = null;
  private apiUrl = "";
  private todoId = "";
  private projectId = "";
  private agent: any = null;
  private running = true;

  private setupGlobalKeys(): void {
    // prependInputHandler runs before focused renderables — essential for scroll to work
    // even when InputRenderable has focus.
    this.renderer!.prependInputHandler((seq) => {
      if (seq === "\x1b[5~") { this.output!.scrollUp(); return true; }   // PgUp
      if (seq === "\x1b[6~") { this.output!.scrollDown(); return true; } // PgDn
      if (seq === "\x0c") { return true; }                               // Ctrl+L no-op
      if (seq === "\x04") { this.cleanup(); process.exit(0); }           // Ctrl+D
      if (seq === "\x03") {
        if (this.status?.watching) {
          // During watch: fire SIGINT so watch.ts handler sends interrupt
          process.kill(process.pid, "SIGINT");
        } else {
          // During input: cancel + exit
          this.input?.triggerCancel?.();
          setTimeout(() => { this.cleanup(); process.exit(0); }, 50);
        }
        return true;
      }
      // Ctrl+V: read system clipboard and insert into input field
      if (seq === "\x16") {
        readClipboard().then(text => { if (text) this.input?.insertText(text); });
        return true;
      }
      return false;
    });
  }

  /** Read a single char for approval prompts */
  private singleChar(_prompt: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const done = (fn: () => void) => {
        this.renderer!.removeInputHandler(handler);
        process.stdin.off("end", onEnd);
        process.stdin.off("error", onEnd);
        fn();
      };
      // Losing stdin must reject, not hang: the caller's catch denies the block,
      // whereas a pending promise would leave it neither approved nor denied.
      const onEnd = () => done(() => reject(new Error("stdin closed")));
      const handler = (seq: string) => {
        const ch = decodeSingleChar(seq);
        if (ch === null) return false; // not a decision — keep waiting
        done(() => resolve(ch));
        return true;
      };
      process.stdin.once("end", onEnd);
      process.stdin.once("error", onEnd);
      this.renderer!.prependInputHandler(handler);
    });
  }

  /** Watch a todo, rendering to output buffer */
  private async watch(replayMessages?: Array<[string, any]>): Promise<boolean> {
    if (!this.ws) return false;
    this.status!.watching = true;
    this.status!.render();
    this.input!.renderDisabled(`${DIM}  AI is working… (Ctrl+C to interrupt)${RESET}`);

    const result = await watchTodo(
      this.ws, this.todoId, this.projectId, this.output!,
      {
        agentSettings: this.agent,
        replayMessages,
        singleCharFn: (prompt) => this.singleChar(prompt),
        onRender: () => {
          this.output!.render();
          this.status!.render();
        },
      },
    );

    this.status!.watching = false;
    this.status!.render();
    return result;
  }

  /** Interactive loop — read input, send messages, watch responses */
  private async interactiveLoop(): Promise<void> {
    while (this.running) {
      try {
        let activityResolve: (() => void) | null = null;
        const activityPromise = new Promise<void>((res) => { activityResolve = res; });

        const ignoreActivity = new Set([
          "todo:msg_start", "todo:msg_done", "todo:msg_stop_sequence",
          "todo:msg_meta_ai", "todo:status", "todo:new_message_created",
          "block:end", "block:sh_msg_start", "block:sh_done",
        ]);
        const buffered: Array<[string, any]> = [];
        this.ws!.setCallback(this.todoId, (msgType: string, payload: any) => {
          buffered.push([msgType, payload]);
          if (!ignoreActivity.has(msgType)) activityResolve?.();
        });

        this.input!.renderDisabled();
        await new Promise(r => setTimeout(r, 50));
        this.status!.render();

        const { promise: inputPromise, cancel: cancelInput } = this.input!.read();

        const winner = await Promise.race([
          inputPromise.then(v => ({ tag: "input" as const, value: v })),
          activityPromise.then(() => ({ tag: "activity" as const, value: "" })),
        ]);

        if (winner.tag === "activity") {
          cancelInput();
          inputPromise.catch(() => {});
          this.output!.scrollToBottom();
          await this.watch(buffered);
          continue;
        }

        this.ws!.setCallback(this.todoId);
        const text = winner.value;
        if (!text) continue;
        if (["/exit", "/quit", "/q", "q", "exit"].includes(text)) break;
        if (["/help", "?"].includes(text)) {
          this.output!.appendLine(`${DIM}  /exit, /quit  - quit${RESET}`);
          this.output!.appendLine(`${DIM}  /help, ?      - show help${RESET}`);
          this.output!.appendLine(`${DIM}  PgUp/PgDn     - scroll output${RESET}`);
          continue;
        }

        this.output!.appendLine(`\n${DIM}${"─".repeat(40)}${RESET}`);
        this.output!.appendLine(`${CYAN}You:${RESET} ${text}`);
        this.output!.scrollToBottom();

        await this.api!.addMessage(this.projectId, text, this.agent, this.todoId);
        await this.watch();
      } catch {
        break;
      }
    }
  }

  /** Select project (auto/default/interactive) */
  private async selectProject(projects: any[]): Promise<{ id: string; name: string }> {
    if (!projects?.length) throw new Error("No projects available");

    if (projects.length === 1) {
      const id = getItemId(projects[0]);
      const name = getDisplayName(projects[0]);
      this.output!.appendLine(`${DIM}Auto-selected project: ${name}${RESET}`);
      return { id, name };
    }

    if (this.cfgScope!.data.default_project_id) {
      const match = projects.find(p => getItemId(p) === this.cfgScope!.data.default_project_id);
      if (match) {
        const name = getDisplayName(match);
        this.output!.appendLine(`${DIM}Using default project: ${name}${RESET}`);
        return { id: this.cfgScope!.data.default_project_id, name };
      }
    }

    this.output!.appendLine(`\nChoose a project:`);
    for (let i = 0; i < projects.length; i++) {
      this.output!.appendLine(` [${i + 1}] ${getDisplayName(projects[i])}`);
    }

    const ch = await this.singleChar("project");
    const idx = parseInt(ch, 10) - 1;
    if (idx >= 0 && idx < projects.length) {
      const id = getItemId(projects[idx]);
      const name = getDisplayName(projects[idx]);
      this.cfgScope!.setDefaultProject(id, name);
      return { id, name };
    }
    return { id: getItemId(projects[0]), name: getDisplayName(projects[0]) };
  }

  /** Select agent (auto/default/interactive) */
  private async selectAgent(agents: any[]): Promise<any> {
    if (!agents?.length) throw new Error("No agents available");

    if (agents.length === 1) {
      this.output!.appendLine(`${DIM}Auto-selected agent: ${getDisplayName(agents[0])}${RESET}`);
      return agents[0];
    }

    const defaultName = this.cfgScope!.data.default_agent_name;
    if (defaultName) {
      const match = agents.find(a =>
        defaultName.toLowerCase().includes(getDisplayName(a).toLowerCase()) ||
        getDisplayName(a).toLowerCase().includes(defaultName.toLowerCase()),
      );
      if (match) {
        this.output!.appendLine(`${DIM}Using default agent: ${getDisplayName(match)}${RESET}`);
        return match;
      }
    }

    this.output!.appendLine(`\nChoose an agent:`);
    for (let i = 0; i < agents.length; i++) {
      this.output!.appendLine(` [${i + 1}] ${getDisplayName(agents[i])}`);
    }

    const ch = await this.singleChar("agent");
    const idx = parseInt(ch, 10) - 1;
    if (idx >= 0 && idx < agents.length) {
      const agent = agents[idx];
      this.cfgScope!.setDefaultAgent(getDisplayName(agent), agent);
      return agent;
    }
    return agents[0];
  }

  async run(): Promise<void> {
    const { values: args, positionals } = parseCliArgs();

    if (args.help) { printUsage(); return; }

    this.cfg = new ConfigStore(args["config-path"] as string);

    if (args["show-config"]) {
      console.log(`Config file: ${formatPathWithTilde(this.cfg.path)}`);
      console.log(JSON.stringify(this.cfg.data, null, 2));
      return;
    }
    if (args["reset-config"]) {
      const { existsSync, unlinkSync } = await import("fs");
      if (existsSync(this.cfg.path)) { unlinkSync(this.cfg.path); console.log(`Configuration reset`); }
      else console.log("No configuration file to reset");
      return;
    }

    this.apiUrl = normalizeApiUrl(
      (args["api-url"] as string) || getEnv("API_URL") || DEFAULT_API_URL,
    );
    this.cfgScope = this.cfg.scope(this.apiUrl);
    // Same priority as the CLI: flag > shared credentials.json > env token.
    const apiKey = (args["api-key"] as string) || readCredential(this.apiUrl) || getEnv("API_TOKEN") || "";
    if (!apiKey) {
      console.error("Error: No API key. Set via --api-key, TODOFORAI_API_TOKEN env, or log in with `todoforai-cli`");
      process.exit(1);
    }

    this.api = new ApiClient(this.apiUrl, apiKey);

    // ── Boot OpenTUI ──
    this.renderer = await createCliRenderer({
      exitOnCtrlC: false,
      useAlternateScreen: true,
      useMouse: false,
    });

    const mainBox = new BoxRenderable(this.renderer, {
      id: "main",
      flexGrow: 1,
      maxHeight: "100%",
      maxWidth: "100%",
      flexDirection: "column",
    });
    this.renderer.root.add(mainBox);

    this.status = new StatusBar(this.renderer, mainBox);
    this.output = new OutputBuffer(this.renderer, mainBox);
    this.input = new InputBar(this.renderer, mainBox);

    this.setupGlobalKeys();
    this.renderer.start();

    process.on("exit", () => this.cleanup());
    process.on("SIGTERM", () => { this.cleanup(); process.exit(0); });

    try {
      if (this.cfgScope.data.default_agent_name) {
        this.status.agentName = this.cfgScope.data.default_agent_name;
      }

      for (const line of renderLogo()) {
        this.output.appendLine(`  ${line}`);
      }
      this.output.appendLine(`  ${DIM}Tip: ${randomTip()}${RESET}`);
      this.output.appendLine("");

      this.status.connected = false;
      this.status.render();

      this.ws = new FrontendWebSocket(this.apiUrl, apiKey);
      await this.ws.connect();
      this.status.connected = true;
      this.status.render();

      // ── Resume mode ──
      if (args.resume || args.continue) {
        const todoId = (args.resume as string) || this.cfgScope.data.last_todo_id;
        if (!todoId) {
          this.output.appendLine(`${RED}Error: No recent todo found${RESET}`);
          await this.waitForExit();
          return;
        }

        const todo = await this.api.getTodo(todoId);
        this.todoId = todoId;
        this.projectId = todo.projectId;
        this.agent = todo.agentSettings || { name: "default" };

        this.status.agentName = getDisplayName(this.agent);
        const resumePaths = getAgentWorkspacePaths(this.agent);
        if (resumePaths.length) {
          this.status.agentPath = resumePaths.length === 1
            ? formatPathWithTilde(resumePaths[0])
            : JSON.stringify(resumePaths.map(formatPathWithTilde));
        }

        for (const msg of todo.messages || []) {
          const role = msg.role === "user" ? `${CYAN}You${RESET}` : `${GREEN}AI${RESET}`;
          this.output.appendLine(`${role}: ${(msg.content || "").slice(0, 200)}`);
        }
        this.output.appendLine(`${DIM}${"─".repeat(40)}${RESET}`);
        this.output.appendLine(`${DIM}Resumed todo: ${todoId}${RESET}`);
        this.status.render();

        await this.interactiveLoop();
        await this.ws.close();
        return;
      }

      // ── Pre-resolve agent ──
      let preMatchedAgent: any = null;

      if (args.agent) {
        const matches = await this.api.listAgentSettings({ name: args.agent as string });
        if (matches.length > 0) {
          preMatchedAgent = matches[0];
        } else {
          this.output.appendLine(`${RED}Error: Agent '${args.agent}' not found${RESET}`);
          await this.waitForExit();
          return;
        }
        this.cfgScope.setDefaultAgent(getDisplayName(preMatchedAgent), preMatchedAgent);
      } else {
        const pathArg = (args.path as string) || ".";
        const resolved = realpathSync(resolve(pathArg));
        const matches = await this.api.listAgentSettings({ workspacePath: resolved });
        if (matches.length > 0) {
          preMatchedAgent = matches[0];
          this.cfgScope.setDefaultAgent(getDisplayName(preMatchedAgent), preMatchedAgent);
        } else if (pathArg !== ".") {
          this.output.appendLine(`${DIM}No agent for '${formatPathWithTilde(resolved)}', creating…${RESET}`);
          preMatchedAgent = await autoCreateAgent(this.api, resolved);
          this.cfgScope.setDefaultAgent(getDisplayName(preMatchedAgent), preMatchedAgent);
        }
      }

      if (preMatchedAgent) {
        this.status.agentName = getDisplayName(preMatchedAgent);
        const paths = getAgentWorkspacePaths(preMatchedAgent);
        this.status.agentPath = paths.length === 1
          ? formatPathWithTilde(paths[0])
          : JSON.stringify(paths.map(formatPathWithTilde));
      }
      this.status.render();

      // ── Read content ──
      let content: string;
      if (positionals.length > 0) {
        content = positionals.join(" ");
      } else if (!process.stdin.isTTY) {
        const chunks: Buffer[] = [];
        for await (const chunk of process.stdin) chunks.push(chunk);
        content = Buffer.concat(chunks).toString("utf-8").trim();
        if (!content) {
          this.output.appendLine(`${RED}Error: Empty input${RESET}`);
          await this.waitForExit();
          return;
        }
      } else {
        this.output.appendLine(`${DIM}Type your message below, or /exit to quit.${RESET}`);
        this.status.render();
        const { promise } = this.input.read();
        content = await promise;
        if (!content || ["/exit", "/quit", "/q"].includes(content)) {
          await this.ws.close();
          return;
        }
      }

      // ── Select project + agent ──
      const hasProject = args.project || this.cfgScope.data.default_project_id;
      const storedAgent = this.cfgScope.data.default_agent_settings;
      const hasAgent = preMatchedAgent || (storedAgent?.id && !args.agent);

      let projects: any[] | null = null;
      let agents: any[] = [];
      if (!hasProject || !hasAgent) {
        projects = await this.api.listProjects();
        if (!hasAgent) agents = await this.api.listAgentSettings();
      }

      if (args.project) {
        this.projectId = args.project as string;
      } else if (this.cfgScope.data.default_project_id && !projects) {
        this.projectId = this.cfgScope.data.default_project_id;
      } else {
        const sel = await this.selectProject(projects!);
        this.projectId = sel.id;
        this.cfgScope.setDefaultProject(sel.id, sel.name);
      }

      if (preMatchedAgent) {
        this.agent = preMatchedAgent;
      } else if (storedAgent?.id && !agents.length) {
        this.agent = storedAgent;
      } else {
        this.agent = await this.selectAgent(agents);
      }
      this.status.agentName = getDisplayName(this.agent);
      if (!this.status.agentPath) {
        const paths = getAgentWorkspacePaths(this.agent);
        if (paths.length) {
          this.status.agentPath = paths.length === 1
            ? formatPathWithTilde(paths[0])
            : JSON.stringify(paths.map(formatPathWithTilde));
        }
      }
      if (args.model) this.agent = { ...this.agent, model: args.model };
      this.status.agentModel = (args.model as string) || this.agent.model || "";
      this.status.render();

      // ── Create todo ──
      this.output.appendLine(`\n${CYAN}You:${RESET} ${content}`);
      this.output.appendLine(`${DIM}${"─".repeat(40)}${RESET}`);

      const todo = await this.api.addMessage(this.projectId, content, this.agent);
      this.todoId = todo.id || crypto.randomUUID();
      this.cfgScope.setLastTodoId(this.todoId);

      const frontendUrl = getFrontendUrl(this.apiUrl, this.todoId);
      this.output.appendLine(`${DIM}TODO:${RESET} ${CYAN}${frontendUrl}${RESET}`);
      this.status.render();

      await this.watch();

      this.output.appendLine(`${DIM}${"─".repeat(40)}${RESET}`);
      await this.interactiveLoop();

      await this.ws.close();
    } catch (e: any) {
      this.output?.appendLine(`${RED}Error: ${e.message}${RESET}`);
      await this.waitForExit();
    }
  }

  cleanup(): void {
    if (this.renderer && !this.renderer.isDestroyed) {
      this.renderer.destroy();
    }
    this.ws?.close().catch(() => {});
  }

  private waitForExit(): Promise<void> {
    this.output?.appendLine(`${DIM}Press any key to exit…${RESET}`);
    return new Promise(resolve => {
      const handler = (_seq: string) => {
        this.renderer!.removeInputHandler(handler);
        resolve();
        return true;
      };
      this.renderer!.prependInputHandler(handler);
    });
  }
}

// ── main ──

const app = new TuiApp();
app.run().catch(e => {
  app.cleanup();
  process.stderr.write(`Error: ${e.message}\n`);
  process.exit(1);
}).finally(() => {
  app.cleanup();
});
