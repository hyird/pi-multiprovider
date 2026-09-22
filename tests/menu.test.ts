import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { runAccountCommand } from "../src/menu.ts";
import { AccountStore } from "../src/store.ts";
import type { Choice } from "../src/selector.ts";

vi.mock("../src/selector.ts", async original => ({
  ...await original<typeof import("../src/selector.ts")>(),
  selectMenu: async (ctx: ExtensionCommandContext, title: string, choices: Choice[] | string[]) => {
    const items = choices.map(c => typeof c === "string" ? { id: c, label: c } : c);
    const selected = await ctx.ui.select(title, items.map(c => c.label));
    return items.find(c => c.label === selected)?.id;
  },
}));
vi.mock("../src/native-login.ts", () => ({
  selectLogin: async (ctx: ExtensionCommandContext, ids: string[]) => {
    const id = await ctx.ui.select("Native provider selector", ids);
    return id ? { provider: ctx.modelRegistry.getProvider(id), authType: "api_key" } : undefined;
  },
  nativeLogin: async (ctx: ExtensionCommandContext) => {
    const key = await ctx.ui.input("Native login");
    return key === undefined ? undefined : { type: "api_key", key };
  },
}));
let dir: string;
let store: AccountStore;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pi-accounts-menu-")); store = new AccountStore(dir);
  await writeFile(join(dir, "auth.json"), JSON.stringify({ test: { type: "api_key", key: "old-fixture" } }));
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
function context(selections: (string | undefined)[], inputs: (string | undefined)[]) {
  const ui = {
    select: vi.fn(async (_title: string, options: string[]) => {
      const next = selections.shift(); if (next !== undefined) expect(options).toContain(next); return next;
    }),
    input: vi.fn(async () => inputs.shift()), notify: vi.fn(), confirm: vi.fn(async () => true),
  };
  const ctx = { hasUI: true, isIdle: () => true, ui, reload: vi.fn(), modelRegistry: {
    getProvider: (id: string) => ({ id, name: id === "test" ? "Test Provider" : "New Provider", auth: { apiKey: {} } }),
    getProviderDisplayName: (id: string) => id === "test" ? "Test Provider" : "New Provider",
    getAll: () => [{ provider: "test" }, { provider: "new-provider" }], getRegisteredProviderIds: () => [],
    refresh: vi.fn(async () => ({ errors: new Map(), aborted: false })),
  } } as unknown as ExtensionCommandContext;
  const pi = { events: { emit: vi.fn() } } as unknown as ExtensionAPI;
  return { ctx, pi, ui };
}
it("uses native login with an extra account selector and exits after success", async () => {
  const { ctx, pi, ui } = context(["test", "Add account"], ["new-key"]);
  await runAccountCommand(pi, ctx, store, "login");
  expect(ui.select).toHaveBeenCalledTimes(2);
  expect(ui.input).toHaveBeenCalledExactlyOnceWith("Native login");
  expect(await store.list("test")).toEqual([{ name: "default", active: false }, { name: "default-2", active: true }]);
});
it("re-login updates a selected account slot instead of silently selecting old credentials", async () => {
  const { ctx, pi } = context(["test", "default"], ["fresh-key"]);
  await runAccountCommand(pi, ctx, store, "login");
  expect(JSON.parse(await readFile(join(dir, "auth.json"), "utf8")).test.key).toBe("fresh-key");
});
it("switches, notifies and exits without opening another menu", async () => {
  await store.ensureCurrent("test"); await store.add("test", "work", { type: "api_key", key: "work-key" });
  const { ctx, pi, ui } = context(["Test Provider", "work"], []);
  await runAccountCommand(pi, ctx, store, "switch");
  expect(ui.select).toHaveBeenCalledTimes(2);
  expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining("Switched permanently"), "info");
  expect(ctx.reload).not.toHaveBeenCalled();
});
it("cancelled native login leaves current credentials unchanged", async () => {
  const before = await readFile(join(dir, "auth.json"), "utf8");
  const { ctx, pi } = context(["test", "Add account"], [undefined]);
  await runAccountCommand(pi, ctx, store, "login");
  expect(await readFile(join(dir, "auth.json"), "utf8")).toBe(before);
});
it("logout removes only the chosen login and keeps other accounts", async () => {
  await store.add("test", "other", { type: "api_key", key: "other-key" });
  const { ctx, pi, ui } = context(["test", "default"], []);
  await runAccountCommand(pi, ctx, store, "logout");
  expect(ui.confirm).toHaveBeenCalledOnce();
  expect(await store.list("test")).toEqual([{ name: "other", active: false }]);
  expect(JSON.parse(await readFile(join(dir, "auth.json"), "utf8"))).toEqual({});
});
it("cancelled logout keeps the current login", async () => {
  const { ctx, pi, ui } = context(["test", "default"], []); ui.confirm.mockResolvedValue(false);
  await runAccountCommand(pi, ctx, store, "logout");
  expect(JSON.parse(await readFile(join(dir, "auth.json"), "utf8")).test.key).toBe("old-fixture");
});
