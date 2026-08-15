/**
 * Connection — API + WebSocket setup, extracted from CLI main.
 */

import { ApiClient, FrontendWebSocket } from "@shared/api";
import { normalizeApiUrl, readCredential } from "@shared/credentials";
import { ConfigStore } from "todoforai-cli/src/config";
import { DEFAULT_API_URL, getEnv } from "todoforai-cli/src/args";

export interface ConnectionOpts {
  apiUrl?: string;
  apiKey?: string;
  configPath?: string;
}

export interface Connection {
  api: ApiClient;
  ws: FrontendWebSocket;
  cfg: ConfigStore;
  apiUrl: string;
}

export async function createConnection(opts: ConnectionOpts): Promise<Connection> {
  const cfg = new ConfigStore(opts.configPath);

  const apiUrl = normalizeApiUrl(opts.apiUrl || getEnv("API_URL") || DEFAULT_API_URL);
  // Same priority as the CLI: flag > shared credentials.json > env token.
  const apiKey = opts.apiKey || readCredential(apiUrl) || getEnv("API_TOKEN") || "";

  if (!apiKey) {
    throw new Error("No API key. Set via --api-key, TODOFORAI_API_TOKEN env, or log in with `todoforai-cli`");
  }

  const api = new ApiClient(apiUrl, apiKey);
  const ws = new FrontendWebSocket(apiUrl, apiKey);
  await ws.connect();

  return { api, ws, cfg, apiUrl };
}
