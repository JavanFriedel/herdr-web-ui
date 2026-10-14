import { describe, expect, it } from "bun:test";
import { filterPaneModels, hasOpencodeModelControls, opencodeModelCommand } from "./paneModels.ts";

describe("OpenCode model controls", () => {
  it("requires both an OpenCode pane and the selected bridge's command capability", () => {
    const commands = [{ name: "models", description: "Choose a model", source: "builtin" as const }];
    expect(hasOpencodeModelControls("opencode", commands)).toBe(true);
    expect(hasOpencodeModelControls("claude", commands)).toBe(false);
    expect(hasOpencodeModelControls("opencode", [])).toBe(false);
    expect(hasOpencodeModelControls("opencode", [{ ...commands[0]!, source: "project" }])).toBe(false);
  });
  it("intercepts only standalone model commands, never arbitrary text or arguments", () => {
    for (const command of ["/models", "/model", " /models\n"]) expect(opencodeModelCommand(command)).toBe("model");
    expect(opencodeModelCommand("/variants")).toBe("reasoning");
    for (const text of ["/models provider/model", "explain /models", "/variants high", "/model\nwrite a test", "/MODELS"]) expect(opencodeModelCommand(text)).toBeNull();
  });
  it("searches catalog names, exact provider/model ids and multiple words", () => {
    const models = [{ provider_id: "one", model_id: "fast", name: "Quick model", variants: [] }, { provider_id: "two", model_id: "deep", name: "Deep model", variants: ["high"] }];
    expect(filterPaneModels(models, " ONE quick ")).toEqual([models[0]!]);
    expect(filterPaneModels(models, "two/deep")).toEqual([models[1]!]);
    expect(filterPaneModels(models, "missing")).toEqual([]);
    expect(filterPaneModels(models, "")).toEqual(models);
  });
});
