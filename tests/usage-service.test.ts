import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { OAuthCredential } from "@earendil-works/pi-ai";
import { AccountStore } from "../src/store.ts";
import { activate } from "../src/menu.ts";
import {
  ACCOUNTS_SERVICE_EVENT,
  createUsageService,
  registerUsageService,
} from "../src/usage-service.ts";

let dir: string;
let store: AccountStore;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pi-service-"));
  store = new AccountStore(dir);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});
it("uses auth.json as current identity and reads inactive keys without changing it", async () => {
  await writeFile(
    join(dir, "auth.json"),
    JSON.stringify({ test: { type: "api_key", key: "current-key" } }),
  );
  await store.save("test", "work");
  await store.add("test", "personal", { type: "api_key", key: "other-key" });
  const service = createUsageService(store);
  const ctx = {
    modelRegistry: {
      getProvider: () => ({
        id: "test",
        auth: {
          apiKey: {
            resolve: async ({ credential }: { credential: { key: string } }) => ({
              auth: { apiKey: credential.key },
            }),
          },
        },
      }),
      getProviderAuth: async () => ({ auth: { apiKey: "current-key" } }),
    },
  } as unknown as ExtensionContext;
  const before = await readFile(join(dir, "auth.json"), "utf8");
  expect(await service.resolveAccountAuth("test/personal", ctx)).toMatchObject({
    accessToken: "other-key",
    label: "personal",
  });
  expect(await readFile(join(dir, "auth.json"), "utf8")).toBe(before);
  expect(await service.resolveActiveAccountAuth("test", ctx)).toMatchObject({
    accessToken: "current-key",
    label: "work",
  });
  // A native login changes the authoritative account, even without a plugin switch event.
  await writeFile(
    join(dir, "auth.json"),
    JSON.stringify({ test: { type: "api_key", key: "other-key" } }),
  );
  expect((await service.getActiveAccount("test", ctx))?.label).toBe("personal");
});
it("resolves bearer headers regardless of capitalization", async () => {
  await writeFile(
    join(dir, "auth.json"),
    JSON.stringify({ test: { type: "api_key", key: "current-key" } }),
  );
  await store.save("test", "current");
  await store.add("test", "inactive", { type: "api_key", key: "inactive-key" });
  const ctx = {
    modelRegistry: {
      getProvider: () => ({
        id: "test",
        auth: {
          apiKey: {
            resolve: async ({ credential }: { credential: { key: string } }) => ({
              auth: { headers: { aUtHoRiZaTiOn: `Bearer ${credential.key}` } },
            }),
          },
        },
      }),
      getProviderAuth: async () => ({ auth: { headers: { AUTHORIZATION: "Bearer current-key" } } }),
    },
  } as unknown as ExtensionContext;
  const service = createUsageService(store);
  expect(await service.resolveActiveAccountAuth("test", ctx)).toMatchObject({
    accessToken: "current-key",
    label: "current",
  });
  expect(await service.resolveAccountAuth("test/inactive", ctx)).toMatchObject({
    accessToken: "inactive-key",
    label: "inactive",
  });
});
it("does not attribute a runtime OpenCode Go key to a different saved account", async () => {
  await writeFile(
    join(dir, "auth.json"),
    JSON.stringify({ "opencode-go": { type: "api_key", key: "saved-key" } }),
  );
  await store.save("opencode-go", "work");
  const ctx = {
    modelRegistry: { getProviderAuth: async () => ({ auth: { apiKey: "runtime-key" } }) },
  } as unknown as ExtensionContext;
  const service = createUsageService(store);
  await expect(service.resolveActiveAccountAuth("opencode-go", ctx)).rejects.toThrow(
    "Current account changed during authentication",
  );
});
it.each(["openai-codex", "xai"])(
  "does not attribute a runtime OAuth token to a different %s account",
  async (provider) => {
    await writeFile(
      join(dir, "auth.json"),
      JSON.stringify({
        [provider]: {
          type: "oauth",
          access: "saved-access",
          refresh: "saved-refresh",
          expires: Date.now() + 3600000,
        },
      }),
    );
    await store.save(provider, "work");
    const ctx = {
      modelRegistry: { getProviderAuth: async () => ({ auth: { apiKey: "runtime-access" } }) },
    } as unknown as ExtensionContext;
    await expect(createUsageService(store).resolveActiveAccountAuth(provider, ctx)).rejects.toThrow(
      "Current account changed during authentication",
    );
  },
);
it("does not demand raw token equality from an extension OAuth provider", async () => {
  await writeFile(
    join(dir, "auth.json"),
    JSON.stringify({
      "xai-oauth": {
        type: "oauth",
        access: "saved-access",
        refresh: "saved-refresh",
        expires: Date.now() + 3600000,
      },
    }),
  );
  await store.save("xai-oauth", "work");
  const ctx = {
    modelRegistry: {
      getProviderAuth: async () => ({ auth: { apiKey: "provider-transformed-access" } }),
    },
  } as unknown as ExtensionContext;
  expect(await createUsageService(store).resolveActiveAccountAuth("xai-oauth", ctx)).toMatchObject({
    accessToken: "provider-transformed-access",
    label: "work",
  });
  const resolved = await createUsageService(store).resolveAccountAuth("xai-oauth/work", ctx);
  await resolved.updateEmail?.("work@example.com");
  expect((await store.list("xai-oauth"))[0]?.email).toBe("work@example.com");
  await store.saveLogin("xai-oauth", "work", {
    type: "oauth",
    access: "another-account-access",
    refresh: "another-account-refresh",
    expires: Date.now() + 3600000,
  });
  await resolved.updateEmail?.("wrong@example.com");
  expect((await store.list("xai-oauth"))[0]?.email).toBeUndefined();
});
it("allows Pi to expand a configured OpenCode Go key before resolving it", async () => {
  await writeFile(
    join(dir, "auth.json"),
    JSON.stringify({ "opencode-go": { type: "api_key", key: "$OPENCODE_API_KEY" } }),
  );
  await store.save("opencode-go", "work");
  const ctx = {
    modelRegistry: { getProviderAuth: async () => ({ auth: { apiKey: "resolved-key" } }) },
  } as unknown as ExtensionContext;
  expect(
    await createUsageService(store).resolveActiveAccountAuth("opencode-go", ctx),
  ).toMatchObject({
    accessToken: "resolved-key",
    label: "work",
  });
});
it("does not report a newly selected account under the previous account ID", async () => {
  await writeFile(
    join(dir, "auth.json"),
    JSON.stringify({ test: { type: "api_key", key: "work-key" } }),
  );
  await store.save("test", "work");
  await store.add("test", "personal", { type: "api_key", key: "personal-key" });
  let entered!: () => void;
  const resolving = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let resume!: () => void;
  const paused = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const ctx = {
    modelRegistry: {
      getProviderAuth: async () => {
        entered();
        await paused;
        return { auth: { apiKey: "personal-key" } };
      },
    },
  } as unknown as ExtensionContext;
  const service = createUsageService(store);
  const result = service.resolveAccountAuth("test/work", ctx);
  await resolving;
  try {
    await store.use("test", "personal");
  } finally {
    resume();
  }
  await expect(result).rejects.toThrow("Current account changed during authentication");
  expect((await service.getActiveAccount("test", ctx))?.id).toBe("test/personal");
});
it("rejects an old token when a new login replaces the same account label", async () => {
  await writeFile(
    join(dir, "auth.json"),
    JSON.stringify({ test: { type: "api_key", key: "old-key" } }),
  );
  await store.save("test", "work");
  let entered!: () => void;
  const resolving = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let resume!: () => void;
  const paused = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const ctx = {
    modelRegistry: {
      getProviderAuth: async () => {
        entered();
        await paused;
        return { auth: { apiKey: "old-key" } };
      },
    },
  } as unknown as ExtensionContext;
  const service = createUsageService(store);
  const pending = service.resolveAccountAuth("test/work", ctx);
  await resolving;
  try {
    await store.saveLogin("test", "work", { type: "api_key", key: "new-key" });
  } finally {
    resume();
  }
  await expect(pending).rejects.toThrow("Current account changed during authentication");
});
it("accepts a token refreshed by the active OAuth provider during resolution", async () => {
  const access = (version: number) =>
    `h.${Buffer.from(
      JSON.stringify({
        sub: "same-user",
        version,
        "https://api.openai.com/auth": { chatgpt_account_id: "account-a" },
      }),
    ).toString("base64url")}.s`;
  const old = {
    type: "oauth",
    access: access(1),
    refresh: "refresh-1",
    expires: 1,
    accountId: "account-a",
  };
  const refreshed = {
    ...old,
    access: access(2),
    refresh: "refresh-2",
    expires: Date.now() + 3600000,
  };
  await writeFile(join(dir, "auth.json"), JSON.stringify({ "openai-codex": old }));
  await store.save("openai-codex", "work");
  const ctx = {
    modelRegistry: {
      getProviderAuth: async () => {
        await writeFile(join(dir, "auth.json"), JSON.stringify({ "openai-codex": refreshed }));
        return { auth: { apiKey: refreshed.access } };
      },
    },
  } as unknown as ExtensionContext;
  const service = createUsageService(store);
  const result = await service.resolveAccountAuth("openai-codex/work", ctx);
  expect(result).toMatchObject({
    accessToken: refreshed.access,
    label: "work",
    slotId: "openai-codex/work",
    authKind: "oauth",
  });
  expect(result.credentialRevision).toBe((await service.listAccounts())[0]?.credentialRevision);
});
it.each(["saved", "active"] as const)(
  "rejects a different OAuth account that reuses the same access token during %s resolution",
  async (kind) => {
    const original = {
      type: "oauth",
      access: "shared-access",
      refresh: "refresh-a",
      expires: 1,
      accountId: "org-a",
    };
    await writeFile(join(dir, "auth.json"), JSON.stringify({ "openai-codex": original }));
    await store.save("openai-codex", "work");
    const ctx = {
      modelRegistry: {
        getProviderAuth: async () => {
          await store.saveLogin("openai-codex", "work", {
            ...original,
            refresh: "refresh-b",
            accountId: "org-b",
          });
          return { auth: { apiKey: original.access } };
        },
      },
    } as unknown as ExtensionContext;
    const service = createUsageService(store);
    const resolving =
      kind === "saved"
        ? service.resolveAccountAuth("openai-codex/work", ctx)
        : service.resolveActiveAccountAuth("openai-codex", ctx);
    await expect(resolving).rejects.toThrow("Current account changed during authentication");
  },
);
it("returns the final credential type when the same active slot changes during resolution", async () => {
  const old = { type: "oauth", access: "old-token", refresh: "old-refresh", expires: 1 };
  await writeFile(join(dir, "auth.json"), JSON.stringify({ test: old }));
  await store.save("test", "work");
  const next = { type: "api_key", key: "new-key" };
  const ctx = {
    modelRegistry: {
      getProviderAuth: async () => {
        await store.saveLogin("test", "work", next);
        return { auth: { apiKey: next.key } };
      },
    },
  } as unknown as ExtensionContext;
  const result = await createUsageService(store).resolveAccountAuth("test/work", ctx);
  expect(result).toMatchObject({
    accessToken: "new-key",
    slotId: "test/work",
    authKind: "api_key",
  });
});
it("resolves every active alias with its own label", async () => {
  await writeFile(
    join(dir, "auth.json"),
    JSON.stringify({ test: { type: "api_key", key: "shared-key" } }),
  );
  await store.save("test", "first");
  await store.save("test", "alias");
  await store.use("test", "alias");
  const ctx = {
    modelRegistry: { getProviderAuth: async () => ({ auth: { apiKey: "shared-key" } }) },
  } as unknown as ExtensionContext;
  const service = createUsageService(store);
  expect(await service.getActiveAccount("test", ctx)).toMatchObject({
    id: "test/alias",
    label: "alias",
  });
  expect(await service.resolveAccountAuth("test/alias", ctx)).toMatchObject({
    accessToken: "shared-key",
    label: "alias",
  });
});
it.each(["authentication", "saved lookup", "current lookup", "identity verification"])(
  "stops waiting when %s is cancelled",
  async (stage) => {
    await writeFile(
      join(dir, "auth.json"),
      JSON.stringify({ test: { type: "api_key", key: "current-key" } }),
    );
    await store.save("test", "work");
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const account = await store.usageAccount("test");
    let reads = 0;
    vi.spyOn(store, "usageAccount").mockImplementation(async () => {
      reads++;
      if (
        (stage === "identity verification" && reads === 2) ||
        ((stage === "saved lookup" || stage === "current lookup") && reads === 1)
      ) {
        entered();
        await gate;
      }
      return account;
    });
    const ctx = {
      modelRegistry: {
        getProviderAuth: async () => {
          if (stage === "authentication") {
            entered();
            await gate;
          }
          return { auth: { apiKey: "current-key" } };
        },
      },
    } as unknown as ExtensionContext;
    const controller = new AbortController();
    const service = createUsageService(store);
    const pending =
      stage === "current lookup"
        ? service.resolveActiveAccountAuth("test", ctx, controller.signal)
        : service.resolveAccountAuth("test/work", ctx, controller.signal);
    try {
      await started;
      controller.abort();
      const outcome = await Promise.race([
        pending.then(
          () => "resolved",
          () => "cancelled",
        ),
        new Promise<string>((resolve) => setTimeout(() => resolve("timed out"), 200)),
      ]);
      expect(outcome).toBe("cancelled");
    } finally {
      release();
      await Promise.allSettled([pending]);
    }
  },
);
it("refreshes expired inactive OAuth credentials only in the account pool", async () => {
  await writeFile(
    join(dir, "auth.json"),
    JSON.stringify({ test: { type: "api_key", key: "current-key" } }),
  );
  await store.add("test", "oauth", {
    type: "oauth",
    access: "expired",
    refresh: "refresh-old",
    expires: 1,
  });
  const refresh = vi.fn(async (credential: OAuthCredential) => ({
    ...credential,
    access: "new-access",
    refresh: "new-refresh",
    expires: Date.now() + 3600000,
  }));
  const ctx = {
    modelRegistry: {
      getProvider: () => ({
        id: "test",
        auth: {
          oauth: {
            refresh,
            toAuth: async (credential: OAuthCredential) => ({ apiKey: credential.access }),
          },
        },
      }),
    },
  } as unknown as ExtensionContext;
  const before = await readFile(join(dir, "auth.json"), "utf8");
  const service = createUsageService(store);
  const resolved = await service.resolveAccountAuth("test/oauth", ctx);
  expect(resolved).toMatchObject({ accessToken: "new-access", label: "oauth" });
  expect(resolved?.credentialRevision).toBe(
    (await service.listAccounts()).find((account) => account.id === "test/oauth")
      ?.credentialRevision,
  );
  expect(refresh).toHaveBeenCalledOnce();
  expect(await readFile(join(dir, "auth.json"), "utf8")).toBe(before);
  expect(await readFile(join(dir, "accounts.json"), "utf8")).toContain("new-refresh");
});
it("stops a cancelled inactive account lookup while another refresh owns its slot", async () => {
  await store.add("test", "inactive", { type: "api_key", key: "fixture-key" });
  let started!: () => void;
  const active = new Promise<void>((resolve) => {
    started = resolve;
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = store.withAccount("test", "inactive", async (credential) => {
    started();
    await gate;
    return { credential, result: "first" };
  });
  await active;
  const original = store.withAccount.bind(store);
  let queued!: () => void;
  const enteredQueue = new Promise<void>((resolve) => {
    queued = resolve;
  });
  vi.spyOn(store, "withAccount").mockImplementation((provider, name, fn, signal) => {
    queued();
    return original(provider, name, fn, signal);
  });
  const ctx = {
    modelRegistry: {
      getProvider: () => ({
        id: "test",
        auth: {
          apiKey: {
            resolve: async ({ credential }: { credential: { key: string } }) => ({
              auth: { apiKey: credential.key },
            }),
          },
        },
      }),
    },
  } as unknown as ExtensionContext;
  const controller = new AbortController();
  const pending = createUsageService(store).resolveAccountAuth(
    "test/inactive",
    ctx,
    controller.signal,
  );
  try {
    await enteredQueue;
    controller.abort();
    const outcome = await Promise.race([
      pending.then(
        () => "resolved",
        () => "cancelled",
      ),
      new Promise<string>((resolve) => setTimeout(() => resolve("timed out"), 200)),
    ]);
    expect(outcome).toBe("cancelled");
  } finally {
    release();
    await Promise.allSettled([first, pending]);
  }
});
it("notifies only listeners for the changed provider", () => {
  const service = createUsageService(store);
  const callback = vi.fn();
  const off = service.onActiveAccountChanged("test", callback);
  service.changed("other");
  expect(callback).not.toHaveBeenCalled();
  service.changed("test");
  expect(callback).toHaveBeenCalledOnce();
  expect(callback).toHaveBeenLastCalledWith({ providerId: "test", ctx: undefined });
  service.changed("test", undefined, "metadata");
  expect(callback).toHaveBeenLastCalledWith({
    providerId: "test",
    ctx: undefined,
    kind: "metadata",
  });
  off();
  service.changed("test");
  expect(callback).toHaveBeenCalledTimes(2);
});
it.each([false, true])(
  "isolates listener failures, including asynchronous failures: %s",
  async (asynchronous) => {
    const service = createUsageService(store);
    service.onActiveAccountChanged("test", () => {
      if (asynchronous) return Promise.reject(new Error("consumer failed asynchronously"));
      throw new Error("consumer failed");
    });
    const healthy = vi.fn();
    service.onActiveAccountChanged("test", healthy);
    expect(() => service.changed("test")).not.toThrow();
    expect(healthy).toHaveBeenCalledOnce();
    await new Promise<void>((resolve) => setImmediate(resolve));
  },
);

it("notifies newly registered listeners only on the next account change", () => {
  const service = createUsageService(store);
  service.onActiveAccountChanged("test", () => {});
  const replacement = vi.fn();
  const off = service.onActiveAccountChanged("test", () => {
    off();
    service.onActiveAccountChanged("test", replacement);
  });
  service.changed("test");
  expect(replacement).not.toHaveBeenCalled();
  service.changed("test");
  expect(replacement).toHaveBeenCalledOnce();
});

it("notifies usage consumers when a repeated switch only refreshes Pi's runtime", async () => {
  await writeFile(
    join(dir, "auth.json"),
    JSON.stringify({ test: { type: "api_key", key: "current-key" } }),
  );
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void>>();
  const events = new Map<string, (value: unknown) => void>();
  let service: ReturnType<typeof createUsageService> | undefined;
  const pi = {
    on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void>) =>
      handlers.set(name, handler),
    events: {
      on: (name: string, handler: (value: unknown) => void) => events.set(name, handler),
      emit: (name: string, value: unknown) => {
        if (name === ACCOUNTS_SERVICE_EVENT) service = value as typeof service;
      },
    },
  } as unknown as ExtensionAPI;
  const ctx = { hasUI: false } as ExtensionContext;
  registerUsageService(pi, store);
  try {
    await handlers.get("session_start")!({}, ctx);
    const changed = vi.fn();
    service!.onActiveAccountChanged("test", changed);
    events.get("pi-accounts:changed")!({ provider: "test", name: "default", forceNotify: true });
    expect(changed).toHaveBeenCalledOnce();
    events.get("pi-accounts:changed")!({
      provider: "test",
      name: "alias",
      forceNotify: true,
      kind: "metadata",
    });
    expect(changed).toHaveBeenLastCalledWith({ providerId: "test", ctx, kind: "metadata" });
  } finally {
    await handlers.get("session_shutdown")!({}, ctx);
  }
});

it.each([false, true])(
  "notifies after runtime refresh even when the watcher ran first: %s",
  async (slow) => {
    await writeFile(
      join(dir, "auth.json"),
      JSON.stringify({ test: { type: "api_key", key: "old" } }),
    );
    await store.save("test", "old");
    await store.add("test", "next", { type: "api_key", key: "next" });
    const handlers = new Map<string, any>();
    const events = new Map<string, any>();
    let service: ReturnType<typeof createUsageService> | undefined;
    const pi = {
      on: (name: string, handler: any) => handlers.set(name, handler),
      events: {
        on: (name: string, handler: any) => events.set(name, handler),
        emit: (name: string, value: unknown) => {
          if (name === ACCOUNTS_SERVICE_EVENT) service = value as typeof service;
          events.get(name)?.(value);
        },
      },
    } as unknown as ExtensionAPI;
    let refreshed = false;
    const notifications: boolean[] = [];
    const ctx: any = {
      hasUI: false,
      isIdle: () => true,
      ui: { notify: vi.fn() },
      modelRegistry: {
        getProviderDisplayName: () => "Test",
        refresh: async () => {
          if (slow) await vi.waitFor(() => expect(notifications).toEqual([false]));
          refreshed = true;
          return { errors: new Map(), aborted: false };
        },
      },
    };
    registerUsageService(pi, store);
    try {
      await handlers.get("session_start")({}, ctx);
      service!.onActiveAccountChanged("test", () => notifications.push(refreshed));
      await activate(pi, ctx, store, "test", "next");
      await vi.waitFor(() => expect(notifications).toEqual(slow ? [false, true] : [true]));
      // A further reconciliation must not duplicate the settled switch.
      await handlers.get("session_start")({}, ctx);
      expect(notifications).toEqual(slow ? [false, true] : [true]);
    } finally {
      await handlers.get("session_shutdown")({}, ctx);
    }
  },
);

it("sends one metadata notification for a persisted preferred-label switch", async () => {
  await writeFile(
    join(dir, "auth.json"),
    JSON.stringify({ test: { type: "api_key", key: "current-key" } }),
  );
  await store.save("test", "default");
  await store.save("test", "alias");
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void>>();
  const events = new Map<string, (value: unknown) => void>();
  let service: ReturnType<typeof createUsageService> | undefined;
  const pi = {
    on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void>) =>
      handlers.set(name, handler),
    events: {
      on: (name: string, handler: (value: unknown) => void) => events.set(name, handler),
      emit: (name: string, value: unknown) => {
        if (name === ACCOUNTS_SERVICE_EVENT) service = value as typeof service;
      },
    },
  } as unknown as ExtensionAPI;
  const ctx = { hasUI: false } as ExtensionContext;
  registerUsageService(pi, store);
  try {
    await handlers.get("session_start")!({}, ctx);
    const changed = vi.fn();
    service!.onActiveAccountChanged("test", changed);
    await store.use("test", "alias");
    events.get("pi-accounts:changed")!({
      provider: "test",
      name: "alias",
      forceNotify: true,
      kind: "metadata",
      storageChanged: true,
    });
    await vi.waitFor(() => expect(changed).toHaveBeenCalledOnce());
    await handlers.get("session_start")!({}, ctx);
    expect(changed).toHaveBeenCalledOnce();
    expect(changed).toHaveBeenLastCalledWith({ providerId: "test", ctx, kind: "metadata" });
  } finally {
    await handlers.get("session_shutdown")!({}, ctx);
  }
});

it("announces an email-only storage update as metadata", async () => {
  await store.add("test", "work", { type: "api_key", key: "fixture-key" });
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void>>();
  let service: ReturnType<typeof createUsageService> | undefined;
  const pi = {
    on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void>) =>
      handlers.set(name, handler),
    events: {
      on: () => undefined,
      emit: (name: string, value: unknown) => {
        if (name === ACCOUNTS_SERVICE_EVENT) service = value as typeof service;
      },
    },
  } as unknown as ExtensionAPI;
  const ctx = { hasUI: false } as ExtensionContext;
  registerUsageService(pi, store);
  try {
    await handlers.get("session_start")!({}, ctx);
    const changed = vi.fn();
    service!.onActiveAccountChanged("test", changed);
    await service!.updateAccountEmail("test/work", "work@example.com", "fixture-key");
    await vi.waitFor(() =>
      expect(changed).toHaveBeenCalledWith({ providerId: "test", ctx, kind: "metadata" }),
    );
  } finally {
    await handlers.get("session_shutdown")!({}, ctx);
  }
});

it("receives provider email metadata for exactly the resolved saved account", async () => {
  await store.add("test", "work", { type: "api_key", key: "fixture-key" });
  const service = createUsageService(store);
  await service.updateAccountEmail("test/work", "work@example.com", "fixture-key");
  expect((await store.list("test"))[0]?.email).toBe("work@example.com");
  expect((await service.listAccounts())[0]).toMatchObject({
    id: "test/work",
    email: "work@example.com",
  });
  await service.updateAccountEmail("test/work", "other@example.com", "other-key");
  expect((await store.list("test"))[0]?.email).toBe("work@example.com");
});

it("returns saved email with the active account authentication", async () => {
  await store.add("test", "work", { type: "api_key", key: "fixture-key" });
  await store.use("test", "work");
  const service = createUsageService(store);
  await service.updateAccountEmail("test/work", "work@example.com", "fixture-key");
  const ctx = {
    modelRegistry: { getProviderAuth: async () => ({ auth: { apiKey: "fixture-key" } }) },
  } as unknown as ExtensionContext;
  expect(await service.resolveActiveAccountAuth("test", ctx)).toMatchObject({
    label: "work",
    email: "work@example.com",
    accessToken: "fixture-key",
  });
});

it("updates email from a canonical account ID without reading the whole roster", async () => {
  await store.add("custom/path", "work/personal", { type: "api_key", key: "fixture-key" });
  const service = createUsageService(store);
  const rosterRead = vi.spyOn(store, "usageAccounts");
  const emailWrite = vi.spyOn(store, "updateEmail");
  await service.updateAccountEmail(
    "custom/path/work%2Fpersonal",
    "work@example.com",
    "fixture-key",
  );
  await service.updateAccountEmail(
    "custom/path/work%2fpersonal",
    "wrong@example.com",
    "fixture-key",
  );
  await service.updateAccountEmail("custom/path/%zz", "wrong@example.com", "fixture-key");
  await service.updateAccountEmail("current:custom/path", "wrong@example.com", "fixture-key");
  expect(rosterRead).not.toHaveBeenCalled();
  expect(emailWrite).toHaveBeenCalledOnce();
  expect((await store.list("custom/path"))[0]?.email).toBe("work@example.com");
});

it("marks an unknown auth.json login as Unmanaged without importing it into the pool", async () => {
  await store.add("test", "saved", { type: "api_key", key: "saved-key" });
  await writeFile(
    join(dir, "auth.json"),
    JSON.stringify({ test: { type: "api_key", key: "external-key" } }),
  );
  const pool = await readFile(join(dir, "accounts.json"), "utf8");
  const service = createUsageService(store);
  const ctx = {
    modelRegistry: { getProviderAuth: async () => ({ auth: { apiKey: "external-key" } }) },
  } as unknown as ExtensionContext;
  expect(await service.listAccounts()).toEqual([
    {
      id: "test/saved",
      providerId: "test",
      label: "saved",
      authKind: "api_key",
      active: false,
      credentialRevision: expect.stringMatching(/^[0-9a-f]{64}$/),
    },
    {
      id: "current:test",
      providerId: "test",
      label: "Unmanaged",
      authKind: "api_key",
      active: true,
      credentialRevision: expect.stringMatching(/^[0-9a-f]{64}$/),
    },
  ]);
  expect(await service.resolveAccountAuth("current:test", ctx)).toMatchObject({
    accessToken: "external-key",
    label: "Unmanaged",
  });
  expect(await readFile(join(dir, "accounts.json"), "utf8")).toBe(pool);
});

it("does not resolve an unmanaged ID after that login becomes a saved account", async () => {
  await writeFile(
    join(dir, "auth.json"),
    JSON.stringify({ test: { type: "api_key", key: "external-key" } }),
  );
  let entered!: () => void;
  const resolving = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let resume!: () => void;
  const paused = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const ctx = {
    modelRegistry: {
      getProviderAuth: async () => {
        entered();
        await paused;
        return { auth: { apiKey: "external-key" } };
      },
    },
  } as unknown as ExtensionContext;
  const service = createUsageService(store);
  const pending = service.resolveAccountAuth("current:test", ctx);
  await resolving;
  try {
    await store.save("test", "work");
  } finally {
    resume();
  }
  await expect(pending).rejects.toThrow("Current account changed during authentication");
  expect((await service.getActiveAccount("test", ctx))?.id).toBe("test/work");
});

it("changes the account revision only when its credential changes", async () => {
  await store.add("test", "work", { type: "api_key", key: "first-key" });
  const service = createUsageService(store);
  const first = (await service.listAccounts())[0]!;
  await service.updateAccountEmail(first.id, "work@example.com", "first-key");
  expect((await service.listAccounts())[0]?.credentialRevision).toBe(first.credentialRevision);
  await store.saveLogin("test", "work", { type: "api_key", key: "second-key" });
  const second = (await service.listAccounts()).find((account) => account.id === first.id)!;
  expect(second.credentialRevision).not.toBe(first.credentialRevision);
  expect(second.credentialRevision).not.toContain("second-key");
});

it.each([false, true])(
  "does not revive a stopped startup or erase a newer session: %s",
  async (restart) => {
    const handlers = new Map<string, any>();
    const events = new Map<string, any>();
    const announced = vi.fn();
    let service!: ReturnType<typeof createUsageService>;
    const pi = {
      on: (name: string, handler: any) => handlers.set(name, handler),
      events: {
        on: (name: string, handler: any) => events.set(name, handler),
        emit: (name: string, value: unknown) => {
          if (name === ACCOUNTS_SERVICE_EVENT) {
            service = value as typeof service;
            announced();
          }
        },
      },
    } as unknown as ExtensionAPI;
    let entered!: () => void;
    let release!: () => void;
    const running = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reconcile = store.reconcileCurrentAccounts.bind(store);
    vi.spyOn(store, "reconcileCurrentAccounts").mockImplementationOnce(async () => {
      entered();
      await gate;
      return reconcile();
    });
    const oldContext = { hasUI: false };
    const newContext = { hasUI: false };
    registerUsageService(pi, store);
    const changed = vi.fn();
    service.onActiveAccountChanged("test", changed);
    const starting = handlers.get("session_start")({}, oldContext);
    await running;
    events.get("pi-accounts:changed")({
      provider: "test",
      forceNotify: true,
      storageChanged: true,
    });
    const stopping = handlers.get("session_shutdown")({});
    const restarting = restart ? handlers.get("session_start")({}, newContext) : Promise.resolve();
    if (restart)
      events.get("pi-accounts:changed")({
        provider: "test",
        forceNotify: true,
        storageChanged: true,
      });
    try {
      release();
      await Promise.all([starting, stopping, restarting]);
      expect(announced).toHaveBeenCalledTimes(restart ? 2 : 1);
      expect(changed).toHaveBeenCalledTimes(restart ? 1 : 0);
      if (restart) {
        events.get("pi-accounts:changed")({ provider: "test", forceNotify: true });
        expect(changed).toHaveBeenLastCalledWith({ providerId: "test", ctx: newContext });
      }
    } finally {
      release();
      await handlers.get("session_shutdown")({});
    }
  },
);

it("publishes startup synchronization and notifies usage listeners after native login and logout", async () => {
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void>>();
  let service: ReturnType<typeof createUsageService> | undefined;
  const notify = vi.fn();
  const ctx = { hasUI: true, ui: { notify } } as unknown as ExtensionContext;
  const pi = {
    on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void>) =>
      handlers.set(name, handler),
    events: {
      on: vi.fn(),
      emit: (name: string, value: unknown) => {
        if (name === ACCOUNTS_SERVICE_EVENT) service = value as typeof service;
      },
    },
  } as unknown as ExtensionAPI;
  await writeFile(
    join(dir, "auth.json"),
    JSON.stringify({ test: { type: "api_key", key: "startup" } }),
  );
  registerUsageService(pi, store);
  const changed = vi.fn();
  service!.onActiveAccountChanged("test", changed);
  try {
    await handlers.get("session_start")!({}, ctx);
    expect((await service!.getActiveAccount("test", ctx))?.label).toBe("default");
    expect(changed).toHaveBeenCalledTimes(1);
    await writeFile(
      join(dir, "auth.json"),
      JSON.stringify({ test: { type: "api_key", key: "native-login" } }),
    );
    await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(2));
    expect((await service!.getActiveAccount("test", ctx))?.label).toBe("default-2");
    expect(notify).toHaveBeenCalledTimes(2);
    await writeFile(join(dir, "auth.json"), "{}");
    await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(3));
    expect(await service!.getActiveAccount("test", ctx)).toBeUndefined();
    expect(await service!.listAccounts()).toHaveLength(1);
    expect(notify).toHaveBeenCalledTimes(2);
  } finally {
    await handlers.get("session_shutdown")!({}, ctx);
  }
});
