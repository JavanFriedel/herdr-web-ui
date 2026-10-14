import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function opencodeModelFixture(root: string, id = "ses_fixture") {
  const state = join(root, "model-state.json");
  const calls = join(root, "api-calls.jsonl");
  const binary = join(root, "opencode-api");
  const model = (id: string, variants: string[]) => ({ providerID: "fixture", id, name: id === "fast" ? "Fast model" : "Deep model", enabled: true, status: "active", variants: variants.map((id) => ({ id, settings: { secret: "fictional-api-secret" } })), headers: { authorization: "fictional-api-secret" } });
  writeFileSync(state, JSON.stringify({ id, directory: root, current: { providerID: "fixture", id: "fast", variant: "low" }, models: [model("fast", ["low", "high"]), model("deep", ["medium", "high"])] }));
  writeFileSync(calls, "");
  writeFileSync(binary, `#!${process.execPath}
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
const file = ${JSON.stringify(state)};
const state = JSON.parse(readFileSync(file, "utf8"));
const [api, method, path, flag, body] = process.argv.slice(2);
appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ api, method, path, cwd: process.cwd(), ...(body ? { body: JSON.parse(body) } : {}) }) + "\\n");
if (state.stall) { Bun.serve({ port: 0, fetch: () => new Response("") }); await new Promise(() => {}); }
if (state.error || state.postError && method === "post") { console.log(JSON.stringify({ error: { message: "fictional-api-secret" } })); process.exit(0); }
if (state.oversized) { await Bun.write(Bun.stdout, "x".repeat(9 * 1024 * 1024)); process.exit(0); }
if (api !== "api") process.exit(1);
if (method === "get" && path === "/api/session/" + state.id) {
  state.reads = (state.reads ?? 0) + 1;
  if (state.changeAfterReads && state.reads >= state.changeAfterReads) state.current = { providerID: "fixture", id: "deep", variant: "medium" };
  writeFileSync(file, JSON.stringify(state));
  console.log(JSON.stringify({ data: { id: state.id, location: { directory: state.directory }, ...(state.current ? { model: state.current } : {}) } }));
} else if (method === "get" && path.startsWith("/api/model/default?")) console.log(JSON.stringify({ data: state.models[0] }));
else if (method === "get" && path.startsWith("/api/model?")) console.log(JSON.stringify({ location: { directory: state.directory }, data: state.models }));
else if (method === "post" && path === "/api/session/" + state.id + "/model" && flag === "--data") { state.current = JSON.parse(body).model; writeFileSync(file, JSON.stringify(state)); }
else console.log(JSON.stringify({ error: { message: "fictional-api-secret" } }));
`);
  chmodSync(binary, 0o700);
  return {
    binary,
    read: () => JSON.parse(readFileSync(state, "utf8")),
    patch: (patch: object) => writeFileSync(state, JSON.stringify({ ...JSON.parse(readFileSync(state, "utf8")), ...patch })),
    calls: (): { method: string; path: string; cwd: string; body?: unknown }[] => readFileSync(calls, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)),
  };
}
