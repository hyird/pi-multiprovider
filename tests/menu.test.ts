import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { accountMenu, loginAccount } from "../src/menu.ts";
import { AccountStore } from "../src/store.ts";

let dir: string;
let store: AccountStore;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pi-accounts-menu-"));
  store = new AccountStore(dir);
  await writeFile(join(dir, "auth.json"), JSON.stringify({ test: { type: "api_key", key: "old-fixture" } }));
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
function context(selections: (string | undefined)[], inputs: (string | undefined)[]) {
  const login = vi.fn(async (interaction) => ({ type: "api_key", key: await interaction.prompt({ type: "secret", message: "API Key" }) }));
  const provider = { id: "test", auth: { apiKey: { login } } };
  const ui = {
    select: vi.fn(async (_title: string, options: string[]) => {
      const next = selections.shift();
      if (next !== undefined) expect(options).toContain(next);
      return next;
    }),
    input: vi.fn(async () => inputs.shift()), notify: vi.fn(), confirm: vi.fn(async () => true),
    onTerminalInput: vi.fn(() => vi.fn()),
  };
  const ctx = { hasUI: true, isIdle: () => true, ui, reload: vi.fn(), modelRegistry: {
    getProvider: () => provider, getAll: () => [{ provider: "test" }], getRegisteredProviderIds: () => [],
    refresh: vi.fn(async () => ({ errors: new Map(), aborted: false })),
  } } as unknown as ExtensionCommandContext;
  const pi = { events: { emit: vi.fn() } } as unknown as ExtensionAPI;
  return { ctx, pi, ui, login, provider };
}
it("adds, labels, and switches accounts entirely inside the menu", async () => {
  await store.save("test", "work");
  const { ctx, pi, login } = context(["Add account / API key", "Edit label", "● personal", "○ work", "Back"], ["personal", "new-fixture", "backup"]);
  await accountMenu(pi, ctx, store, "test");
  expect(login).toHaveBeenCalledOnce();
  expect(await store.list("test")).toEqual([{ name: "work", active: true }, { name: "backup", active: false }]);
  expect(JSON.parse(await readFile(join(dir, "auth.json"), "utf8")).test.key).toBe("old-fixture");
  expect(ctx.reload).not.toHaveBeenCalled();
});
it("allows adding the very first saved account and backs up the current login", async () => {
  const { ctx, pi } = context(["Add account / API key", "Back"], ["new-account", "new-fixture"]);
  await accountMenu(pi, ctx, store, "test");
  const saved = await store.list("test");
  expect(saved).toContainEqual({ name: "new-account", active: true });
  expect(saved.some(a => a.name.startsWith("backup-") && !a.active)).toBe(true);
});
it("cancelled login keeps authentication and the pool unchanged", async () => {
  const { ctx, pi, ui } = context(["Add account / API key", "Back"], ["cancelled-account", undefined]);
  await accountMenu(pi, ctx, store, "test");
  expect(await store.list("test")).toEqual([]);
  expect(JSON.parse(await readFile(join(dir, "auth.json"), "utf8")).test.key).toBe("old-fixture");
  expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining("cancelled"), "error");
});
it("rejects duplicate labels before starting login and preserves credentials on rename", async () => {
  await store.save("test", "work");
  const before = await readFile(join(dir, "auth.json"), "utf8");
  const { ctx, pi, login } = context(["Add account / API key", "Edit label", "● work", "Back"], ["work", "new-label"]);
  await accountMenu(pi, ctx, store, "test");
  expect(login).not.toHaveBeenCalled();
  expect(await readFile(join(dir, "auth.json"), "utf8")).toBe(before);
  expect(await new AccountStore(dir).list("test")).toEqual([{ name: "new-label", active: true }]);
});
it("selects a provider when no current model exists", async () => {
  const { ctx, pi, ui } = context(["test", "Save current login", "Back"], ["current-account"]);
  await accountMenu(pi, ctx, store);
  expect(ui.select).toHaveBeenCalledWith("Accounts · Providers", ["test", "Add provider"]);
  expect(await store.list("test")).toEqual([{ name: "current-account", active: true }]);
});
it("callback cancellation of manual input does not abort a successful OAuth login", async () => {
  const { ctx } = context([], []);
  const manual = new AbortController();
  ctx.ui.input = vi.fn(async () => { manual.abort(); return undefined; });
  const value = { type: "oauth", access: "fixture-access", refresh: "fixture-refresh", expires: 9999999999999 };
  type Interaction = Parameters<NonNullable<Parameters<typeof loginAccount>[1]["auth"]["oauth"]>["login"]>[0];
  const provider = { auth: { oauth: { login: async (interaction: Interaction) => {
    await interaction.prompt({ type: "manual_code", message: "code", signal: manual.signal }).catch(() => {});
    expect(interaction.signal.aborted).toBe(false);
    return value;
  } } } } as unknown as Parameters<typeof loginAccount>[1];
  expect(await loginAccount(ctx, provider)).toEqual(value);
});

it("lists only configured providers at the root and keeps Add provider last", async () => {
  const { ctx, pi, ui } = context([], []);
  ctx.modelRegistry.getAll = vi.fn(() => [{ provider: "unconfigured" }] as ReturnType<typeof ctx.modelRegistry.getAll>);
  await accountMenu(pi, ctx, store);
  expect(ui.select).toHaveBeenCalledExactlyOnceWith("Accounts · Providers", ["test", "Add provider"]);
});

it("adds a new provider from the final root row and returns to the updated provider list", async () => {
  const { ctx, pi, ui } = context(["Add provider", "new-provider", "Back"], ["personal", "new-key"]);
  ctx.modelRegistry.getAll = vi.fn(() => [{ provider: "test" }, { provider: "new-provider" }] as ReturnType<typeof ctx.modelRegistry.getAll>);
  await accountMenu(pi, ctx, store);
  expect(ui.select).toHaveBeenCalledWith("Add provider", ["new-provider"]);
  expect(ui.select).toHaveBeenLastCalledWith("Accounts · Providers", ["new-provider", "test", "Add provider"]);
  expect(await store.list("new-provider")).toEqual([{ name: "personal", active: true }]);
});

it("cancelled provider creation leaves no empty provider entry", async () => {
  const { ctx, pi, ui } = context(["Add provider", "new-provider"], ["personal", undefined]);
  ctx.modelRegistry.getAll = vi.fn(() => [{ provider: "new-provider" }] as ReturnType<typeof ctx.modelRegistry.getAll>);
  await accountMenu(pi, ctx, store);
  expect(ui.select).toHaveBeenLastCalledWith("Accounts · Providers", ["test", "Add provider"]);
  expect(await store.providers()).toEqual(["test"]);
});

it("shows Add provider as the only option on a fresh installation", async () => {
  await writeFile(join(dir, "auth.json"), "{}");
  const { ctx, pi, ui } = context([], []);
  await accountMenu(pi, ctx, store);
  expect(ui.select).toHaveBeenCalledExactlyOnceWith("Accounts · Providers", ["Add provider"]);
});
