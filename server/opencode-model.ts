import { createHash } from "node:crypto";

import type { HerdrPane, PaneModels, PaneModelSelection, SwitchPaneModelRequest } from "../shared/protocol.ts";
import { opencodeSessionId } from "./opencode.ts";
import { paneGet } from "./herdr/client.ts";
import { badRequest, conflictResponse, errorResponse, isJsonObject, jsonResponse } from "./http.ts";

const OUTPUT_LIMIT = 8 * 1024 * 1024;
const CLI_TIMEOUT = 15_000;
type ModelPane = Pick<HerdrPane, "agent_session" | "foreground_cwd" | "cwd">;
const identifier = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 512 && !/[\x00-\x1f\x7f]/.test(value);

export class OpencodeModelError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

/** Use OpenCode's authenticated discovery, never read its service password or write its database.
 * The CLI can exit zero for an HTTP error, so callers also validate each response's shape. */
export async function opencodeModelApi(binary: string, method: "get" | "post", path: string, cwd: string, signal: AbortSignal, body?: unknown): Promise<unknown> {
  signal.throwIfAborted();
  let child: ReturnType<typeof Bun.spawn>;
  try {
    child = Bun.spawn([binary, "api", method, path, ...(body === undefined ? [] : ["--data", JSON.stringify(body)])], {
      cwd, windowsHide: true, stdin: "ignore", stdout: "pipe", stderr: "ignore", timeout: CLI_TIMEOUT,
    });
  } catch { throw new OpencodeModelError("opencode_unavailable", "OpenCode 2's API CLI is unavailable on this PC. Use Terminal to change the model."); }
  const abort = () => child.kill();
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  try {
    const decoder = new TextDecoder();
    let output = "";
    let bytes = 0;
    for await (const chunk of child.stdout as ReadableStream<Uint8Array>) {
      bytes += chunk.length;
      if (bytes > OUTPUT_LIMIT) { child.kill(); throw new OpencodeModelError("opencode_unavailable", "OpenCode's model response is too large."); }
      output += decoder.decode(chunk, { stream: true });
    }
    output += decoder.decode();
    if (await child.exited !== 0 || signal.aborted) throw new OpencodeModelError("opencode_unavailable", "OpenCode did not answer. Check its connection in Terminal.");
    if (!output.trim() && method === "post") return null;
    try { return JSON.parse(output); }
    catch { throw new OpencodeModelError("opencode_unavailable", "OpenCode returned an unsupported API response. Use Terminal to change the model."); }
  } finally {
    signal.removeEventListener("abort", abort);
    if (child.exitCode === null) child.kill();
  }
}

function selection(value: unknown): PaneModelSelection | null {
  if (!isJsonObject(value) || !identifier(value.providerID) || !identifier(value.id)) return null;
  if (value.variant !== undefined && !identifier(value.variant)) return null;
  return { provider_id: value.providerID, model_id: value.id, variant: value.variant === undefined || value.variant === "default" ? null : value.variant as string };
}

/** Only display fields cross the bridge: model headers, settings and bodies may hold credentials. */
export function opencodeModelCatalog(value: unknown): PaneModels["models"] {
  if (!isJsonObject(value) || !Array.isArray(value.data)) throw new OpencodeModelError("opencode_unavailable", "OpenCode returned an unsupported model catalog.");
  const models: PaneModels["models"] = [];
  for (const item of value.data) {
    if (!isJsonObject(item) || item.enabled !== true || item.status === "deprecated") continue;
    if (!identifier(item.providerID) || !identifier(item.id) || !identifier(item.name) || !Array.isArray(item.variants)) {
      throw new OpencodeModelError("opencode_unavailable", "OpenCode returned an unsupported model catalog.");
    }
    const variants = item.variants.map((variant: unknown) => isJsonObject(variant) ? variant.id : null);
    if (!variants.every(identifier)) throw new OpencodeModelError("opencode_unavailable", "OpenCode returned unsupported model variants.");
    models.push({ provider_id: item.providerID, model_id: item.id, name: item.name, variants: [...new Set(variants.filter((id) => id !== "default"))] });
  }
  return models;
}

async function session(pane: ModelPane, binary: string, signal: AbortSignal) {
  const id = opencodeSessionId(pane);
  if (!id) throw new OpencodeModelError("model_unsupported", "Model controls require a session identified by OpenCode 2. Use Terminal for this pane.");
  const cwd = pane.foreground_cwd ?? pane.cwd;
  if (!cwd) throw new OpencodeModelError("model_unsupported", "This pane has no working directory.");
  const response = await opencodeModelApi(binary, "get", `/api/session/${id}`, cwd, signal);
  const data = isJsonObject(response) && isJsonObject(response.data) ? response.data : null;
  if (data?.id !== id || !isJsonObject(data.location) || !identifier(data.location.directory)) {
    throw new OpencodeModelError("opencode_unavailable", "The OpenCode API could not find this pane's session. Use Terminal to check its server connection.");
  }
  const model = data.model === undefined ? null : selection(data.model);
  if (data.model !== undefined && model === null) throw new OpencodeModelError("opencode_unavailable", "OpenCode returned an unsupported model selection.");
  const directory = data.location.directory;
  const revision = createHash("sha256").update(JSON.stringify({ id, directory, model })).digest("hex");
  return { id, directory, model, revision, cwd };
}

export async function readOpencodeModels(pane: ModelPane, binary: string, signal: AbortSignal): Promise<PaneModels> {
  const state = await session(pane, binary, signal);
  const query = new URLSearchParams({ "location[directory]": state.directory });
  const models = opencodeModelCatalog(await opencodeModelApi(binary, "get", `/api/model?${query}`, state.cwd, signal));
  let current = state.model;
  if (current === null) {
    const response = await opencodeModelApi(binary, "get", `/api/model/default?${query}`, state.cwd, signal);
    if (!isJsonObject(response) || !("data" in response)) throw new OpencodeModelError("opencode_unavailable", "OpenCode returned an unsupported default model.");
    current = response.data === null ? null : selection(response.data);
    if (response.data !== null && current === null) throw new OpencodeModelError("opencode_unavailable", "OpenCode returned an unsupported default model.");
  }
  return { session_id: state.id, revision: state.revision, current, models };
}

export function isSwitchPaneModelRequest(value: unknown): value is SwitchPaneModelRequest {
  return isJsonObject(value) && identifier(value.pane_id) && typeof value.session_id === "string" && /^ses_[A-Za-z0-9]{1,64}$/.test(value.session_id)
    && typeof value.revision === "string" && /^[a-f0-9]{64}$/.test(value.revision)
    && isJsonObject(value.model) && identifier(value.model.provider_id) && identifier(value.model.model_id)
    && (value.model.variant === null || identifier(value.model.variant));
}

export async function handleOpencodeModelRequest(request: Request, url: URL, options: { binary?: string; serialize: (pane: string, run: () => Promise<Response>) => Promise<Response> }): Promise<Response> {
  const changing = url.pathname === "/api/pane/model";
  if (request.method !== (changing ? "POST" : "GET")) return jsonResponse({ error: { code: "method_not_allowed", message: changing ? "Use POST" : "Use GET" } }, 405);
  if (changing && request.headers.get("x-herdr-machine") !== "1") return jsonResponse({ error: { code: "invalid_machine_request", message: "Use model controls from this app" } }, 403);
  let body: SwitchPaneModelRequest | undefined;
  if (changing) {
    let value: unknown;
    try { value = await request.json(); } catch { return badRequest("invalid_body", "Expected a model selection"); }
    if (!isSwitchPaneModelRequest(value)) return badRequest("invalid_body", "Expected a session, revision and model selection");
    body = value;
  }
  const paneId = body?.pane_id ?? url.searchParams.get("pane_id");
  if (!paneId) return badRequest("missing_pane_id", "pane_id is required");
  const run = async (): Promise<Response> => {
    try {
      const pane = await paneGet(paneId);
      if (body && opencodeSessionId(pane) !== body.session_id) return conflictResponse("model_changed", "The pane's session changed. Reopen the model selector.");
      const binary = options.binary ?? Bun.which("opencode") ?? "opencode";
      const state = await readOpencodeModels(pane, binary, request.signal);
      if (!body) return jsonResponse(state, 200, { "cache-control": "no-store" });
      if (state.revision !== body.revision) return conflictResponse("model_changed", "The session's model changed. Reopen the model selector.");
      const model = state.models.find((item) => item.provider_id === body.model.provider_id && item.model_id === body.model.model_id);
      if (!model || body.model.variant !== null && !model.variants.includes(body.model.variant)) return badRequest("invalid_model", "Choose an available model and reasoning variant");
      // Recheck Herdr after catalog reads: a pane may have switched sessions while the CLI answered.
      const latestPane = await paneGet(paneId);
      if (opencodeSessionId(latestPane) !== body.session_id) return conflictResponse("model_changed", "The pane's session changed. Reopen the model selector.");
      const latest = await session(latestPane, binary, request.signal);
      if (latest.revision !== body.revision) return conflictResponse("model_changed", "The session's model changed. Reopen the model selector.");
      const selection = { providerID: body.model.provider_id, id: body.model.model_id, variant: body.model.variant ?? "default" };
      const result = await opencodeModelApi(binary, "post", `/api/session/${state.session_id}/model`, latest.cwd, request.signal, { model: selection });
      if (result !== null) throw new OpencodeModelError("opencode_change_unconfirmed", "OpenCode did not confirm the model change. Check Terminal before trying again.");
      return jsonResponse({ ok: true }, 200, { "cache-control": "no-store" });
    } catch (error) {
      if (error instanceof OpencodeModelError) return jsonResponse({ error: { code: error.code, message: error.message } }, error.code === "model_unsupported" ? 400 : 502);
      return errorResponse(error);
    }
  };
  return changing ? options.serialize(paneId, run) : run();
}
