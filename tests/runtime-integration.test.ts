import { expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ModelRuntime,
  ModelRegistry,
  type ExtensionAPI,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import extension from "../index.ts";
import { AccountStore } from "../src/store.ts";

it("switches authentication in the existing Pi runtime without reload", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-accounts-runtime-"));
  const oldDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    const path = join(dir, "auth.json");
    const login = (key: string) =>
      writeFile(path, JSON.stringify({ openai: { type: "api_key", key } }));
    const store = new AccountStore(dir);
    await login("fixture-work");
    await store.save("openai", "work");
    await login("fixture-personal");
    await store.save("openai", "personal");
    const runtime = await ModelRuntime.create({
      authPath: path,
      modelsPath: null,
      modelsStorePath: join(dir, "models-store.json"),
      allowModelNetwork: false,
      refreshOnCreate: false,
    });
    const registry = new ModelRegistry(runtime);
    expect(await registry.getApiKeyForProvider("openai")).toBe("fixture-personal");
    let handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> = async () => {
      throw new Error("No command");
    };
    const emit = vi.fn();
    const names: string[] = [];
    const registerCommand: ExtensionAPI["registerCommand"] = (name, options) => {
      names.push(name);
      if (name === "switch-account") handler = options.handler;
    };
    extension({
      registerCommand,
      on: vi.fn(),
      events: { emit, on: vi.fn() },
    } as unknown as ExtensionAPI);
    const reload = vi.fn();
    const notify = vi.fn();
    expect(names).toEqual(["switch-account"]);
    await handler("openai work", {
      isIdle: () => true,
      hasUI: true,
      modelRegistry: registry,
      reload,
      ui: { notify },
    } as unknown as ExtensionCommandContext);
    expect(await registry.getApiKeyForProvider("openai")).toBe("fixture-work");
    expect(reload).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledWith("pi-accounts:changed", {
      provider: "openai",
      name: "work",
      forceNotify: true,
      storageChanged: true,
    });
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining("Effective on the next request"),
      "info",
    );
    await store.rename("openai", "work", "team  prod");
    await handler("openai personal", {
      isIdle: () => true,
      hasUI: true,
      modelRegistry: registry,
      reload,
      ui: { notify },
    } as unknown as ExtensionCommandContext);
    expect(await registry.getApiKeyForProvider("openai")).toBe("fixture-personal");
    await handler("openai team  prod", {
      isIdle: () => true,
      hasUI: true,
      modelRegistry: registry,
      reload,
      ui: { notify },
    } as unknown as ExtensionCommandContext);
    expect(await registry.getApiKeyForProvider("openai")).toBe("fixture-work");
    expect(emit).toHaveBeenCalledWith("pi-accounts:changed", {
      provider: "openai",
      name: "team  prod",
      forceNotify: true,
      storageChanged: true,
    });
  } finally {
    if (oldDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldDir;
    await rm(dir, { recursive: true, force: true });
  }
});

it("does not start account management in an OMP child", () => {
  const register = vi.fn(() => {
    throw new Error("child must not register account hooks");
  });
  const pi = {
    on: register,
    events: { on: register, emit: register },
    registerCommand: register,
  } as unknown as ExtensionAPI;
  const interval = vi.spyOn(globalThis, "setInterval");
  try {
    vi.stubEnv("PI_OMP_CHILD", "1");
    extension(pi);
    expect(register).not.toHaveBeenCalled();
    expect(interval).not.toHaveBeenCalled();
  } finally {
    interval.mockRestore();
    vi.unstubAllEnvs();
  }
});
