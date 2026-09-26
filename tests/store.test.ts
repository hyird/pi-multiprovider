import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountStore } from "../src/store.ts";

let dir: string;
let store: AccountStore;
const a = { type: "api_key", key: "fixture-a" };
const b = { type: "api_key", key: "fixture-b" };
const token = (sub: string, version: number) => `header.${Buffer.from(JSON.stringify({ sub, version })).toString("base64url")}.signature`;
const oauth = (sub: string, version: number) => ({ type: "oauth", access: token(sub, version), refresh: `refresh-${sub}-${version}`, expires: 1000 + version, accountId: "org" });
async function login(value: unknown) { await writeFile(join(dir, "auth.json"), JSON.stringify({ provider: value, other: a })); }
async function auth() { return JSON.parse(await readFile(join(dir, "auth.json"), "utf8")); }
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "pi-accounts-test-")); store = new AccountStore(dir); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
describe("persistent account storage", () => {
  it("persists response emails and ignores stale or invalid metadata", async () => {
    await login(a); await store.save("provider", "work");
    await store.updateEmail("provider", "work", "work@example.com", a.key);
    expect(await new AccountStore(dir).list("provider")).toEqual([{ name: "work", active: true, email: "work@example.com" }]);
    await store.updateEmail("provider", "work", "wrong@example.com", b.key);
    await store.updateEmail("provider", "work", "bad\u001b@example.com", a.key);
    expect((await store.list("provider"))[0]?.email).toBe("work@example.com");
    await store.saveLogin("provider", "work", b);
    expect((await store.list("provider")).find(a => a.name === "work")?.email).toBeUndefined();
    await store.updateEmail("provider", "work", "stale@example.com", a.key);
    expect((await store.list("provider")).find(a => a.name === "work")?.email).toBeUndefined();
  });
  it("persists across fresh instances and preserves other providers", async () => {
    await login(a); await store.save("provider", "work");
    await login(b); await store.save("provider", "personal");
    await store.use("provider", "work");
    expect(await auth()).toEqual({ provider: a, other: a });
    expect(await new AccountStore(dir).list("provider")).toEqual([{ name: "work", active: true }, { name: "personal", active: false }]);
  });
  it("reports the current authentication kind without exposing credentials", async () => {
    await login(oauth("alice", 1));
    expect(await store.currentAuthKinds()).toEqual({ provider: "oauth", other: "api_key" });
  });
  it("backs up an unsaved login before switching", async () => {
    await login(a); await store.save("provider", "work"); await login(b);
    await store.use("provider", "work");
    const backup = (await store.list("provider")).find(x => x.name.startsWith("backup-"));
    expect(backup).toBeDefined();
    await store.use("provider", backup!.name);
    expect((await auth()).provider).toEqual(b);
  });
  it("keeps rotated OAuth tokens and separates users in the same organization", async () => {
    await login(oauth("alice", 1)); await store.save("provider", "alice");
    await login(oauth("bob", 1)); await store.save("provider", "bob");
    await store.use("provider", "alice");
    await login(oauth("alice", 2));
    await store.use("provider", "bob"); await store.use("provider", "alice");
    expect((await auth()).provider).toEqual(oauth("alice", 2));
  });
  it("never reverts refreshed tokens when choosing the active account", async () => {
    await login(oauth("alice", 1)); await store.save("provider", "alice");
    await login(oauth("alice", 2)); await store.use("provider", "alice");
    expect((await auth()).provider.refresh).toBe("refresh-alice-2");
  });
  it("refuses to overwrite a name owned by another login", async () => {
    await login(a); await store.save("provider", "work"); await login(b);
    await expect(store.save("provider", "work")).rejects.toThrow("another account");
    expect((await auth()).provider).toEqual(b);
  });
  it("does not overwrite corrupt storage or expose its contents", async () => {
    await login(a); await store.save("provider", "work");
    await writeFile(join(dir, "accounts.json"), "secret-invalid-json");
    await expect(store.use("provider", "work")).rejects.toThrow("JSON is invalid");
    expect((await auth()).provider).toEqual(a);
    expect(await readFile(join(dir, "accounts.json"), "utf8")).toBe("secret-invalid-json");
  });
  it("serializes concurrent saves without losing entries", async () => {
    await login(a);
    await Promise.all(Array.from({ length: 5 }, (_, i) => new AccountStore(dir).save("provider", `alias-${i}`)));
    expect(await store.list("provider")).toHaveLength(5);
  });
  it("removes inactive records without logging out the active provider", async () => {
    await login(a); await store.save("provider", "work");
    await expect(store.remove("provider", "work")).rejects.toThrow("Switch to another");
    await login(b); await store.remove("provider", "work");
    expect((await auth()).provider).toEqual(b);
  });
  it("fails safely for missing accounts and missing persisted credentials", async () => {
    await expect(store.save("provider", "work")).rejects.toThrow("No stored");
    await login(a);
    await expect(store.use("provider", "missing")).rejects.toThrow("not found");
    expect((await auth()).provider).toEqual(a);
  });
  it("never executes configured API key commands", async () => {
    const configured = { type: "api_key", key: "!do-not-execute", env: { EXAMPLE: "fixture" } };
    await login(configured); await store.save("provider", "command"); await login(b);
    await store.use("provider", "command");
    expect((await auth()).provider).toEqual(configured);
  });
});
