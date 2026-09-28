import { mkdtemp, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import type { FSWatcher } from "node:fs";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AccountStore } from "../src/store.ts";
import { createAuthSync } from "../src/auth-sync.ts";

let dir: string;
let store: AccountStore;
let sync: ReturnType<typeof createAuthSync> | undefined;
const key = (value: string) => ({ type: "api_key", key: value });
const login = (value: unknown) => writeFile(join(dir, "auth.json"), JSON.stringify(value));
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pi-auth-sync-"));
  store = new AccountStore(dir);
});
afterEach(async () => {
  await sync?.stop();
  sync = undefined;
  await rm(dir, { recursive: true, force: true });
});

it("imports new logins, retains names and removes only the logged-out account", async () => {
  await login({ test: key("a") });
  expect(await store.reconcileCurrentAccounts()).toEqual({
    changed: ["test"],
    added: [{ provider: "test", name: "default" }],
  });
  await store.rename("test", "default", "work");
  await login({ test: key("b") });
  await store.reconcileCurrentAccounts();
  await login({ test: key("c") });
  expect((await store.reconcileCurrentAccounts()).added).toEqual([
    { provider: "test", name: "default-2" },
  ]);
  await login({ test: key("a") });
  expect((await store.reconcileCurrentAccounts()).added).toEqual([]);
  expect((await store.list("test")).find((a) => a.active)?.name).toBe("work");
  await login({});
  expect((await store.reconcileCurrentAccounts()).changed).toEqual(["test"]);
  expect(await store.list("test")).toHaveLength(2);
  expect((await store.list("test")).some((a) => a.name === "work")).toBe(false);
  expect((await store.list("test")).some((a) => a.active)).toBe(false);
  expect(JSON.parse(await readFile(join(dir, "auth.json"), "utf8"))).toEqual({});
  expect((await store.reconcileCurrentAccounts()).changed).toEqual([]);
});

it("keeps one API-key account when provider environment keys change order", async () => {
  const first = { type: "api_key", key: "same-key", env: { REGION: "a", TENANT: "b" } };
  const reordered = { type: "api_key", key: "same-key", env: { TENANT: "b", REGION: "a" } };
  await login({ test: first });
  await store.reconcileCurrentAccounts();
  await store.rename("test", "default", "work");
  await store.reconcileCurrentAccounts();
  const poolBefore = await readFile(join(dir, "accounts.json"), "utf8");
  const revisionBefore = (await store.listAccounts())[0]?.credentialRevision;
  await login({ test: reordered });
  expect(await store.reconcileCurrentAccounts()).toEqual({ changed: [], added: [] });
  expect(await readFile(join(dir, "accounts.json"), "utf8")).toBe(poolBefore);
  expect((await store.listAccounts())[0]?.credentialRevision).toBe(revisionBefore);
  expect(await store.list("test")).toEqual([{ name: "work", active: true }]);
});

it("marks the provider changed when a saved display email changes", async () => {
  await login({ test: key("a") });
  await store.reconcileCurrentAccounts();
  expect((await store.listAccounts())[0]?.email).toBeUndefined();
  await store.updateEmail("test", "default", "work@example.com", "a");
  expect(await store.reconcileCurrentAccounts()).toEqual({
    changed: ["test"],
    added: [],
    metadataChanged: ["test"],
  });
  expect((await store.listAccounts())[0]?.email).toBe("work@example.com");
  expect(await store.reconcileCurrentAccounts()).toEqual({ changed: [], added: [] });
});

it("treats selecting another label for the same credential as display metadata", async () => {
  await login({ test: key("shared") });
  await store.reconcileCurrentAccounts();
  await store.save("test", "alias");
  await store.reconcileCurrentAccounts();

  await store.use("test", "alias");
  expect(await store.reconcileCurrentAccounts()).toEqual({
    changed: ["test"],
    added: [],
    metadataChanged: ["test"],
  });
});

it("treats saved-label changes and duplicate aliases as metadata", async () => {
  await login({ test: key("active") });
  await store.reconcileCurrentAccounts();
  await store.add("test", "spare", key("inactive"));
  await store.reconcileCurrentAccounts();

  await store.rename("test", "default", "work");
  expect(await store.reconcileCurrentAccounts()).toEqual({
    changed: ["test"],
    added: [],
    metadataChanged: ["test"],
  });
  await store.rename("test", "spare", "personal");
  expect(await store.reconcileCurrentAccounts()).toEqual({
    changed: ["test"],
    added: [],
    metadataChanged: ["test"],
  });
  await store.save("test", "alias");
  expect(await store.reconcileCurrentAccounts()).toEqual({
    changed: ["test"],
    added: [],
    metadataChanged: ["test"],
  });
});

it("announces an inactive account credential refresh without changing the active login", async () => {
  await login({ test: key("active") });
  await store.reconcileCurrentAccounts();
  await store.add("test", "inactive", {
    type: "oauth",
    access: "old-access",
    refresh: "same-refresh",
    expires: 1,
  });
  await store.reconcileCurrentAccounts();
  const before = await readFile(join(dir, "auth.json"), "utf8");
  await store.withAccount("test", "inactive", async (value) => ({
    credential: { ...(value as object), access: "new-access", expires: 2 },
    result: undefined,
  }));
  expect(await readFile(join(dir, "auth.json"), "utf8")).toBe(before);
  expect(await store.reconcileCurrentAccounts()).toEqual({ changed: ["test"], added: [] });
});

it("ignores OAuth JSON field order without hiding a real token change", async () => {
  const first = {
    type: "oauth",
    access: "opaque-token",
    refresh: "same-refresh",
    expires: 1000,
    accountId: "org",
  };
  const reordered = {
    accountId: "org",
    expires: 1000,
    refresh: "same-refresh",
    access: "opaque-token",
    type: "oauth",
  };
  await login({ test: first });
  await store.reconcileCurrentAccounts();
  const revision = (await store.listAccounts())[0]?.credentialRevision;
  const poolBefore = await readFile(join(dir, "accounts.json"), "utf8");
  await login({ test: reordered });
  expect(await store.reconcileCurrentAccounts()).toEqual({ changed: [], added: [] });
  expect((await store.listAccounts())[0]?.credentialRevision).toBe(revision);
  expect(await readFile(join(dir, "accounts.json"), "utf8")).toBe(poolBefore);
  await login({ test: { ...reordered, access: "new-token" } });
  expect((await store.reconcileCurrentAccounts()).changed).toEqual(["test"]);
  expect((await store.listAccounts())[0]?.credentialRevision).not.toBe(revision);
});

it("updates recognizable OAuth tokens without overwriting ambiguous identities", async () => {
  const oauth = (version: number) => ({
    type: "oauth",
    access: `x.${Buffer.from(JSON.stringify({ sub: "alice", version })).toString("base64url")}.y`,
    refresh: `r${version}`,
    expires: version,
  });
  await login({ test: oauth(1) });
  await store.save("test", "work");
  await store.reconcileCurrentAccounts();
  await login({ test: oauth(2) });
  expect(await store.reconcileCurrentAccounts()).toEqual({ changed: ["test"], added: [] });
  expect(
    JSON.parse(await readFile(join(dir, "accounts.json"), "utf8")).accounts[0].credential,
  ).toEqual(oauth(2));
  await login({ test: { ...oauth(3), access: "opaque" } });
  expect((await store.reconcileCurrentAccounts()).added).toEqual([
    { provider: "test", name: "default" },
  ]);
  expect(await store.list("test")).toEqual([
    { name: "work", active: false },
    { name: "default", active: true },
  ]);
});

it("keeps an OAuth account when refresh adds accountId, but separates conflicting IDs", async () => {
  const first = { type: "oauth", access: "opaque-1", refresh: "same-refresh", expires: 1 };
  await login({ test: first });
  await store.reconcileCurrentAccounts();
  await store.rename("test", "default", "work");
  const identified = { ...first, accountId: "account-a", access: "opaque-2" };
  await login({ test: identified });
  expect((await store.reconcileCurrentAccounts()).added).toEqual([]);
  expect(await store.list("test")).toEqual([{ name: "work", active: true }]);
  await login({ test: { ...identified, accountId: "account-b" } });
  expect((await store.reconcileCurrentAccounts()).added).toEqual([
    { provider: "test", name: "default" },
  ]);
  expect(await store.list("test")).toEqual([
    { name: "work", active: false },
    { name: "default", active: true },
  ]);
});

it("keeps Codex OAuth accounts with the same subject but different token account IDs separate", async () => {
  const oauth = (accountId: string) => ({
    type: "oauth",
    access: `h.${Buffer.from(JSON.stringify({ sub: "same-user", "https://api.openai.com/auth": { chatgpt_account_id: accountId } })).toString("base64url")}.s`,
    refresh: `refresh-${accountId}`,
    expires: Date.now() + 3600000,
  });
  await login({ "openai-codex": oauth("account-a") });
  await store.reconcileCurrentAccounts();
  await store.rename("openai-codex", "default", "work");
  await login({ "openai-codex": oauth("account-b") });
  expect((await store.reconcileCurrentAccounts()).added).toEqual([
    { provider: "openai-codex", name: "default" },
  ]);
  expect(await store.list("openai-codex")).toEqual([
    { name: "work", active: false },
    { name: "default", active: true },
  ]);
  await login({});
  await store.reconcileCurrentAccounts();
  expect(await store.list("openai-codex")).toEqual([{ name: "work", active: false }]);
});

it("does not merge an explicit account ID with a different ID in a rotated token", async () => {
  const token = (accountId?: string) =>
    `h.${Buffer.from(
      JSON.stringify({
        sub: "same-user",
        ...(accountId ? { "https://api.openai.com/auth": { chatgpt_account_id: accountId } } : {}),
      }),
    ).toString("base64url")}.s`;
  await login({
    "openai-codex": {
      type: "oauth",
      access: token(),
      refresh: "first",
      expires: 1,
      accountId: "account-a",
    },
  });
  await store.reconcileCurrentAccounts();
  await store.rename("openai-codex", "default", "work");
  await login({
    "openai-codex": { type: "oauth", access: token("account-b"), refresh: "second", expires: 2 },
  });
  expect((await store.reconcileCurrentAccounts()).added).toEqual([
    { provider: "openai-codex", name: "default" },
  ]);
  expect(await store.list("openai-codex")).toEqual([
    { name: "work", active: false },
    { name: "default", active: true },
  ]);
});

it("does not merge a conflicting stored account ID through an unchanged access token", async () => {
  const access = `h.${Buffer.from(
    JSON.stringify({
      sub: "same-user",
      "https://api.openai.com/auth": { chatgpt_account_id: "account-b" },
    }),
  ).toString("base64url")}.s`;
  const current = { type: "oauth", access, refresh: "shared-refresh", expires: 1 };
  const stored = { ...current, accountId: "account-a" };
  await writeFile(
    join(dir, "accounts.json"),
    JSON.stringify({
      version: 1,
      accounts: [{ provider: "openai-codex", name: "work", credential: stored }],
    }),
  );
  await login({ "openai-codex": current });
  expect((await store.reconcileCurrentAccounts()).added).toEqual([
    { provider: "openai-codex", name: "default" },
  ]);
  expect(await store.list("openai-codex")).toEqual([
    { name: "work", active: false },
    { name: "default", active: true },
  ]);
  await login({});
  await store.reconcileCurrentAccounts();
  expect(await store.list("openai-codex")).toEqual([{ name: "work", active: false }]);
});

it("does not delete saved accounts at startup or when the auth file disappears", async () => {
  await login({ test: key("a") });
  await store.reconcileCurrentAccounts();
  await unlink(join(dir, "auth.json"));
  await store.reconcileCurrentAccounts();
  expect(await store.list("test")).toEqual([{ name: "default", active: false }]);
  await login({});
  const restarted = new AccountStore(dir);
  await restarted.reconcileCurrentAccounts();
  expect(await restarted.list("test")).toEqual([{ name: "default", active: false }]);
});

it("remembers the last valid login through an unsupported interim auth value", async () => {
  await login({ test: key("old") });
  await store.reconcileCurrentAccounts();
  await login({ test: { type: "oauth", access: "incomplete" } });
  await store.reconcileCurrentAccounts();
  expect(await store.list("test")).toEqual([{ name: "default", active: false }]);
  await login({});
  await store.reconcileCurrentAccounts();
  expect(await store.list("test")).toEqual([]);
});

it("deletes the account selected immediately before logout, including aliases, and preserves other providers", async () => {
  await login({ test: key("a"), other: key("other") });
  await store.reconcileCurrentAccounts();
  await store.add("test", "work", key("b"));
  await store.add("test", "work-alias", key("b"));
  await store.use("test", "work");
  // No reconciliation between switching and native logout.
  await login({ other: key("other") });
  await store.reconcileCurrentAccounts();
  expect(await store.list("test")).toEqual([{ name: "default", active: false }]);
  expect(await store.list("other")).toEqual([{ name: "default", active: true }]);
});

it("watches atomic replacements, deduplicates its own writes and stops cleanly", async () => {
  const changed = vi.fn();
  const error = vi.fn();
  sync = createAuthSync(store, changed, error);
  await sync.start();
  await writeFile(join(dir, "auth.tmp"), JSON.stringify({ test: key("a") }));
  await rename(join(dir, "auth.tmp"), join(dir, "auth.json"));
  await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
  await sync.reconcile();
  expect(changed).toHaveBeenCalledTimes(1);
  await writeFile(join(dir, "auth.tmp"), "{}");
  await rename(join(dir, "auth.tmp"), join(dir, "auth.json"));
  await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(2));
  expect(await store.list("test")).toEqual([]);
  await sync.stop();
  await login({ test: key("b") });
  await sync.reconcile();
  expect(changed).toHaveBeenCalledTimes(2);
  expect(error).not.toHaveBeenCalled();
});

it("resumes reconciliation after the same synchronizer is stopped and started", async () => {
  const changed = vi.fn();
  sync = createAuthSync(store, changed, vi.fn());
  await login({ test: key("first") });
  await sync.start();
  expect(changed).toHaveBeenCalledTimes(1);
  await sync.stop();
  await login({ test: key("second") });
  await sync.reconcile();
  expect(changed).toHaveBeenCalledTimes(1);
  await sync.start();
  expect(changed).toHaveBeenCalledTimes(2);
  expect((await store.list("test")).find((account) => account.active)?.name).toBe("default-2");
  await writeFile(join(dir, "auth.tmp"), JSON.stringify({ test: key("third") }));
  await rename(join(dir, "auth.tmp"), join(dir, "auth.json"));
  await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(3));
});

it("coalesces bursts into one pass and retains a change requested during a pass", async () => {
  const original = store.reconcileCurrentAccounts.bind(store);
  let entered!: () => void;
  const running = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const spy = vi.spyOn(store, "reconcileCurrentAccounts").mockImplementation(async () => {
    if (++calls === 1) {
      entered();
      await gate;
    }
    return original();
  });
  sync = createAuthSync(store, vi.fn(), vi.fn());
  const firstBurst = Array.from({ length: 50 }, () => sync!.reconcile());
  await running;
  const secondBurst = Array.from({ length: 50 }, () => sync!.reconcile());
  release();
  await Promise.all([...firstBurst, ...secondBurst]);
  expect(spy).toHaveBeenCalledTimes(2);
});

it("reopens a failed file watcher on the next fallback check", async () => {
  vi.useFakeTimers();
  try {
    const watchers = Array.from({ length: 2 }, () => {
      const watcher = new EventEmitter() as EventEmitter & { close: ReturnType<typeof vi.fn> };
      watcher.close = vi.fn();
      return watcher;
    });
    const listeners: Array<(event: string, filename: string | Buffer | null) => void> = [];
    const reconcile = vi.spyOn(store, "reconcileCurrentAccounts");
    const changed = vi.fn();
    let opens = 0;
    sync = createAuthSync(store, changed, vi.fn(), (_directory, listener) => {
      listeners.push(listener);
      return watchers[opens++] as unknown as FSWatcher;
    });
    await sync.start();
    expect(opens).toBe(1);
    watchers[0]!.emit("error", new Error("watcher failed"));
    expect(watchers[0]!.close).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(opens).toBe(2);
    await writeFile(join(dir, "auth.json"), JSON.stringify({ test: key("recovered") }));
    listeners[1]!("rename", "auth.json");
    await vi.advanceTimersByTimeAsync(150);
    expect(reconcile).toHaveBeenCalledTimes(2);
    await sync.reconcile();
    expect(changed).toHaveBeenCalledOnce();
  } finally {
    await sync?.stop();
    sync = undefined;
    vi.useRealTimers();
  }
});

it("reopens a watcher that closes without an error", async () => {
  vi.useFakeTimers();
  try {
    const watchers = Array.from({ length: 2 }, () => {
      const watcher = new EventEmitter() as EventEmitter & { close: ReturnType<typeof vi.fn> };
      watcher.close = vi.fn();
      return watcher;
    });
    const listeners: Array<(event: string, filename: string | Buffer | null) => void> = [];
    const changed = vi.fn();
    let opens = 0;
    sync = createAuthSync(store, changed, vi.fn(), (_directory, listener) => {
      listeners.push(listener);
      return watchers[opens++] as unknown as FSWatcher;
    });
    await sync.start();
    expect(opens).toBe(1);
    watchers[0]!.emit("close");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(opens).toBe(2);
    await writeFile(join(dir, "auth.json"), JSON.stringify({ test: key("new-login") }));
    listeners[1]!("rename", "auth.json");
    await vi.advanceTimersByTimeAsync(150);
    await sync.reconcile();
    expect(changed).toHaveBeenCalledOnce();
    expect(await store.list("test")).toEqual([{ name: "default", active: true }]);
  } finally {
    await sync?.stop();
    sync = undefined;
    vi.useRealTimers();
  }
});

it("ignores unknown watcher noise unless account file metadata changed", async () => {
  try {
    const watcher = new EventEmitter() as EventEmitter & { close: ReturnType<typeof vi.fn> };
    watcher.close = vi.fn();
    let listener!: (event: string, filename: string | Buffer | null) => void;
    const reconcile = vi.spyOn(store, "reconcileCurrentAccounts");
    const changed = vi.fn();
    sync = createAuthSync(store, changed, vi.fn(), (_directory, callback) => {
      listener = callback;
      return watcher as unknown as FSWatcher;
    });
    await sync.start();
    expect(reconcile).toHaveBeenCalledTimes(1);
    listener("change", null);
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(reconcile).toHaveBeenCalledTimes(1);
    await login({ test: key("new-login") });
    listener("change", null);
    await vi.waitFor(() => expect(reconcile).toHaveBeenCalledTimes(2));
    expect(changed).toHaveBeenCalledOnce();
  } finally {
    await sync?.stop();
    sync = undefined;
  }
});

it("preserves corrupt files, reports once and recovers on the next reconciliation", async () => {
  const changed = vi.fn();
  const error = vi.fn();
  sync = createAuthSync(store, changed, error);
  await login({ test: key("a") });
  await sync.start();
  const pool = await readFile(join(dir, "accounts.json"), "utf8");
  await writeFile(join(dir, "auth.json"), "invalid-sensitive-input");
  await sync.reconcile();
  await sync.reconcile();
  expect(error).toHaveBeenCalledTimes(1);
  expect(await readFile(join(dir, "accounts.json"), "utf8")).toBe(pool);
  await login({ test: key("b") });
  await sync.reconcile();
  expect((await store.list("test")).find((a) => a.active)?.name).toBe("default-2");
});

it("keeps reconciling after change and error notification callbacks throw", async () => {
  const changed = vi.fn(() => {
    throw new Error("change UI unavailable");
  });
  const error = vi.fn(() => {
    throw new Error("error UI unavailable");
  });
  sync = createAuthSync(store, changed, error);
  await login({ test: key("a") });
  await expect(sync.reconcile()).resolves.toBeUndefined();
  await login({ test: key("b") });
  await expect(sync.reconcile()).resolves.toBeUndefined();
  expect(changed).toHaveBeenCalledTimes(2);
  expect(error).not.toHaveBeenCalled();
  await writeFile(join(dir, "auth.json"), "invalid-sensitive-input");
  await expect(sync.reconcile()).resolves.toBeUndefined();
  expect(error).toHaveBeenCalledOnce();
  await login({ test: key("c") });
  await expect(sync.reconcile()).resolves.toBeUndefined();
  expect(changed).toHaveBeenCalledTimes(3);
  expect((await store.list("test")).find((account) => account.active)?.name).toBe("default-3");
});

it("skips unchanged fallback passes but still runs a full reconciliation each minute", async () => {
  vi.useFakeTimers();
  try {
    const reconcile = vi.spyOn(store, "reconcileCurrentAccounts");
    sync = createAuthSync(store, vi.fn(), vi.fn());
    await sync.start();
    expect(reconcile).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(55_000);
    expect(reconcile).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.waitFor(() => expect(reconcile).toHaveBeenCalledTimes(2));
  } finally {
    await sync?.stop();
    sync = undefined;
    vi.useRealTimers();
  }
});

it.each([
  ["unchanged files", false, 2],
  ["changed auth file", true, 3],
] as const)(
  "coalesces unknown watcher noise with an in-flight minute reconciliation: %s",
  async (_case, changed, expected) => {
    const watcher = new EventEmitter() as EventEmitter & { close: ReturnType<typeof vi.fn> };
    watcher.close = vi.fn();
    let listener!: (event: string, filename: string | Buffer | null) => void;
    let clock = 0;
    let secondEntered!: () => void;
    const secondStarted = new Promise<void>((resolve) => {
      secondEntered = resolve;
    });
    let releaseSecond!: () => void;
    const secondGate = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    const original = store.reconcileCurrentAccounts.bind(store);
    let calls = 0;
    const reconcile = vi.spyOn(store, "reconcileCurrentAccounts").mockImplementation(async () => {
      if (++calls === 2) {
        secondEntered();
        await secondGate;
      }
      return original();
    });
    try {
      sync = createAuthSync(
        store,
        vi.fn(),
        vi.fn(),
        (_directory, callback) => {
          listener = callback;
          return watcher as unknown as FSWatcher;
        },
        () => clock,
      );
      await sync.start();
      clock = 60_000;
      const running = sync.reconcile();
      await secondStarted;
      if (changed) await login({ test: key("new-login") });
      listener("change", null);
      await new Promise((resolve) => setTimeout(resolve, 250));
      releaseSecond();
      await running;
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(reconcile).toHaveBeenCalledTimes(expected);
    } finally {
      releaseSecond();
      await sync?.stop();
      sync = undefined;
    }
  },
);

it("retries a failed reconciliation on the next fallback even without file changes", async () => {
  vi.useFakeTimers();
  try {
    await writeFile(join(dir, "auth.json"), "invalid-sensitive-input");
    const reconcile = vi.spyOn(store, "reconcileCurrentAccounts");
    const error = vi.fn();
    sync = createAuthSync(store, vi.fn(), error);
    await sync.start();
    expect(reconcile).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.waitFor(() => expect(reconcile).toHaveBeenCalledTimes(2));
    expect(error).toHaveBeenCalledOnce();
  } finally {
    await sync?.stop();
    sync = undefined;
    vi.useRealTimers();
  }
});
