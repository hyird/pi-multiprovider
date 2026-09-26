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
    const items: Choice[] = choices.map(c => typeof c === "string" ? { id: c, label: c } : c);
    const selected = await ctx.ui.select(title, items.flatMap(c => c.editId ? [c.label, `Ctrl+E ${c.label}`] : [c.label]));
    const edited = items.find(c => selected === `Ctrl+E ${c.label}`);
    if (edited) return edited.editId;
    return items.find(c => c.label === selected)?.id;
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


it("switches, notifies and exits without opening another menu", async () => {
  await store.ensureCurrent("test"); await store.add("test", "work", { type: "api_key", key: "work-key" });
  const { ctx, pi, ui } = context(["Test Provider", "work"], []);
  await runAccountCommand(pi, ctx, store);
  expect(ui.select).toHaveBeenCalledTimes(2);
  expect(ui.select.mock.calls[1]?.[1]).not.toContain("Remove saved account…");
  expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining("Switched permanently"), "info");
  expect(ctx.reload).not.toHaveBeenCalled();
});




it("edits a label without switching or changing Pi credentials", async () => {
  await store.ensureCurrent("test");
  await store.add("test", "spare", { type: "api_key", key: "spare-key" });
  const before = await readFile(join(dir, "auth.json"), "utf8");
  const { ctx, pi, ui } = context(["Test Provider", "Ctrl+E spare"], ["personal"]);
  await runAccountCommand(pi, ctx, store);
  expect(await new AccountStore(dir).list("test")).toEqual([{ name: "default", active: true }, { name: "personal", active: false }]);
  expect(await readFile(join(dir, "auth.json"), "utf8")).toBe(before);
  expect(ctx.modelRegistry.refresh).not.toHaveBeenCalled();
  expect(ui.select).toHaveBeenCalledTimes(3);
  expect(ui.select.mock.calls[2]?.[1]).toContain("personal");
  expect(ui.notify).toHaveBeenCalledWith("Label updated: personal.", "info");
});

it("cancelling label input leaves the label unchanged", async () => {
  const { ctx, pi, ui } = context(["Test Provider", "Ctrl+E default"], [undefined]);
  await runAccountCommand(pi, ctx, store);
  expect(await store.list("test")).toEqual([{ name: "default", active: true }]);
  expect(ui.select).toHaveBeenCalledTimes(3);
});

it("shows OAuth email instead of the slot label and offers editing only without email", async () => {
  const email = "long.account.name.for.switching@example.com";
  const access = `x.${Buffer.from(JSON.stringify({ email })).toString("base64url")}.y`;
  await store.add("test", "email-slot", { type: "oauth", access, refresh: "fixture", expires: 1 });
  await store.add("test", "custom", { type: "api_key", key: "custom-key" });
  const { ctx, pi, ui } = context(["Test Provider", email], []);
  await runAccountCommand(pi, ctx, store);
  expect(ui.select.mock.calls[1]?.[1]).toContain(email);
  expect(ui.select.mock.calls[1]?.[1]).not.toContain("email-slot");
  expect(ui.select.mock.calls[1]?.[1]).not.toContain(`Ctrl+E ${email}`);
  expect(ui.select.mock.calls[1]?.[1]).toContain("Ctrl+E custom");
  expect((await store.list("test")).find(a => a.active)?.name).toBe("email-slot");
  expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining(email), "info");
});
