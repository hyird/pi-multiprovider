import { expect, it, vi } from "vitest";
import { AccountSelector, providerChoices, selectMenu } from "../src/selector.ts";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

it("wraps full account emails without ellipses", () => {
  const email = "deleted.user.0054@gmail.com";
  const selector = new AccountSelector(
    "Accounts",
    [{ id: "slot", label: email, value: "Active" }],
    { fg: (_c, text) => text },
    () => 24,
    vi.fn(),
  );
  const rows = selector.render(20);
  expect(rows.join("").replace(/\s/g, "")).toContain(email);
  expect(rows.join("")).not.toContain("deleted.user.0054@g…");
});

it("keeps a 100-row list bounded while paging, searching and resizing", () => {
  let height = 24;
  const done = vi.fn();
  const selector = new AccountSelector(
    "Providers",
    Array.from({ length: 100 }, (_, i) => ({ id: `id-${i}`, label: `Provider ${i}` })),
    { fg: (_c, text) => text },
    () => height,
    done,
  );
  expect(selector.render(80).length).toBeLessThan(height);
  selector.handleInput("\u001b[F");
  expect(selector.render(80).join("\n")).toContain("→ Provider 99");
  height = 10;
  expect(selector.render(40).length).toBeLessThanOrEqual(7);
  expect(selector.render(40).join("\n")).toContain("→ Provider 99");
  selector.handleInput("\u001b[5~");
  expect(selector.render(40).join("\n")).toContain("→ Provider 95");
  selector.handleInput("id-42");
  expect(selector.render(40).join("\n")).toContain("→ Provider 42");
  selector.handleInput("\r");
  expect(done).toHaveBeenCalledWith("id-42");
});

it("does not select anything for empty search results and supports cancellation", () => {
  const done = vi.fn();
  const selector = new AccountSelector(
    "Providers",
    [{ id: "a", label: "Alpha" }],
    { fg: (_c, text) => text },
    () => 20,
    done,
  );
  selector.handleInput("missing");
  selector.handleInput("\r");
  expect(done).not.toHaveBeenCalled();
  expect(selector.render(80).join("\n")).toContain("No matches");
  selector.handleInput("\u001b");
  expect(done).toHaveBeenCalledWith(undefined);
});

it("retains distinct provider IDs even when Pi display names match", () => {
  const ctx = {
    modelRegistry: { getProviderDisplayName: () => "Same name" },
  } as unknown as ExtensionCommandContext;
  expect(providerChoices(ctx, ["a", "b"])).toEqual([
    { id: "a", label: "Same name" },
    { id: "b", label: "Same name" },
  ]);
});

it("Ctrl+E edits the highlighted account while Enter still switches", () => {
  const done = vi.fn();
  const selector = new AccountSelector(
    "Accounts",
    [
      { id: "account:work", label: "work", editId: "label:work" },
      { id: "account:personal", label: "personal", editId: "label:personal" },
    ],
    { fg: (_c, text) => text },
    () => 20,
    done,
  );
  selector.handleInput("\u001b[B");
  expect(selector.render(80).join("\n")).toContain("Ctrl+E rename");
  selector.handleInput("\u0005");
  expect(done).toHaveBeenLastCalledWith("label:personal");
  selector.handleInput("\r");
  expect(done).toHaveBeenLastCalledWith("account:personal");
});

it("RPC selection keeps matching display names distinct without using terminal components", async () => {
  const custom = vi.fn();
  const select = vi.fn(async (_title: string, options: string[]) => {
    expect(new Set(options).size).toBe(2);
    expect(options.every((option) => option.includes("same@example.com"))).toBe(true);
    return options[1];
  });
  const selected = await selectMenu({
    mode: "rpc", hasUI: true, ui: { custom, select },
  } as unknown as ExtensionCommandContext, "Accounts", [
    { id: "account:work", label: "same@example.com", value: "Saved" },
    { id: "account:personal", label: "same@example.com", value: "Saved" },
  ]);
  expect(selected).toBe("account:personal");
  expect(custom).not.toHaveBeenCalled();
});

it("RPC offers native label editing only for accounts with an editable label", async () => {
  const select = vi.fn(async (_title: string, options: string[]) => {
    expect(options.filter((option) => option.includes("Edit label:"))).toHaveLength(1);
    return options.find((option) => option.includes("Edit label: work"));
  });
  const selected = await selectMenu({
    mode: "rpc", hasUI: true, ui: { select, custom: vi.fn() },
  } as unknown as ExtensionCommandContext, "Accounts", [
    { id: "account:work", label: "work", editId: "label:work" },
    { id: "account:personal", label: "personal@example.com" },
  ]);
  expect(selected).toBe("label:work");
});

it("RPC cancellation returns no account selection", async () => {
  const selected = await selectMenu({
    mode: "rpc", hasUI: true, ui: { select: vi.fn(async () => undefined), custom: vi.fn() },
  } as unknown as ExtensionCommandContext, "Accounts", ["work"]);
  expect(selected).toBeUndefined();
});

it("a session without UI never opens an account dialog", async () => {
  const ui = { select: vi.fn(), custom: vi.fn() };
  const selected = await selectMenu({
    mode: "print", hasUI: false, ui,
  } as unknown as ExtensionCommandContext, "Accounts", ["work"]);
  expect(selected).toBeUndefined();
  expect(ui.select).not.toHaveBeenCalled();
  expect(ui.custom).not.toHaveBeenCalled();
});

it("TUI selection keeps using the terminal account selector", async () => {
  const ui = { select: vi.fn(), custom: vi.fn(async () => "work") };
  expect(await selectMenu({
    mode: "tui", hasUI: true, ui,
  } as unknown as ExtensionCommandContext, "Accounts", ["work"])).toBe("work");
  expect(ui.custom).toHaveBeenCalledOnce();
  expect(ui.select).not.toHaveBeenCalled();
});
