import { expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ModelRuntime,
  ModelRegistry,
  discoverAndLoadExtensions,
  type ExtensionAPI,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import extension from "../index.ts";
import { runAccountCommand } from "../src/menu.ts";
import { AccountStore } from "../src/store.ts";
import { fileURLToPath } from "node:url";

it("loads through Pi's extension loader and registers native OpenAI OAuth", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-accounts-loader-"));
  try {
    // Direct Vitest imports bypass Pi's jiti aliases and cannot detect broken
    // provider subpath imports. Load the real entrypoint through Pi instead.
    const entry = fileURLToPath(new URL("../index.ts", import.meta.url));
    const result = await discoverAndLoadExtensions([entry], dir, dir);
    expect(result.errors).toEqual([]);
    expect(result.extensions).toHaveLength(1);
    expect(result.extensions[0]!.commands.has("switch-account")).toBe(true);
    const provider = result.runtime.pendingNativeProviderRegistrations.find(
      (registration) => registration.provider.id === "openai",
    )?.provider;
    expect(provider?.auth.oauth?.login).toBeTypeOf("function");
    expect(provider?.auth.apiKey).toBeDefined();
    expect(provider?.streamSimple).toBeTypeOf("function");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it.each(["api_key", "oauth"])("switches native OpenAI %s authentication in the existing Pi runtime without reload", async (authType) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-accounts-runtime-"));
  const oldDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    const path = join(dir, "auth.json");
    const login = (key: string) =>
      writeFile(path, JSON.stringify({ openai: authType === "oauth" ? {
        type: "oauth", access: key, refresh: `refresh-${key}`, expires: Date.now() + 3_600_000,
        clientId: "fixture-client", scopes: ["chatgpt.tokens.use.direct"],
      } : { type: "api_key", key } }));
    const store = new AccountStore(dir);
    await login("fixture-work");
    await store.reconcileCurrentAccounts();
    await store.rename("openai", "default", "work");
    await login("fixture-personal");
    await store.reconcileCurrentAccounts();
    await store.rename("openai", "default", "personal");
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
      registerProvider: registry.registerProvider.bind(registry),
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
    if (authType === "oauth") {
      expect(JSON.parse(await readFile(path, "utf8")).openai).toMatchObject({
        clientId: "fixture-client", scopes: ["chatgpt.tokens.use.direct"],
      });
    }
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

it("native /login openai API-key credentials synchronize, switch through RPC and logout without touching legacy auth", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-native-openai-login-"));
  const originalDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    const authPath = join(dir, "auth.json");
    const legacy = { type: "oauth", access: "fixture-legacy", refresh: "legacy-refresh", expires: Date.now() + 3_600_000 };
    await writeFile(authPath, JSON.stringify({ "openai-codex": legacy }));
    const runtime = await ModelRuntime.create({
      authPath, modelsPath: null, modelsStorePath: join(dir, "models-store.json"),
      allowModelNetwork: false, refreshOnCreate: false,
    });
    const store = new AccountStore(dir);
    for (const name of ["work", "personal"]) {
      await runtime.login("openai", "api_key", {
        prompt: async (prompt) => {
          expect(prompt.type).toBe("secret");
          return `fixture-${name}`;
        },
        notify: vi.fn(),
      });
      await store.reconcileCurrentAccounts();
      await store.rename("openai", "default", name);
    }
    expect(await store.list("openai")).toEqual([
      { name: "work", active: false }, { name: "personal", active: true },
    ]);
    const registry = new ModelRegistry(runtime);
    expect(await registry.getApiKeyForProvider("openai")).toBe("fixture-personal");
    const emit = vi.fn();
    const pi = { events: { emit } } as unknown as ExtensionAPI;
    let selections = 0;
    const custom = vi.fn();
    const select = vi.fn(async (_title: string, options: string[]) => {
      const selected = options.find((option) => selections === 0
        ? option.endsWith(" · personal") : option.endsWith("work · Saved"));
      selections++;
      expect(selected).toBeDefined();
      return selected;
    });
    const reload = vi.fn();
    await runAccountCommand(pi, {
      mode: "rpc", hasUI: true, isIdle: () => true, modelRegistry: registry, reload,
      ui: { select, custom, notify: vi.fn() },
    } as unknown as ExtensionCommandContext, store);
    expect(select).toHaveBeenCalledTimes(2);
    expect(custom).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
    expect(await registry.getApiKeyForProvider("openai")).toBe("fixture-work");
    expect(emit).toHaveBeenCalledWith("pi-accounts:changed", expect.objectContaining({ provider: "openai", name: "work" }));
    await runtime.logout("openai");
    await store.reconcileCurrentAccounts();
    expect((await store.list("openai")).map((account) => account.name)).toEqual(["personal"]);
    expect(JSON.parse(await readFile(authPath, "utf8"))["openai-codex"]).toEqual(legacy);
  } finally {
    if (originalDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalDir;
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
    registerProvider: vi.fn(),
  } as unknown as ExtensionAPI;
  const interval = vi.spyOn(globalThis, "setInterval");
  try {
    vi.stubEnv("PI_OMP_CHILD", "1");
    extension(pi);
    expect(pi.registerProvider).toHaveBeenCalledWith(expect.objectContaining({ id: "openai" }));
    expect(register).not.toHaveBeenCalled();
    expect(interval).not.toHaveBeenCalled();
  } finally {
    interval.mockRestore();
    vi.unstubAllEnvs();
  }
});
