import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isSwitchPaneModelRequest, opencodeModelApi, opencodeModelCatalog, readOpencodeModels } from "./opencode-model.ts";
import { opencodeModelFixture } from "./opencode-model.fake.ts";

const roots: string[] = [];
const signal = () => new AbortController().signal;
const fixture = () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "herdr-model-controls-"))); roots.push(root);
  return { root, ...opencodeModelFixture(root), pane: { cwd: root, foreground_cwd: null, agent_session: { agent: "opencode", source: "herdr:opencode", kind: "id", value: "ses_fixture" } } };
};
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

// The fixture CLI is a shebang executable; catalog and request validation below run on every platform.
describe.skipIf(process.platform === "win32")("OpenCode model API", () => {
  it("reads the exact session and its actual project, stripping all request secrets", async () => {
    const f = fixture(); f.patch({ directory: join(f.root, "other project") });
    const state = await readOpencodeModels(f.pane, f.binary, signal());
    expect(state.current).toEqual({ provider_id: "fixture", model_id: "fast", variant: "low" });
    expect(state.models[0]).toEqual({ provider_id: "fixture", model_id: "fast", name: "Fast model", variants: ["low", "high"] });
    expect(JSON.stringify(state)).not.toContain("fictional-api-secret");
    expect(f.calls().map((call) => call.path)).toEqual(["/api/session/ses_fixture", `/api/model?${new URLSearchParams({ "location[directory]": join(f.root, "other project") })}`]);
    expect(f.calls().every((call) => call.cwd === f.root)).toBe(true);
  });

  it("uses the project default only when the session has no explicit selection", async () => {
    const f = fixture(); f.patch({ current: null });
    const before = await readOpencodeModels(f.pane, f.binary, signal());
    expect(before.current).toEqual({ provider_id: "fixture", model_id: "fast", variant: null });
    f.patch({ current: { providerID: "fixture", id: "fast", variant: "default" } });
    const after = await readOpencodeModels(f.pane, f.binary, signal());
    expect(after.current?.variant).toBeNull();
    expect(after.revision).not.toBe(before.revision);
  });

  it("rejects unknown pane sessions and wrong API identities without attempting a write", async () => {
    const f = fixture();
    await expect(readOpencodeModels({ ...f.pane, agent_session: null }, f.binary, signal())).rejects.toMatchObject({ code: "model_unsupported" });
    expect(f.calls()).toEqual([]);
    f.patch({ id: "ses_other" });
    await expect(readOpencodeModels(f.pane, f.binary, signal())).rejects.toMatchObject({ code: "opencode_unavailable" });
    expect(f.calls()).toHaveLength(1);
  });

  it("redacts HTTP errors even when OpenCode's CLI exits successfully", async () => {
    const f = fixture(); f.patch({ error: true });
    try { await readOpencodeModels(f.pane, f.binary, signal()); throw new Error("expected refusal"); }
    catch (error) { expect(error).toMatchObject({ code: "opencode_unavailable" }); expect(String(error)).not.toContain("fictional-api-secret"); }
  });

  it("bounds output and cancels the child rather than retrying a lost request", async () => {
    const f = fixture(); f.patch({ oversized: true });
    await expect(opencodeModelApi(f.binary, "get", "/api/model", f.root, signal())).rejects.toMatchObject({ code: "opencode_unavailable" });
    f.patch({ oversized: false, stall: true });
    await expect(opencodeModelApi(f.binary, "get", "/api/model", f.root, AbortSignal.timeout(200))).rejects.toMatchObject({ code: "opencode_unavailable" });
    expect(f.calls()).toHaveLength(2);
  });

  it("accepts an empty 204 mutation response but not missing executables", async () => {
    const f = fixture();
    expect(await opencodeModelApi(f.binary, "post", "/api/session/ses_fixture/model", f.root, signal(), { model: { providerID: "fixture", id: "deep", variant: "default" } })).toBeNull();
    expect(f.read().current.id).toBe("deep");
    await expect(opencodeModelApi(join(f.root, "missing"), "get", "/api/model", f.root, signal())).rejects.toMatchObject({ code: "opencode_unavailable" });
  });
});

it("offers only enabled, nondeprecated models and validates variants instead of inventing effort levels", () => {
  const model = { providerID: "provider", id: "model", name: "Model", enabled: true, variants: [{ id: "high" }, { id: "default" }, { id: "high" }] };
  expect(opencodeModelCatalog({ data: [model, { ...model, enabled: false }, { ...model, status: "deprecated" }] })).toEqual([{ provider_id: "provider", model_id: "model", name: "Model", variants: ["high"] }]);
  expect(() => opencodeModelCatalog({ data: [{ ...model, variants: [{ id: "high\nlow" }] }] })).toThrow();
});

it("validates a scoped precondition and model selection before invoking any CLI", () => {
  const valid = { pane_id: "w1:p1", session_id: "ses_fixture", revision: "a".repeat(64), model: { provider_id: "provider", model_id: "model", variant: null } };
  expect(isSwitchPaneModelRequest(valid)).toBe(true);
  for (const patch of [{ session_id: "../other" }, { revision: "" }, { model: { ...valid.model, variant: 1 } }, { model: { ...valid.model, model_id: "bad\nvalue" } }]) expect(isSwitchPaneModelRequest({ ...valid, ...patch })).toBe(false);
});
