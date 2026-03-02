#!/usr/bin/env bun
/**
 * TODOforAI TUI — full-screen terminal interface
 * Usage: todoai-tui "prompt text" | todoai-tui --resume <id> | todoai-tui -c
 */

import { realpathSync } from "fs";
import { resolve } from "path";
import { homedir } from "os";

import { ApiClient } from "todoforai-edge/src/api";
import { FrontendWebSocket } from "todoforai-edge/src/frontend-ws";
import { normalizeApiUrl } from "todoforai-edge/src/config";

import { DEFAULT_API_URL, getEnv, parseCliArgs } from "todoforai-cli/src/args";
import { ConfigStore } from "todoforai-cli/src/config";
import { getAgentWorkspacePaths, autoCreateAgent } from "todoforai-cli/src/agent";
import { getDisplayName, getItemId } from "todoforai-cli/src/select";
import { randomTip } from "todoforai-cli/src/tips";
import { renderLogo } from "./logo";

import { Screen } from "./screen";
import { OutputBuffer } from "./output";
import { StatusBar } from "./status-bar";
import { InputBar } from "./input-bar";
import { watchTodo } from "./watch";
import { BRAND, BRIGHT_WHITE, CYAN, DIM, GREEN, RED, RESET, YELLOW } from "./colors";

// ── helpers ──

function formatPathWithTilde(path: string): string {
  const home = homedir();
  return path.startsWith(home) ? path.replace(home, "~") : path;
}

function getFrontendUrl(apiUrl: string, projectId: string, todoId: string): string {
  if (apiUrl.includes("localhost:4000") || apiUrl.includes("127.0.0.1:4000")) {
    return `http://localhost:3000/${projectId}/${todoId}`;
  }
  return `https://todofor.ai/${projectId}/${todoId}`;
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
  --api-url <url>          API URL
  --api-key <key>          API key
  --resume, -r [todo-id]   Resume existing todo
  --continue, -c           Continue most recent todo
  --json                   Output as JSON
  --safe                   Validate API key upfront
  --debug, -d              Debug output
  --show-config            Show config
  --set-defaults           Interactive defaults setup
  --set-default-api-url    Set default API URL
  --set-default-api-key    Set default API key
  --reset-config           Reset config file
  --help, -h               Show this help

Key bindings:
  Enter         Submit input
  Alt+Enter     Newline in input
  PgUp/PgDn     Scroll output
  Ctrl+C        Interrupt / exit
  Ctrl+D        Exit
  Ctrl+L        Force redraw
`);
}

// ── TUI App ──

class TuiApp {
  private screen = new Screen();
  private output: OutputBuffer;
  private status: StatusBar;
  private input: InputBar;
  private ws: FrontendWebSocket | null = null;
  private api: ApiClient | null = null;
  private cfg: ConfigStore | null = null;
  private apiUrl = "";
  private todoId = "";
  private projectId = "";
  private agent: any = null;
  private running = true;

  constructor() {
    this.output = new OutputBuffer(this.screen);
    this.status = new StatusBar(this.screen);
    this.input = new InputBar(this.screen);
    this.input.onFullRedraw = () => this.redraw();
  }

  /** Full redraw of all regions */
  private redraw(): void {
    this.status.render();
    this.output.render(true);
    if (this.input.enabled) {
      this.input.render();
    } else {
      this.input.renderDisabled();
    }
  }

  /** Set up resize handler */
  private setupResize(): void {
    process.stdout.on("resize", () => {
      this.screen.measure();
      this.redraw();
    });
  }

  /** Set up global key handler for PgUp/PgDn/Ctrl+L when input is not active */
  private setupGlobalKeys(): void {
    // We handle PgUp/PgDn in a raw-mode listener that runs alongside input
    const origStdin = process.stdin;
    // Global key handling is done via a pre-filter in the input data handler
  }

  /** Read a single char for approval prompts */
  private singleChar(prompt: string): Promise<string> {
    return new Promise((resolve) => {
      const wasRaw = process.stdin.isRaw;
      if (process.stdin.isTTY) process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.once("data", (buf) => {
        if (process.stdin.isTTY) process.stdin.setRawMode(wasRaw ?? false);
        process.stdin.pause();
        const ch = buf.toString("utf-8").trim();
        const decoded = ch === "" || ch === "\r" || ch === "\n" ? "" : ch[0].toLowerCase();
        resolve(decoded);
      });
    });
  }

  /** Watch a todo, rendering to output buffer */
  private async watch(replayMessages?: Array<[string, any]>): Promise<boolean> {
    if (!this.ws) return false;
    this.status.watching = true;
    this.status.render();
    this.input.renderDisabled(`${DIM}  AI is working... (Ctrl+C to interrupt)${RESET}`);

    const result = await watchTodo(
      this.ws, this.todoId, this.projectId, this.output,
      {
        agentSettings: this.agent,
        replayMessages,
        singleCharFn: (prompt) => this.singleChar(prompt),
        onRender: () => {
          this.output.render();
          this.status.render();
        },
      },
    );

    this.status.watching = false;
    this.status.render();
    return result;
  }

  /** Interactive loop — read input, send messages, watch responses */
  private async interactiveLoop(): Promise<void> {
    while (this.running) {
      try {
        // Set up activity detection on WS
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

        this.input.renderDisabled();
        // Small delay to let the screen settle
        await new Promise(r => setTimeout(r, 50));
        this.redraw();

        const { promise: inputPromise, cancel: cancelInput } = this.input.read();

        // Set up PgUp/PgDn listener while input is active
        const pgHandler = (data: Buffer) => {
          const s = data.toString("utf-8");
          // PgUp: \x1b[5~  PgDn: \x1b[6~
          if (s === "\x1b[5~") { this.output.scrollUp(); this.output.render(); }
          else if (s === "\x1b[6~") { this.output.scrollDown(); this.output.render(); }
          // Ctrl+L: force redraw
          else if (s === "\x0c") { this.redraw(); }
        };
        process.stdin.on("data", pgHandler);

        const winner = await Promise.race([
          inputPromise.then(v => ({ tag: "input" as const, value: v })),
          activityPromise.then(() => ({ tag: "activity" as const, value: "" })),
        ]);

        process.stdin.removeListener("data", pgHandler);

        if (winner.tag === "activity") {
          cancelInput();
          inputPromise.catch(() => {});
          this.output.scrollToBottom();
          await this.watch(buffered);
          continue;
        }

        // User input
        this.ws!.setCallback(this.todoId);
        const text = winner.value;
        if (!text) continue;
        if (["/exit", "/quit", "/q", "q", "exit"].includes(text)) break;
        if (["/help", "?"].includes(text)) {
          this.output.appendLine(`${DIM}  /exit, /quit, /q  - quit${RESET}`);
          this.output.appendLine(`${DIM}  /help, ?          - show help${RESET}`);
          this.output.appendLine(`${DIM}  PgUp/PgDn         - scroll output${RESET}`);
          this.output.appendLine(`${DIM}  Alt+Enter          - newline in input${RESET}`);
          this.output.render();
          continue;
        }

        this.output.appendLine(`\n${DIM}${"─".repeat(40)}${RESET}`);
        this.output.appendLine(`${CYAN}You:${RESET} ${text}`);
        this.output.scrollToBottom();
        this.output.render();

        await this.api!.addMessage(this.projectId, text, this.agent, this.todoId);
        await this.watch();
      } catch {
        break;
      }
    }
  }

  /** Select project (auto/default/interactive via output area) */
  private async selectProject(projects: any[]): Promise<{ id: string; name: string }> {
    if (!projects?.length) throw new Error("No projects available");

    if (projects.length === 1) {
      const id = getItemId(projects[0]);
      const name = getDisplayName(projects[0]);
      this.output.appendLine(`${DIM}Auto-selected project: ${name}${RESET}`);
      return { id, name };
    }

    if (this.cfg!.data.default_project_id) {
      const match = projects.find(p => getItemId(p) === this.cfg!.data.default_project_id);
      if (match) {
        const name = getDisplayName(match);
        this.output.appendLine(`${DIM}Using default project: ${name}${RESET}`);
        return { id: this.cfg!.data.default_project_id, name };
      }
    }

    this.output.appendLine(`\n${BRIGHT_WHITE}Choose a project:${RESET}`);
    for (let i = 0; i < projects.length; i++) {
      this.output.appendLine(` ${BRAND}[${i + 1}]${RESET} ${getDisplayName(projects[i])}`);
    }
    this.output.render(true);

    const ch = await this.singleChar("project");
    const idx = parseInt(ch, 10) - 1;
    if (idx >= 0 && idx < projects.length) {
      const id = getItemId(projects[idx]);
      const name = getDisplayName(projects[idx]);
      this.cfg!.setDefaultProject(id, name);
      return { id, name };
    }
    // Default to first
    return { id: getItemId(projects[0]), name: getDisplayName(projects[0]) };
  }

  /** Select agent (auto/default/interactive) */
  private async selectAgent(agents: any[]): Promise<any> {
    if (!agents?.length) throw new Error("No agents available");

    if (agents.length === 1) {
      this.output.appendLine(`${DIM}Auto-selected agent: ${getDisplayName(agents[0])}${RESET}`);
      return agents[0];
    }

    const defaultName = this.cfg!.data.default_agent_name;
    if (defaultName) {
      const match = agents.find(a =>
        defaultName.toLowerCase().includes(getDisplayName(a).toLowerCase()) ||
        getDisplayName(a).toLowerCase().includes(defaultName.toLowerCase()),
      );
      if (match) {
        this.output.appendLine(`${DIM}Using default agent: ${getDisplayName(match)}${RESET}`);
        return match;
      }
    }

    this.output.appendLine(`\n${BRIGHT_WHITE}Choose an agent:${RESET}`);
    for (let i = 0; i < agents.length; i++) {
      this.output.appendLine(` ${BRAND}[${i + 1}]${RESET} ${getDisplayName(agents[i])}`);
    }
    this.output.render(true);

    const ch = await this.singleChar("agent");
    const idx = parseInt(ch, 10) - 1;
    if (idx >= 0 && idx < agents.length) {
      const agent = agents[idx];
      this.cfg!.setDefaultAgent(getDisplayName(agent), agent);
      return agent;
    }
    return agents[0];
  }

  async run(): Promise<void> {
    const { values: args, positionals } = parseCliArgs();

    if (args.help) { printUsage(); return; }

    this.cfg = new ConfigStore(args["config-path"] as string);

    // Config subcommands — don't need TUI
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

    // Resolve API
    this.apiUrl = normalizeApiUrl(
      (args["api-url"] as string) || this.cfg.data.default_api_url || getEnv("API_URL") || DEFAULT_API_URL,
    );
    const apiKey = (args["api-key"] as string) || this.cfg.data.default_api_key || getEnv("API_KEY") || "";
    if (!apiKey) {
      console.error("Error: No API key. Set via --api-key, TODOFORAI_API_KEY env, or --set-default-api-key");
      process.exit(1);
    }

    this.api = new ApiClient(this.apiUrl, apiKey);

    // Enter TUI
    this.screen.enter();
    this.setupResize();

    // Clean exit handler
    const cleanup = () => {
      this.screen.exit();
    };
    process.on("exit", cleanup);
    process.on("SIGTERM", () => { cleanup(); process.exit(0); });

    try {
      // Populate status bar from config defaults immediately
      if (this.cfg.data.default_agent_name) {
        this.status.agentName = this.cfg.data.default_agent_name;
      }

      // Show logo + tip in output
      for (const line of renderLogo()) {
        this.output.appendLine(`  ${line}`);
      }
      this.output.appendLine(`  ${DIM}Tip: ${randomTip()}${RESET}`);
      this.output.appendLine("");

      this.status.connected = false;
      this.redraw();

      // Connect WS
      this.ws = new FrontendWebSocket(this.apiUrl, apiKey);
      await this.ws.connect();
      this.status.connected = true;

      // ── Resume mode ──
      if (args.resume || args.continue) {
        const todoId = (args.resume as string) || this.cfg.data.last_todo_id;
        if (!todoId) { this.output.appendLine(`${RED}Error: No recent todo found${RESET}`); this.output.render(); await this.waitForExit(); return; }

        const todo = await this.api.getTodo(todoId);
        this.todoId = todoId;
        this.projectId = todo.projectId;
        this.agent = todo.agentSettings || { name: "default" };

        this.status.agentName = getDisplayName(this.agent);
        const resumePaths = getAgentWorkspacePaths(this.agent);
        if (resumePaths.length) {
          this.status.agentPath = resumePaths.length === 1 ? formatPathWithTilde(resumePaths[0]) : JSON.stringify(resumePaths.map(formatPathWithTilde));
        }

        // Display existing messages
        for (const msg of todo.messages || []) {
          const role = msg.role === "user" ? `${CYAN}You${RESET}` : `${GREEN}AI${RESET}`;
          this.output.appendLine(`${role}: ${(msg.content || "").slice(0, 200)}`);
        }
        this.output.appendLine(`${DIM}${"─".repeat(40)}${RESET}`);
        this.output.appendLine(`${DIM}Resumed todo: ${todoId}${RESET}`);
        this.redraw();

        await this.interactiveLoop();
        await this.ws.close();
        return;
      }

      // ── Pre-resolve agent (always try path, like CLI) ──
      let preMatchedAgent: any = null;
      let agents: any[] = [];

      if (args.agent) {
        // Try filtered endpoint, fall back to full list + client-side match
        let agentMatches: any[] | null = null;
        try {
          agentMatches = await this.api.listAgentSettings({ name: args.agent as string });
        } catch {
          agents = await this.api.listAgentSettings();
          const name = (args.agent as string).toLowerCase();
          const found = agents.find((a: any) => getDisplayName(a).toLowerCase().includes(name));
          if (found) agentMatches = [found];
        }
        if (agentMatches && agentMatches.length > 0) {
          preMatchedAgent = agentMatches[0];
        } else {
          if (!agents.length) agents = await this.api.listAgentSettings();
          this.output.appendLine(`${RED}Error: Agent '${args.agent}' not found${RESET}`);
          for (const a of agents) this.output.appendLine(`  - ${getDisplayName(a)}`);
          this.output.render();
          await this.waitForExit();
          return;
        }
        this.cfg.setDefaultAgent(getDisplayName(preMatchedAgent), preMatchedAgent);
      } else {
        // Always resolve from --path (defaults to "."/cwd), same as CLI
        const pathArg = (args.path as string) || ".";
        const resolved = realpathSync(resolve(pathArg));
        // Try filtered endpoint, fall back to full list + client-side match
        let matches: any[] | null = null;
        try {
          matches = await this.api.listAgentSettings({ workspacePath: resolved });
        } catch {
          const { findAgentByPath } = await import("todoforai-cli/src/agent");
          agents = await this.api.listAgentSettings();
          const found = findAgentByPath(agents, pathArg);
          if (found) matches = [found];
        }
        if (matches && matches.length > 0) {
          preMatchedAgent = matches[0];
          this.cfg.setDefaultAgent(getDisplayName(preMatchedAgent), preMatchedAgent);
        } else if (pathArg !== ".") {
          // Explicit non-cwd path with no match — auto-create
          this.output.appendLine(`${DIM}No agent for '${formatPathWithTilde(resolved)}', creating...${RESET}`);
          this.output.render();
          if (!agents.length) agents = await this.api.listAgentSettings();
          preMatchedAgent = await autoCreateAgent(this.api, resolved, agents);
          this.cfg.setDefaultAgent(getDisplayName(preMatchedAgent), preMatchedAgent);
        }
      }

      if (preMatchedAgent) {
        this.status.agentName = getDisplayName(preMatchedAgent);
        const paths = getAgentWorkspacePaths(preMatchedAgent);
        const pathStr = paths.length === 1 ? formatPathWithTilde(paths[0]) : JSON.stringify(paths.map(formatPathWithTilde));
        this.status.agentPath = pathStr;
      }

      this.redraw();

      // ── Read content ──
      let content: string;
      if (positionals.length > 0) {
        content = positionals.join(" ");
      } else if (!process.stdin.isTTY) {
        // Piped stdin
        const chunks: Buffer[] = [];
        for await (const chunk of process.stdin) chunks.push(chunk);
        content = Buffer.concat(chunks).toString("utf-8").trim();
        if (!content) {
          this.output.appendLine(`${RED}Error: Empty input${RESET}`);
          this.output.render();
          await this.waitForExit();
          return;
        }
      } else {
        // Interactive: read from input bar
        this.output.appendLine(`${DIM}Type your message below, or /exit to quit.${RESET}`);
        this.redraw();
        const { promise } = this.input.read();
        content = await promise;
        if (!content || ["/exit", "/quit", "/q"].includes(content)) {
          await this.ws.close();
          return;
        }
      }

      // ── Select project + agent ──
      const hasProject = args.project || this.cfg.data.default_project_id;
      const storedAgent = this.cfg.data.default_agent_settings;
      const hasAgent = preMatchedAgent || (storedAgent?.id && !args.agent);

      let projects: any[] | null = null;
      if (!hasProject || !hasAgent) {
        projects = await this.api.listProjects();
        if (!agents.length) agents = await this.api.listAgentSettings();
      }

      // Project
      if (args.project) {
        this.projectId = args.project as string;
      } else if (this.cfg.data.default_project_id && !projects) {
        this.projectId = this.cfg.data.default_project_id;
      } else {
        const sel = await this.selectProject(projects!);
        this.projectId = sel.id;
        this.cfg.setDefaultProject(sel.id, sel.name);
      }

      // Agent
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
          this.status.agentPath = paths.length === 1 ? formatPathWithTilde(paths[0]) : JSON.stringify(paths.map(formatPathWithTilde));
        }
      }
      this.redraw();

      // ── Create todo ──
      this.output.appendLine(`\n${CYAN}You:${RESET} ${content}`);
      this.output.appendLine(`${DIM}${"─".repeat(40)}${RESET}`);
      this.output.render();

      const todo = await this.api.addMessage(this.projectId, content, this.agent);
      this.todoId = todo.id || crypto.randomUUID();
      this.cfg.data.last_todo_id = this.todoId;
      this.cfg.save();

      const frontendUrl = getFrontendUrl(this.apiUrl, this.projectId, this.todoId);
      this.output.appendLine(`${DIM}TODO:${RESET} ${CYAN}${frontendUrl}${RESET}`);
      this.redraw();

      // ── Watch ──
      await this.watch();

      // ── Interactive follow-up ──
      this.output.appendLine(`${DIM}${"─".repeat(40)}${RESET}`);
      this.output.render();
      await this.interactiveLoop();

      await this.ws.close();
    } catch (e: any) {
      this.output.appendLine(`${RED}Error: ${e.message}${RESET}`);
      this.output.render();
      await this.waitForExit();
    }
  }

  cleanup(): void {
    if (this.screen.entered) this.screen.exit();
  }

  /** Wait for any key to exit (used for error states) */
  private waitForExit(): Promise<void> {
    this.output.appendLine(`${DIM}Press any key to exit...${RESET}`);
    this.output.render();
    return new Promise(resolve => {
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.once("data", () => {
        process.stdin.setRawMode(false);
        process.stdin.pause();
        resolve();
      });
    });
  }
}

// ── main ──

const app = new TuiApp();
app.run().catch(e => {
  // Ensure alt buffer is exited even on crash
  app.cleanup();
  process.stderr.write(`Error: ${e.message}\n`);
  process.exit(1);
}).finally(() => {
  app.cleanup();
});
