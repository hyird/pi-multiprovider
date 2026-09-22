import { beforeAll, expect, it, vi } from "vitest";
import { initTheme, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { nativeLogin, selectLogin, type LoginSelection } from "../src/native-login.ts";

beforeAll(() => initTheme("dark", false));
type Factory = Parameters<ExtensionCommandContext["ui"]["custom"]>[0];
function context(keys: string[]) {
  const rendered: string[] = [];
  const provider = { id: "test", name: "Test Provider", auth: { apiKey: { name: "API key" } } } as LoginSelection["provider"];
  const ctx = { modelRegistry: { getProvider: () => provider, getProviderAuthStatus: () => ({ configured: false }) }, ui: {
    custom: (factory: Factory) => new Promise(resolve => {
      const component = factory({ requestRender: vi.fn(), terminal: { rows: 24 } } as unknown as Parameters<Factory>[0], {} as Parameters<Factory>[1], {} as Parameters<Factory>[2], resolve);
      if (component instanceof Promise) throw new Error("Expected synchronous component");
      queueMicrotask(() => {
        rendered.push(...component.render(80));
        for (const key of keys) component.handleInput?.(key);
      });
    }),
  } } as unknown as ExtensionCommandContext;
  return { ctx, provider, rendered };
}
it("uses the real Pi login selector and returns the original provider ID", async () => {
  const { ctx, rendered } = context(["\r"]);
  const result = await selectLogin(ctx, ["test"]);
  expect(result?.provider.id).toBe("test");
  expect(result?.authType).toBe("api_key");
  expect(rendered.join("\n")).toContain("Test Provider");
});
it("collects an API key through the real Pi LoginDialogComponent", async () => {
  const { ctx, provider, rendered } = context(["fixture-key", "\r"]);
  expect(await nativeLogin(ctx, { provider, authType: "api_key" })).toEqual({ type: "api_key", key: "fixture-key" });
  expect(rendered.join("\n")).toContain("Login to Test Provider");
});
it("native dialog cancellation returns no credentials", async () => {
  const { ctx, provider } = context(["\u001b"]);
  expect(await nativeLogin(ctx, { provider, authType: "api_key" })).toBeUndefined();
});
