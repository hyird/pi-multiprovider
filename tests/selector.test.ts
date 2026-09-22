import { expect, it, vi } from "vitest";
import { AccountSelector, providerChoices } from "../src/selector.ts";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

it("keeps a 100-row list bounded while paging, searching and resizing", () => {
  let height = 24;
  const done = vi.fn();
  const selector = new AccountSelector("Providers", Array.from({ length: 100 }, (_, i) => ({ id: `id-${i}`, label: `Provider ${i}` })), { fg: (_c, text) => text }, () => height, done);
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
  const selector = new AccountSelector("Providers", [{ id: "a", label: "Alpha" }], { fg: (_c, text) => text }, () => 20, done);
  selector.handleInput("missing");
  selector.handleInput("\r");
  expect(done).not.toHaveBeenCalled();
  expect(selector.render(80).join("\n")).toContain("No matches");
  selector.handleInput("\u001b");
  expect(done).toHaveBeenCalledWith(undefined);
});

it("retains distinct provider IDs even when Pi display names match", () => {
  const ctx = { modelRegistry: { getProviderDisplayName: () => "Same name" } } as unknown as ExtensionCommandContext;
  expect(providerChoices(ctx, ["a", "b"])).toEqual([{ id: "a", label: "Same name" }, { id: "b", label: "Same name" }]);
});
