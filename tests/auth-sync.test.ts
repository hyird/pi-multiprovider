import { mkdtemp, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
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
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "pi-auth-sync-")); store = new AccountStore(dir); });
afterEach(async () => { await sync?.stop(); sync = undefined; await rm(dir, { recursive: true, force: true }); });

it("imports new logins, retains names and removes only the logged-out account", async () => {
  await login({ test: key("a") });
  expect(await store.reconcileCurrentAccounts()).toEqual({ changed: ["test"], added: [{ provider: "test", name: "default" }] });
  await store.rename("test", "default", "work");
  await login({ test: key("b") });
  await store.reconcileCurrentAccounts();
  await login({ test: key("c") });
  expect((await store.reconcileCurrentAccounts()).added).toEqual([{ provider: "test", name: "default-2" }]);
  await login({ test: key("a") });
  expect((await store.reconcileCurrentAccounts()).added).toEqual([]);
  expect((await store.list("test")).find(a => a.active)?.name).toBe("work");
  await login({});
  expect((await store.reconcileCurrentAccounts()).changed).toEqual(["test"]);
  expect(await store.list("test")).toHaveLength(2);
  expect((await store.list("test")).some(a => a.name === "work")).toBe(false);
  expect((await store.list("test")).some(a => a.active)).toBe(false);
  expect(JSON.parse(await readFile(join(dir, "auth.json"), "utf8"))).toEqual({});
  expect((await store.reconcileCurrentAccounts()).changed).toEqual([]);
});

it("updates recognizable OAuth tokens without overwriting ambiguous identities", async () => {
  const oauth = (version: number) => ({ type: "oauth", access: `x.${Buffer.from(JSON.stringify({ sub: "alice", version })).toString("base64url")}.y`, refresh: `r${version}`, expires: version });
  await login({ test: oauth(1) });
  await store.save("test", "work");
  await store.reconcileCurrentAccounts();
  await login({ test: oauth(2) });
  expect(await store.reconcileCurrentAccounts()).toEqual({ changed: ["test"], added: [] });
  expect(JSON.parse(await readFile(join(dir, "accounts.json"), "utf8")).accounts[0].credential).toEqual(oauth(2));
  await login({ test: { ...oauth(3), access: "opaque" } });
  expect((await store.reconcileCurrentAccounts()).added).toEqual([{ provider: "test", name: "default" }]);
  expect(await store.list("test")).toEqual([{ name: "work", active: false }, { name: "default", active: true }]);
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
  expect((await store.list("test")).find(a => a.active)?.name).toBe("default-2");
});
