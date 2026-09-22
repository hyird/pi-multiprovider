import { expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime, ModelRegistry, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import extension from "../index.ts";
import { AccountStore } from "../src/store.ts";

it("switches authentication in the existing Pi runtime without reload", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-accounts-runtime-"));
  const oldDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    const path = join(dir, "auth.json");
    const login = (key: string) => writeFile(path, JSON.stringify({ openai: { type: "api_key", key } }));
    const store = new AccountStore(dir);
    await login("fixture-work"); await store.save("openai", "work");
    await login("fixture-personal"); await store.save("openai", "personal");
    const runtime = await ModelRuntime.create({ authPath: path, modelsPath: null, modelsStorePath: join(dir, "models-store.json"), allowModelNetwork: false, refreshOnCreate: false });
    const registry = new ModelRegistry(runtime);
    expect(await registry.getApiKeyForProvider("openai")).toBe("fixture-personal");
    let handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> = async () => { throw new Error("No command"); };
    const emit = vi.fn();
    const registerCommand: ExtensionAPI["registerCommand"] = (_name, options) => { handler = options.handler; };
    extension({ registerCommand, events: { emit } } as unknown as ExtensionAPI);
    const reload = vi.fn();
    const notify = vi.fn();
    await handler("use openai work", { isIdle: () => true, hasUI: true, modelRegistry: registry, reload, ui: { notify } } as unknown as ExtensionCommandContext);
    expect(await registry.getApiKeyForProvider("openai")).toBe("fixture-work");
    expect(reload).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledWith("pi-accounts:changed", { provider: "openai", name: "work" });
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("Effective on the next request"), "info");
  } finally {
    if (oldDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldDir;
    await rm(dir, { recursive: true, force: true });
  }
});
