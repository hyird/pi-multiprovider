import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { accountMenu, loginAccount } from "../src/menu.ts";
import { AccountStore } from "../src/store.ts";
import type { Choice } from "../src/selector.ts";

vi.mock("../src/selector.ts", async importOriginal => ({
  ...await importOriginal<typeof import("../src/selector.ts")>(),
  selectMenu: async (ctx: ExtensionCommandContext, title: string, choices: Choice[] | string[]) => {
    const items = choices.map(c => typeof c === "string" ? { id: c, label: c } : c);
    const selected = await ctx.ui.select(title, items.map(c => c.label));
    return items.find(c => c.label === selected)?.id;
  },
}));
let dir: string;
let store: AccountStore;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pi-accounts-menu-"));
  store = new AccountStore(dir);
  await writeFile(join(dir, "auth.json"), JSON.stringify({ test: { type: "api_key", key: "old-fixture" } }));
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
function context(selections: (string | undefined)[], inputs: (string | undefined)[]) {
  const login = vi.fn(async interaction => ({ type: "api_key", key: await interaction.prompt({ type: "secret", message: "API key" }) }));
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
    getProvider: () => ({ auth: { apiKey: { login } } }),
    getProviderDisplayName: (id: string) => id === "test" ? "Test Provider" : "New Provider",
    getAll: () => [{ provider: "test" }, { provider: "new-provider" }], getRegisteredProviderIds: () => [],
    refresh: vi.fn(async () => ({ errors: new Map(), aborted: false })),
  } } as unknown as ExtensionCommandContext;
  const pi = { events: { emit: vi.fn() } } as unknown as ExtensionAPI;
  return { ctx, pi, ui, login };
}
it("shows Pi display names and keeps removal and addition at the root bottom", async () => {
  const { ctx, pi, ui } = context([], []);
  await accountMenu(pi, ctx, store);
  expect(ui.select).toHaveBeenCalledExactlyOnceWith("Accounts · Providers", ["Test Provider", "Add provider", "Remove provider"]);
});
it("offers exactly Label, Switch, Back and edits the default label directly", async () => {
  const before = await readFile(join(dir, "auth.json"), "utf8");
  const { ctx, pi, ui } = context(["Test Provider", "Label    default", "Back"], ["work"]);
  await accountMenu(pi, ctx, store);
  expect(ui.select).toHaveBeenCalledWith("Test Provider", ["Label    default", "Switch   default", "Back"]);
  expect(ui.select).toHaveBeenCalledWith("Test Provider", ["Label    work", "Switch   work", "Back"]);
  expect(ui.input).toHaveBeenCalledWith("Label", "default");
  expect(await readFile(join(dir, "auth.json"), "utf8")).toBe(before);
});
it("adds another key through the root then switches through the provider Switch row", async () => {
  await store.save("test", "work");
  const { ctx, pi } = context(["Add provider", "Test Provider", "Switch   personal", "○ work", "Back"], ["personal", "new-fixture"]);
  await accountMenu(pi, ctx, store);
  expect(await store.list("test")).toEqual([{ name: "work", active: true }, { name: "personal", active: false }]);
  expect(ctx.reload).not.toHaveBeenCalled();
});
it("adds a new provider by its display name and stores its actual ID", async () => {
  const { ctx, pi, ui } = context(["Add provider", "New Provider", "Back"], ["personal", "new-key"]);
  await accountMenu(pi, ctx, store);
  expect(ui.select).toHaveBeenLastCalledWith("Accounts · Providers", ["New Provider", "Test Provider", "Add provider", "Remove provider"]);
  expect(await store.list("new-provider")).toEqual([{ name: "personal", active: true }]);
});
it("cancelled login creates no provider and does not change current credentials", async () => {
  const before = await readFile(join(dir, "auth.json"), "utf8");
  const { ctx, pi } = context(["Add provider", "New Provider"], ["personal", undefined]);
  await accountMenu(pi, ctx, store);
  expect(await store.providers()).toEqual(["test"]);
  expect(await readFile(join(dir, "auth.json"), "utf8")).toBe(before);
});
it("removes a provider only after confirmation and preserves other providers", async () => {
  await store.add("other", "key", { type: "api_key", key: "fixture-other" });
  await store.ensureCurrent("test");
  const { ctx, pi, ui } = context(["Remove provider", "Test Provider"], []);
  await accountMenu(pi, ctx, store);
  expect(ui.confirm).toHaveBeenCalledOnce();
  expect(await store.providers()).toEqual(["other"]);
  expect(JSON.parse(await readFile(join(dir, "auth.json"), "utf8"))).toEqual({});
});
it("cancelled removal leaves credentials intact", async () => {
  const { ctx, pi, ui } = context(["Remove provider", "Test Provider"], []);
  ui.confirm.mockResolvedValue(false);
  await accountMenu(pi, ctx, store);
  expect(await store.providers()).toEqual(["test"]);
});
it("callback cancellation of manual input does not abort successful OAuth login", async () => {
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
