import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountStore, credentialRevision, sameAccount } from "../src/store.ts";

let dir: string;
let store: AccountStore;
const a = { type: "api_key", key: "fixture-a" };
const b = { type: "api_key", key: "fixture-b" };
const token = (sub: string, version: number) =>
  `header.${Buffer.from(JSON.stringify({ sub, version })).toString("base64url")}.signature`;
const oauth = (sub: string, version: number) => ({
  type: "oauth" as const,
  access: token(sub, version),
  refresh: `refresh-${sub}-${version}`,
  expires: 1000 + version,
  accountId: "org",
});
async function login(value: unknown) {
  await writeFile(join(dir, "auth.json"), JSON.stringify({ provider: value, other: a }));
}
async function auth() {
  return JSON.parse(await readFile(join(dir, "auth.json"), "utf8"));
}
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pi-accounts-test-"));
  store = new AccountStore(dir);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});
describe("persistent account storage", () => {
  it("rejects malformed Unicode labels before they can break account IDs", async () => {
    await expect(store.add("provider", "\ud800", a)).rejects.toThrow("Labels must contain");
    await expect(store.listAccounts()).resolves.toEqual([]);
    await writeFile(
      join(dir, "accounts.json"),
      JSON.stringify({
        version: 1,
        accounts: [{ provider: "provider", name: "\ud800", credential: a }],
      }),
    );
    await expect(store.listAccounts()).rejects.toThrow("Invalid account storage format");
  });
  it("rejects invisible and direction-control labels without blocking readable Unicode", async () => {
    for (const label of ["\u200b", "\u00ad", "wo\u200brk", "work\u2060", "\u202eHidden", "\u0085"])
      await expect(store.add("provider", label, a)).rejects.toThrow("Labels must contain");
    await expect(store.add("provider", "工作 👩‍💻", a)).resolves.toBeUndefined();
    expect((await store.list("provider"))[0]?.name).toBe("工作 👩‍💻");
  });
  it("persists response emails and ignores stale or invalid metadata", async () => {
    await login(a);
    await store.save("provider", "work");
    await store.updateEmail("provider", "work", "work@example.com", a.key);
    expect(await new AccountStore(dir).list("provider")).toEqual([
      { name: "work", active: true, email: "work@example.com" },
    ]);
    await store.updateEmail("provider", "work", "wrong@example.com", b.key);
    await store.updateEmail("provider", "work", "bad\u001b@example.com", a.key);
    expect((await store.list("provider"))[0]?.email).toBe("work@example.com");
    await store.saveLogin("provider", "work", b);
    expect((await store.list("provider")).find((a) => a.name === "work")?.email).toBeUndefined();
    await store.updateEmail("provider", "work", "stale@example.com", a.key);
    expect((await store.list("provider")).find((a) => a.name === "work")?.email).toBeUndefined();
  });
  it("accepts a refreshed active OAuth token before the account pool catches up", async () => {
    const old = oauth("alice", 1);
    const refreshed = oauth("alice", 2);
    await login(old);
    await store.save("provider", "work");
    await login(refreshed);
    await store.updateEmail("provider", "work", "alice@example.com", refreshed.access);
    expect((await store.list("provider"))[0]?.email).toBe("alice@example.com");
    expect((await auth()).provider).toEqual(refreshed);

    await login(oauth("bob", 1));
    await store.updateEmail("provider", "work", "bob@example.com", oauth("bob", 1).access);
    expect((await store.list("provider"))[0]?.email).toBe("alice@example.com");
  });
  it("rejects a resolved email callback after an account ID changes with the same access token", async () => {
    const original = {
      type: "oauth" as const,
      access: "shared-access",
      refresh: "refresh-a",
      expires: 1,
      accountId: "org-a",
    };
    await login(original);
    await store.save("provider", "work");
    const revision = credentialRevision(original);
    await store.updateEmail("provider", "work", "old@example.com", original.access, revision);
    expect((await store.list("provider"))[0]?.email).toBe("old@example.com");
    await store.saveLogin("provider", "work", {
      ...original,
      refresh: "refresh-b",
      accountId: "org-b",
    });
    await store.updateEmail("provider", "work", "stale@example.com", original.access, revision);
    expect((await store.list("provider"))[0]?.email).toBeUndefined();
  });
  it("persists across fresh instances and preserves other providers", async () => {
    await login(a);
    await store.save("provider", "work");
    await login(b);
    await store.save("provider", "personal");
    await store.use("provider", "work");
    expect(await auth()).toEqual({ provider: a, other: a });
    expect(await new AccountStore(dir).list("provider")).toEqual([
      { name: "work", active: true },
      { name: "personal", active: false },
    ]);
  });
  it("does not rewrite credential files when selecting the unchanged account", async () => {
    await login(a);
    await store.save("provider", "work");
    const files = [join(dir, "auth.json"), join(dir, "accounts.json")];
    const revisions = async () =>
      Promise.all(
        files.map(async (file) => {
          const info = await stat(file, { bigint: true });
          return [info.ino, info.mtimeNs, info.ctimeNs];
        }),
      );
    const before = await revisions();
    expect(await store.use("provider", "work")).toEqual({ credentialChanged: false });
    expect(await revisions()).toEqual(before);
  });
  it("persists the chosen label when saved aliases share one credential", async () => {
    await login(a);
    await store.save("provider", "first");
    await store.save("provider", "alias");
    const beforeAuth = await readFile(join(dir, "auth.json"), "utf8");
    expect((await store.usageAccount("provider"))?.name).toBe("first");

    expect(await store.use("provider", "alias")).toEqual({
      credentialChanged: false,
      preferredLabelChanged: true,
    });
    const restarted = new AccountStore(dir);
    expect((await restarted.usageAccount("provider"))?.name).toBe("alias");
    expect(
      (await restarted.menuSnapshot()).accounts.filter(
        (account) => account.provider === "provider",
      )[0]?.name,
    ).toBe("alias");
    expect(await readFile(join(dir, "auth.json"), "utf8")).toBe(beforeAuth);

    await restarted.use("provider", "first");
    expect((await new AccountStore(dir).usageAccount("provider"))?.name).toBe("first");
  });
  it("shows the chosen inactive alias after switching to its credential", async () => {
    await login(a);
    await store.save("provider", "work");
    await store.add("provider", "personal", b);
    await store.add("provider", "personal-alias", b);

    expect(await store.use("provider", "personal-alias")).toEqual({
      credentialChanged: true,
      preferredLabelChanged: true,
    });
    expect((await auth()).provider).toEqual(b);
    expect((await new AccountStore(dir).usageAccount("provider"))?.name).toBe("personal-alias");
  });
  it("reports the current authentication kind without exposing credentials", async () => {
    await login(oauth("alice", 1));
    expect(await store.currentAuthKinds()).toEqual({ provider: "oauth", other: "api_key" });
  });
  it("backs up an unsaved login before switching", async () => {
    await login(a);
    await store.save("provider", "work");
    await login(b);
    await store.use("provider", "work");
    const backup = (await store.list("provider")).find((x) => x.name.startsWith("backup-"));
    expect(backup).toBeDefined();
    await store.use("provider", backup!.name);
    expect((await auth()).provider).toEqual(b);
  });
  it("keeps rotated OAuth tokens and separates users in the same organization", async () => {
    await login(oauth("alice", 1));
    await store.save("provider", "alice");
    await login(oauth("bob", 1));
    await store.save("provider", "bob");
    await store.use("provider", "alice");
    await login(oauth("alice", 2));
    await store.use("provider", "bob");
    await store.use("provider", "alice");
    expect((await auth()).provider).toEqual(oauth("alice", 2));
  });
  it("rejects an OAuth refresh that changes the known user without changing either saved credential", async () => {
    const original = oauth("alice", 1);
    await login(original);
    await store.save("provider", "work");
    const savedBefore = await readFile(join(dir, "accounts.json"), "utf8");
    for (const different of [oauth("bob", 2), { ...oauth("alice", 2), accountId: "another-org" }]) {
      await expect(
        store.withAccount("provider", "work", async () => ({
          credential: different,
          result: "wrong account",
        })),
      ).rejects.toThrow("different account");
      expect((await auth()).provider).toEqual(original);
      expect(await readFile(join(dir, "accounts.json"), "utf8")).toBe(savedBefore);
    }
  });
  it.each([NaN, Infinity, -Infinity])(
    "rejects an OAuth refresh with non-finite expiry %s before writing account storage",
    async (expires) => {
      const original = oauth("alice", 1);
      await store.add("provider", "inactive", original);
      const before = await readFile(join(dir, "accounts.json"), "utf8");
      await expect(
        store.withAccount("provider", "inactive", async () => ({
          credential: { ...oauth("alice", 2), expires },
          result: undefined,
        })),
      ).rejects.toThrow("Invalid refreshed credential");
      expect(await readFile(join(dir, "accounts.json"), "utf8")).toBe(before);
      expect(await store.list("provider")).toHaveLength(1);
    },
  );
  it("does not equate different OAuth users even if a provider repeats a refresh token", () => {
    const original = { ...oauth("alice", 1), refresh: "shared-refresh" };
    const different = { ...oauth("bob", 2), refresh: "shared-refresh" };
    expect(sameAccount(original, different)).toBe(false);
  });
  it("matches a missing OAuth account ID only when the token claim agrees", () => {
    const access = `h.${Buffer.from(
      JSON.stringify({
        sub: "same-user",
        "https://api.openai.com/auth": { chatgpt_account_id: "account-b" },
      }),
    ).toString("base64url")}.s`;
    const withoutId = { type: "oauth" as const, access, refresh: "shared", expires: 1 };
    expect(sameAccount({ ...withoutId, accountId: "account-b" }, withoutId)).toBe(true);
    expect(sameAccount({ ...withoutId, accountId: "account-a" }, withoutId)).toBe(false);
  });
  it("can refresh a saved credential whose existing ID and token claim disagree", async () => {
    const access = `h.${Buffer.from(
      JSON.stringify({
        sub: "same-user",
        "https://api.openai.com/auth": { chatgpt_account_id: "account-b" },
      }),
    ).toString("base64url")}.s`;
    const stored = {
      type: "oauth" as const,
      access,
      refresh: "shared",
      expires: 1,
      accountId: "account-a",
    };
    await store.add("provider", "work", stored);
    await expect(
      store.withAccount("provider", "work", async (credential) => ({ credential, result: "ok" })),
    ).resolves.toBe("ok");
  });
  it("never reverts refreshed tokens when choosing the active account", async () => {
    await login(oauth("alice", 1));
    await store.save("provider", "alice");
    await login(oauth("alice", 2));
    await store.use("provider", "alice");
    expect((await auth()).provider.refresh).toBe("refresh-alice-2");
  });
  it("refuses to overwrite a name owned by another login", async () => {
    await login(a);
    await store.save("provider", "work");
    await login(b);
    await expect(store.save("provider", "work")).rejects.toThrow("another account");
    expect((await auth()).provider).toEqual(b);
  });
  it("does not overwrite corrupt storage or expose its contents", async () => {
    await login(a);
    await store.save("provider", "work");
    await writeFile(join(dir, "accounts.json"), "secret-invalid-json");
    await expect(store.use("provider", "work")).rejects.toThrow("JSON is invalid");
    expect((await auth()).provider).toEqual(a);
    expect(await readFile(join(dir, "accounts.json"), "utf8")).toBe("secret-invalid-json");
  });
  it("serializes concurrent saves without losing entries", async () => {
    await login(a);
    await Promise.all(
      Array.from({ length: 5 }, (_, i) => new AccountStore(dir).save("provider", `alias-${i}`)),
    );
    expect(await store.list("provider")).toHaveLength(5);
  });
  it("removes inactive records without logging out the active provider", async () => {
    await login(a);
    await store.save("provider", "work");
    await expect(store.remove("provider", "work")).rejects.toThrow("Switch to another");
    await login(b);
    await store.remove("provider", "work");
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
    await login(configured);
    await store.save("provider", "command");
    await login(b);
    await store.use("provider", "command");
    expect((await auth()).provider).toEqual(configured);
  });
  it("keeps storage responsive during slow refresh and rejects a replaced account", async () => {
    await store.add("provider", "inactive", a);
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    let finish!: () => void;
    const paused = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const refreshing = store.withAccount("provider", "inactive", async () => {
      started();
      await paused;
      return { credential: b, result: "old account" };
    });
    await entered;
    try {
      const list = await Promise.race([
        store.list("provider"),
        new Promise<never>((_resolve, reject) =>
          setTimeout(() => reject(new Error("Storage remained locked during refresh")), 500),
        ),
      ]);
      expect(list).toHaveLength(1);
      await store.saveLogin("provider", "inactive", b);
    } finally {
      finish();
    }
    await expect(refreshing).rejects.toThrow("Account changed during authentication");
    expect((await store.list("provider"))[0]?.active).toBe(true);
    expect((await auth()).provider).toEqual(b);
  });
  it("serializes refreshes of one inactive slot without blocking other accounts", async () => {
    const old = oauth("alice", 1);
    const refreshed = oauth("alice", 2);
    await store.add("provider", "inactive", old);
    await store.add("provider", "other", b);
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    let finish!: () => void;
    const paused = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const first = store.withAccount("provider", "inactive", async (value) => {
      expect(value).toEqual(old);
      started();
      await paused;
      return { credential: refreshed, result: "first" };
    });
    await entered;
    let secondStarted = false;
    const second = store.withAccount("provider", "inactive", async (value) => {
      secondStarted = true;
      expect(value).toEqual(refreshed);
      return { credential: value, result: "second" };
    });
    try {
      expect(secondStarted).toBe(false);
      expect(await store.list("provider")).toHaveLength(2);
      expect(
        await store.withAccount("provider", "other", async (value) => ({
          credential: value,
          result: value,
        })),
      ).toEqual(b);
      expect(secondStarted).toBe(false);
    } finally {
      finish();
    }
    expect(await first).toBe("first");
    expect(await second).toBe("second");
    expect(secondStarted).toBe(true);
  });
  it("refreshes every saved alias of an inactive account when opaque tokens rotate", async () => {
    const original = {
      type: "oauth",
      access: "opaque-access-1",
      refresh: "opaque-refresh-1",
      expires: 1,
    };
    const refreshed = {
      type: "oauth",
      access: "opaque-access-2",
      refresh: "opaque-refresh-2",
      expires: 2,
    };
    await store.add("provider", "work", original);
    await store.add("provider", "alias", original);
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = store.withAccount("provider", "work", async () => {
      entered();
      await gate;
      return { credential: refreshed, result: undefined };
    });
    await started;
    let aliasStarted = false;
    const alias = store.withAccount("provider", "alias", async (value) => {
      aliasStarted = true;
      return { credential: value, result: value };
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(aliasStarted).toBe(false);
    } finally {
      release();
      await Promise.allSettled([first, alias]);
    }
    expect(await alias).toEqual(refreshed);
  });
  it("keeps later requests behind a queued alias after its credential rotates", async () => {
    const original = oauth("alice", 1);
    const refreshed = oauth("alice", 2);
    await store.add("provider", "work", original);
    await store.add("provider", "alias", original);
    let firstEntered!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      firstEntered = resolve;
    });
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = store.withAccount("provider", "work", async () => {
      firstEntered();
      await firstGate;
      return { credential: refreshed, result: "first" };
    });
    await firstStarted;
    let secondEntered!: () => void;
    const secondStarted = new Promise<void>((resolve) => {
      secondEntered = resolve;
    });
    let releaseSecond!: () => void;
    const secondGate = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    const second = store.withAccount("provider", "alias", async (value) => {
      expect(value).toEqual(refreshed);
      secondEntered();
      await secondGate;
      return { credential: value, result: "second" };
    });
    let thirdStarted = false;
    let third: Promise<string> | undefined;
    try {
      await new Promise((resolve) => setTimeout(resolve, 25));
      releaseFirst();
      await first;
      await secondStarted;
      third = store.withAccount("provider", "work", async (value) => {
        thirdStarted = true;
        return { credential: value, result: "third" };
      });
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(thirdStarted).toBe(false);
    } finally {
      releaseFirst();
      releaseSecond();
      await Promise.allSettled([first, second, third]);
    }
    expect(await second).toBe("second");
    expect(await third).toBe("third");
  });
  it("cancels a queued lookup without letting a later lookup overtake the active refresh", async () => {
    await store.add("provider", "inactive", a);
    let entered!: () => void;
    const running = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = store.withAccount("provider", "inactive", async (credential) => {
      entered();
      await gate;
      return { credential, result: "first" };
    });
    await running;
    const controller = new AbortController();
    let cancelledStarted = false;
    const cancelled = store.withAccount(
      "provider",
      "inactive",
      async (credential) => {
        cancelledStarted = true;
        return { credential, result: "unexpected" };
      },
      controller.signal,
    );
    let laterStarted = false;
    let later: Promise<string> | undefined;
    try {
      controller.abort();
      const outcome = await Promise.race([
        cancelled.then(
          () => "ran",
          () => "cancelled",
        ),
        new Promise<string>((resolve) => setTimeout(() => resolve("timed out"), 200)),
      ]);
      expect(outcome).toBe("cancelled");
      later = store.withAccount("provider", "inactive", async (credential) => {
        laterStarted = true;
        return { credential, result: "later" };
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(laterStarted).toBe(false);
    } finally {
      release();
      await Promise.allSettled([first, cancelled, later]);
    }
    expect(cancelledStarted).toBe(false);
    expect(await later).toBe("later");
  });
});
