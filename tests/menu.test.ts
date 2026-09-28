import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { runAccountCommand } from "../src/menu.ts";
import { AccountStore } from "../src/store.ts";
import type { Choice } from "../src/selector.ts";

vi.mock("../src/selector.ts", async (original) => ({
  ...(await original<typeof import("../src/selector.ts")>()),
  selectMenu: async (ctx: ExtensionCommandContext, title: string, choices: Choice[] | string[]) => {
    const items: Choice[] = choices.map((c) => (typeof c === "string" ? { id: c, label: c } : c));
    const selected = await ctx.ui.select(
      title,
      items.flatMap((c) => (c.editId ? [c.label, `Ctrl+E ${c.label}`] : [c.label])),
    );
    const edited = items.find((c) => selected === `Ctrl+E ${c.label}`);
    if (edited) return edited.editId;
    return items.find((c) => c.label === selected)?.id;
  },
}));
let dir: string;
let store: AccountStore;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pi-accounts-menu-"));
  store = new AccountStore(dir);
  await writeFile(
    join(dir, "auth.json"),
    JSON.stringify({ test: { type: "api_key", key: "old-fixture" } }),
  );
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});
function context(selections: (string | undefined)[], inputs: (string | undefined)[]) {
  const ui = {
    select: vi.fn(async (_title: string, options: string[]) => {
      const next = selections.shift();
      if (next !== undefined) expect(options).toContain(next);
      return next;
    }),
    input: vi.fn(async () => inputs.shift()),
    notify: vi.fn(),
    confirm: vi.fn(async () => true),
  };
  const ctx = {
    hasUI: true,
    isIdle: () => true,
    ui,
    reload: vi.fn(),
    modelRegistry: {
      getProvider: (id: string) => ({
        id,
        name: id === "test" ? "Test Provider" : "New Provider",
        auth: { apiKey: {} },
      }),
      getProviderDisplayName: (id: string) => (id === "test" ? "Test Provider" : "New Provider"),
      getAll: () => [{ provider: "test" }, { provider: "new-provider" }],
      getRegisteredProviderIds: () => [],
      refresh: vi.fn(async () => ({ errors: new Map(), aborted: false })),
    },
  } as unknown as ExtensionCommandContext;
  const pi = { events: { emit: vi.fn() } } as unknown as ExtensionAPI;
  return { ctx, pi, ui };
}

it("switches, notifies and exits without opening another menu", async () => {
  await store.ensureCurrent("test");
  await store.add("test", "work", { type: "api_key", key: "work-key" });
  const { ctx, pi, ui } = context(["Test Provider", "work"], []);
  await runAccountCommand(pi, ctx, store);
  expect(ui.select).toHaveBeenCalledTimes(2);
  expect(ui.select.mock.calls[1]?.[1]).not.toContain("Remove saved account…");
  expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining("Switched permanently"), "info");
  expect(ctx.reload).not.toHaveBeenCalled();
});

it("notifies account consumers after a committed switch even when registry refresh fails", async () => {
  await store.ensureCurrent("test");
  await store.add("test", "work", { type: "api_key", key: "work-key" });
  const { ctx, pi, ui } = context(["Test Provider", "work"], []);
  let refreshFinished = false;
  vi.mocked(ctx.modelRegistry.refresh).mockImplementation(async () => {
    expect((await store.list("test")).find((account) => account.active)?.name).toBe("work");
    expect(pi.events.emit).not.toHaveBeenCalled();
    refreshFinished = true;
    return { errors: new Map([["test", new Error("unavailable")]]), aborted: false } as any;
  });
  vi.mocked(pi.events.emit).mockImplementation(() => {
    expect(refreshFinished).toBe(true);
  });
  await runAccountCommand(pi, ctx, store);
  expect(ctx.modelRegistry.refresh).toHaveBeenCalledOnce();
  expect(pi.events.emit).toHaveBeenCalledWith("pi-accounts:changed", {
    provider: "test",
    name: "work",
    forceNotify: true,
    storageChanged: true,
  });
  expect(ui.notify).toHaveBeenCalledWith(
    "Account selection was saved, but runtime refresh failed. Retry the switch before continuing.",
    "warning",
  );
});

it("marks a repeated switch for an explicit usage refresh", async () => {
  await store.ensureCurrent("test");
  const { ctx, pi } = context(["Test Provider", "default"], []);
  await runAccountCommand(pi, ctx, store);
  expect(pi.events.emit).toHaveBeenCalledWith("pi-accounts:changed", {
    provider: "test",
    name: "default",
    forceNotify: true,
  });
});

it("marks a preferred-label switch as metadata for usage consumers", async () => {
  await store.ensureCurrent("test");
  await store.save("test", "alias");
  const { ctx, pi } = context(["Test Provider", "alias"], []);
  await runAccountCommand(pi, ctx, store);
  expect(pi.events.emit).toHaveBeenCalledWith("pi-accounts:changed", {
    provider: "test",
    name: "alias",
    forceNotify: true,
    kind: "metadata",
    storageChanged: true,
  });
});

it("lists saved providers in the switch menu", async () => {
  await store.ensureCurrent("test");
  await store.add("new-provider", "spare", { type: "api_key", key: "spare-key" });
  const { ctx, pi, ui } = context([undefined], []);
  await runAccountCommand(pi, ctx, store);
  expect(ui.select.mock.calls[0]?.[1]).toEqual(["New Provider", "Test Provider"]);
});

it("edits a label without switching or changing Pi credentials", async () => {
  await store.ensureCurrent("test");
  await store.add("test", "spare", { type: "api_key", key: "spare-key" });
  const before = await readFile(join(dir, "auth.json"), "utf8");
  const { ctx, pi, ui } = context(["Test Provider", "Ctrl+E spare"], ["personal"]);
  await runAccountCommand(pi, ctx, store);
  expect(await new AccountStore(dir).list("test")).toEqual([
    { name: "default", active: true },
    { name: "personal", active: false },
  ]);
  expect(await readFile(join(dir, "auth.json"), "utf8")).toBe(before);
  expect(ctx.modelRegistry.refresh).not.toHaveBeenCalled();
  expect(ui.select).toHaveBeenCalledTimes(3);
  expect(ui.select.mock.calls[2]?.[1]).toContain("personal");
  expect(ui.notify).toHaveBeenCalledWith("Label updated: personal.", "info");
  expect(pi.events.emit).toHaveBeenCalledWith("pi-accounts:changed", {
    provider: "test",
    name: "personal",
    kind: "metadata",
    storageChanged: true,
  });
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
  const list = vi
    .spyOn(store, "list")
    .mockImplementationOnce(AccountStore.prototype.list.bind(store));
  list.mockRejectedValue(new Error("Storage became unavailable after the committed switch"));
  const { ctx, pi, ui } = context(["Test Provider", email], []);
  await runAccountCommand(pi, ctx, store);
  expect(ui.select.mock.calls[1]?.[1]).toContain(email);
  expect(ui.select.mock.calls[1]?.[1]).not.toContain("email-slot");
  expect(ui.select.mock.calls[1]?.[1]).not.toContain(`Ctrl+E ${email}`);
  expect(ui.select.mock.calls[1]?.[1]).toContain("Ctrl+E custom");
  expect((await new AccountStore(dir).list("test")).find((a) => a.active)?.name).toBe("email-slot");
  expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining(email), "info");
  expect(list).toHaveBeenCalledOnce();
});
