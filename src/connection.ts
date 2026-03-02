/**
 * Connection — API + WebSocket setup, extracted from CLI main.
 */

import { ApiClient } from "todoforai-edge/src/api";
import { FrontendWebSocket } from "todoforai-edge/src/frontend-ws";
import { normalizeApiUrl } from "todoforai-edge/src/config";
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

  const apiUrl = normalizeApiUrl(
    opts.apiUrl || cfg.data.default_api_url || getEnv("API_URL") || DEFAULT_API_URL,
  );
  const apiKey = opts.apiKey || cfg.data.default_api_key || getEnv("API_KEY") || "";

  if (!apiKey) {
    throw new Error("No API key. Set via --api-key, TODOFORAI_API_KEY env, or --set-default-api-key");
  }

  const api = new ApiClient(apiUrl, apiKey);
  const ws = new FrontendWebSocket(apiUrl, apiKey);
  await ws.connect();

  return { api, ws, cfg, apiUrl };
}
