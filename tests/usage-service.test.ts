import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { OAuthCredential } from "@earendil-works/pi-ai";
import { AccountStore } from "../src/store.ts";
import { createUsageService } from "../src/usage-service.ts";

let dir: string;
let store: AccountStore;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "pi-service-")); store = new AccountStore(dir); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
it("uses auth.json as current identity and reads inactive keys without changing it", async () => {
  await writeFile(join(dir, "auth.json"), JSON.stringify({ test: { type: "api_key", key: "current-key" } }));
  await store.save("test", "work");
  await store.add("test", "personal", { type: "api_key", key: "other-key" });
  const service = createUsageService(store);
  const ctx = { modelRegistry: {
    getProvider: () => ({ id: "test", auth: { apiKey: { resolve: async ({ credential }: { credential: { key: string } }) => ({ auth: { apiKey: credential.key } }) } } }),
    getProviderAuth: async () => ({ auth: { apiKey: "current-key" } }),
  } } as unknown as ExtensionContext;
  const before = await readFile(join(dir, "auth.json"), "utf8");
  expect(await service.resolveAccountAuth("test/personal", ctx)).toEqual({ accessToken: "other-key", label: "personal" });
  expect(await readFile(join(dir, "auth.json"), "utf8")).toBe(before);
  expect(await service.resolveActiveAccountAuth("test", ctx)).toEqual({ accessToken: "current-key", label: "work" });
  // A native login changes the authoritative account, even without a plugin switch event.
  await writeFile(join(dir, "auth.json"), JSON.stringify({ test: { type: "api_key", key: "other-key" } }));
  expect((await service.getActiveAccount("test", ctx))?.label).toBe("personal");
});
it("refreshes expired inactive OAuth credentials only in the account pool", async () => {
  await writeFile(join(dir, "auth.json"), JSON.stringify({ test: { type: "api_key", key: "current-key" } }));
  await store.add("test", "oauth", { type: "oauth", access: "expired", refresh: "refresh-old", expires: 1 });
  const refresh = vi.fn(async (credential: OAuthCredential) => ({ ...credential, access: "new-access", refresh: "new-refresh", expires: Date.now() + 3600000 }));
  const ctx = { modelRegistry: { getProvider: () => ({ id: "test", auth: { oauth: { refresh, toAuth: async (credential: OAuthCredential) => ({ apiKey: credential.access }) } } }) } } as unknown as ExtensionContext;
  const before = await readFile(join(dir, "auth.json"), "utf8");
  const service = createUsageService(store);
  expect(await service.resolveAccountAuth("test/oauth", ctx)).toEqual({ accessToken: "new-access", label: "oauth" });
  expect(refresh).toHaveBeenCalledOnce();
  expect(await readFile(join(dir, "auth.json"), "utf8")).toBe(before);
  expect(await readFile(join(dir, "accounts.json"), "utf8")).toContain("new-refresh");
});
it("notifies only listeners for the changed provider", () => {
  const service = createUsageService(store);
  const callback = vi.fn();
  const off = service.onActiveAccountChanged("test", callback);
  service.changed("other"); expect(callback).not.toHaveBeenCalled();
  service.changed("test"); expect(callback).toHaveBeenCalledOnce();
  off(); service.changed("test"); expect(callback).toHaveBeenCalledOnce();
});

it("marks an unknown auth.json login as Unmanaged without importing it into the pool", async () => {
  await store.add("test", "saved", { type: "api_key", key: "saved-key" });
  await writeFile(join(dir, "auth.json"), JSON.stringify({ test: { type: "api_key", key: "external-key" } }));
  const pool = await readFile(join(dir, "accounts.json"), "utf8");
  const service = createUsageService(store);
  const ctx = { modelRegistry: { getProviderAuth: async () => ({ auth: { apiKey: "external-key" } }) } } as unknown as ExtensionContext;
  expect(await service.listAccounts()).toEqual([
    { id: "test/saved", providerId: "test", label: "saved", authKind: "api_key", active: false },
    { id: "current:test", providerId: "test", label: "Unmanaged", authKind: "api_key", active: true },
  ]);
  expect(await service.resolveAccountAuth("current:test", ctx)).toEqual({ accessToken: "external-key", label: "Unmanaged" });
  expect(await readFile(join(dir, "accounts.json"), "utf8")).toBe(pool);
});
