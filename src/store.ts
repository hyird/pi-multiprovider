import { mkdir, readFile, rename, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import lockfile from "proper-lockfile";

type Credential = Record<string, unknown> & { type: "oauth" | "api_key" };
type Account = { provider: string; name: string; credential: Credential };
type Pool = { version: 1; accounts: Account[] };

export class AccountError extends Error {}
export function validateLabel(name: string): void {
  if (!name.trim() || name !== name.trim() || name.length > 80 || /[\x00-\x1f\x7f]/.test(name)) throw new AccountError("Labels must contain 1–80 visible characters with no surrounding whitespace.");
}
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function credential(value: unknown): value is Credential {
  return record(value) && (
    (value.type === "api_key" && (typeof value.key === "string" || record(value.env))) ||
    (value.type === "oauth" && typeof value.access === "string" && typeof value.refresh === "string" && typeof value.expires === "number")
  );
}
function subject(value: unknown): string | undefined {
  if (typeof value !== "string") return;
  try {
    const payload: unknown = JSON.parse(Buffer.from(value.split(".")[1] ?? "", "base64url").toString());
    if (record(payload) && typeof payload.sub === "string") return payload.sub;
  } catch { /* Opaque tokens have no stable identity. */ }
}
export function sameAccount(a: Credential, b: Credential): boolean {
  if (a.type !== b.type) return false;
  if (a.type === "api_key") return a.key === b.key && JSON.stringify(a.env) === JSON.stringify(b.env);
  if (a.accountId !== b.accountId) return false;
  if (a.refresh && a.refresh === b.refresh) return true;
  if (a.access && a.access === b.access) return true;
  const left = subject(a.access), right = subject(b.access);
  return !!left && left === right;
}
async function readJson(path: string, fallback: unknown): Promise<unknown> {
  try { return JSON.parse((await readFile(path, "utf8")).replace(/^\uFEFF/, "")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw new AccountError("Cannot read account storage or JSON is invalid. Existing files were not overwritten.");
  }
}
async function atomicWrite(path: string, value: unknown): Promise<void> {
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    await rename(temp, path);
  } finally { await unlink(temp).catch(() => {}); }
}

export class AccountStore {
  private observed = new Map<string, string>();
  private activeCredentials = new Map<string, Credential>();
  constructor(private dir: string) {}
  get directory() { return this.dir; }
  async reconcileCurrentAccounts() {
    return this.transaction(async (auth, pool, savePool, _saveAuth, authPresent) => {
      const added: { provider: string; name: string }[] = [];
      let dirty = false;
      // Only a known login disappearing from a valid auth file counts as logout.
      // Startup, corrupt storage and a missing file must not delete saved accounts.
      if (authPresent) {
        for (const [provider, previous] of this.activeCredentials) {
          if (Object.hasOwn(auth, provider)) continue;
          const remaining = pool.accounts.filter(a => a.provider !== provider || !sameAccount(a.credential, previous));
          if (remaining.length !== pool.accounts.length) {
            pool.accounts = remaining;
            dirty = true;
          }
        }
      }
      for (const [provider, current] of Object.entries(auth)) {
        if (!credential(current)) continue;
        const matches = pool.accounts.filter(a => a.provider === provider && sameAccount(a.credential, current));
        if (matches.length) {
          for (const account of matches) {
            if (JSON.stringify(account.credential) !== JSON.stringify(current)) {
              account.credential = current;
              dirty = true;
            }
          }
        } else {
          let name = "default";
          let suffix = 2;
          while (pool.accounts.some(a => a.provider === provider && a.name === name)) name = `default-${suffix++}`;
          pool.accounts.push({ provider, name, credential: current });
          added.push({ provider, name });
          dirty = true;
        }
      }
      if (dirty) await savePool();
      if (authPresent) this.rememberActive(auth);
      const next = new Map<string, string>();
      for (const provider of new Set([...Object.keys(auth), ...pool.accounts.map(a => a.provider)])) {
        // Hash credentials instead of retaining another copy of tokens in memory.
        const state = JSON.stringify([auth[provider], pool.accounts.filter(a => a.provider === provider).map(a => [a.name, a.credential.type])]);
        next.set(provider, createHash("sha256").update(state).digest("hex"));
      }
      const changed = [...new Set([...this.observed.keys(), ...next.keys()])]
        .filter(provider => this.observed.get(provider) !== next.get(provider));
      this.observed = next;
      return { changed, added };
    });
  }
  private rememberActive(auth: Record<string, unknown>) {
    this.activeCredentials = new Map(Object.entries(auth)
      .filter((entry): entry is [string, Credential] => credential(entry[1]))
      .map(([provider, value]) => [provider, structuredClone(value)]));
  }
  private async transaction<T>(fn: (auth: Record<string, unknown>, pool: Pool, savePool: () => Promise<void>, saveAuth: () => Promise<void>, authPresent: boolean) => Promise<T>): Promise<T> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const authPath = join(this.dir, "auth.json");
    const poolPath = join(this.dir, "accounts.json");
    // Match Pi's lock path and hold it across both files, including backups.
    let compromised = false;
    const release = await lockfile.lock(authPath, { realpath: false, stale: 30000, retries: { retries: 8, minTimeout: 40, maxTimeout: 500 }, onCompromised: () => { compromised = true; } });
    try {
      const authData = await readJson(authPath, undefined);
      const auth = authData === undefined ? {} : authData;
      const pool = await readJson(poolPath, { version: 1, accounts: [] });
      if (!record(auth) || !record(pool) || pool.version !== 1 || !Array.isArray(pool.accounts) ||
        !pool.accounts.every(a => record(a) && typeof a.provider === "string" && typeof a.name === "string" && credential(a.credential))) {
        throw new AccountError("Invalid account storage format. Existing files were not overwritten.");
      }
      const save = async (path: string, value: unknown) => {
        if (compromised) throw new AccountError("The storage lock was lost. Try again.");
        await atomicWrite(path, value);
      };
      return await fn(auth, pool as Pool, () => save(poolPath, pool), async () => {
        await save(authPath, auth);
        // A plugin switch followed immediately by native logout must remove the
        // newly selected account, even before the debounced watcher has run.
        this.rememberActive(auth);
      }, authData !== undefined);
    } finally { await release(); }
  }
  async list(provider: string): Promise<{ name: string; active: boolean }[]> {
    return this.transaction(async (auth, pool) => pool.accounts.filter(a => a.provider === provider).map(a => ({ name: a.name, active: credential(auth[provider]) && sameAccount(a.credential, auth[provider]) })));
  }
  async save(provider: string, name: string): Promise<void> {
    validateLabel(name);
    await this.transaction(async (auth, pool, savePool) => {
      const current = auth[provider];
      if (!credential(current)) throw new AccountError(`No stored credentials for ${provider}. Run /login ${provider} first.`);
      const existing = pool.accounts.find(a => a.provider === provider && a.name === name);
      if (existing && !sameAccount(existing.credential, current)) throw new AccountError("This name belongs to another account. Choose a different name.");
      if (existing) existing.credential = current;
      else pool.accounts.push({ provider, name, credential: current });
      await savePool();
    });
  }
  async providers(): Promise<string[]> {
    return this.transaction(async (auth, pool) => [...new Set([...Object.keys(auth), ...pool.accounts.map(a => a.provider)])]);
  }
  async currentAuthKinds(): Promise<Record<string, Credential["type"]>> {
    return this.transaction(async (auth) => Object.fromEntries(
      Object.entries(auth).filter((entry): entry is [string, Credential] => credential(entry[1]))
        .map(([provider, current]) => [provider, current.type]),
    ));
  }
  async listAccounts() {
    return this.transaction(async (auth, pool) => pool.accounts.map(a => { const current = auth[a.provider]; return ({
      provider: a.provider, name: a.name, authKind: a.credential.type === "oauth" ? "oauth" : "api_key",
      active: credential(current) && sameAccount(a.credential, current),
    }); }));
  }
  async withAccount<T>(provider: string, name: string, fn: (value: unknown) => Promise<{ credential: unknown; result: T }>): Promise<T> {
    return this.transaction(async (auth, pool, savePool, saveAuth) => {
      const account = pool.accounts.find(a => a.provider === provider && a.name === name);
      if (!account) throw new AccountError("Account not found.");
      const original = account.credential;
      const next = await fn(structuredClone(original));
      if (!credential(next.credential)) throw new AccountError("Invalid refreshed credential.");
      if (JSON.stringify(next.credential) !== JSON.stringify(original)) {
        account.credential = next.credential;
        await savePool();
        if (credential(auth[provider]) && sameAccount(original, auth[provider])) {
          auth[provider] = next.credential;
          await saveAuth();
        }
      }
      return next.result;
    });
  }
  async unmanagedAccounts() {
    return this.transaction(async (auth, pool) => Object.entries(auth).flatMap(([provider, current]) => {
      if (!credential(current) || pool.accounts.some(a => a.provider === provider && sameAccount(a.credential, current))) return [];
      return [{ provider, authKind: current.type === "oauth" ? "oauth" : "api_key" }];
    }));
  }
  async ensureCurrent(provider: string, saveUnknown = true): Promise<void> {
    await this.transaction(async (auth, pool, savePool) => {
      const current = auth[provider];
      if (!credential(current)) return;
      const matches = pool.accounts.filter(a => a.provider === provider && sameAccount(a.credential, current));
      if (matches.length) {
        if (matches.some(a => JSON.stringify(a.credential) !== JSON.stringify(current))) {
          for (const account of matches) account.credential = current;
          await savePool();
        }
        return;
      }
      if (!saveUnknown) return;
      let name = "default";
      let suffix = 2;
      while (pool.accounts.some(a => a.provider === provider && a.name === name)) name = `default-${suffix++}`;
      pool.accounts.push({ provider, name, credential: current });
      await savePool();
    });
  }
  async removeProvider(provider: string): Promise<void> {
    await this.transaction(async (auth, pool, savePool, saveAuth) => {
      pool.accounts = pool.accounts.filter(a => a.provider !== provider);
      await savePool();
      delete auth[provider];
      await saveAuth();
    });
  }
  async logout(provider: string, name: string): Promise<void> {
    await this.transaction(async (auth, pool, savePool, saveAuth) => {
      const account = pool.accounts.find(a => a.provider === provider && a.name === name);
      if (!account) throw new AccountError("Account not found.");
      const current = auth[provider];
      const active = credential(current) && sameAccount(account.credential, current);
      // Remove aliases of the same login as well, so signing out cannot leave a duplicate behind.
      pool.accounts = pool.accounts.filter(a => a.provider !== provider || !sameAccount(a.credential, account.credential));
      await savePool();
      if (active) { delete auth[provider]; await saveAuth(); }
    });
  }
  async add(provider: string, name: string, value: unknown): Promise<void> {
    validateLabel(name);
    if (!credential(value)) throw new AccountError("Login returned an unsupported credential format. Nothing was saved.");
    await this.transaction(async (_auth, pool, savePool) => {
      if (pool.accounts.some(a => a.provider === provider && a.name === name)) throw new AccountError("This label already exists. Choose a different label.");
      pool.accounts.push({ provider, name, credential: value });
      await savePool();
    });
  }
  async saveLogin(provider: string, name: string, value: unknown): Promise<void> {
    validateLabel(name);
    if (!credential(value)) throw new AccountError("Login returned an unsupported credential format.");
    await this.transaction(async (auth, pool, savePool, saveAuth) => {
      const current = auth[provider];
      if (credential(current)) {
        const matches = pool.accounts.filter(a => a.provider === provider && sameAccount(a.credential, current));
        for (const account of matches) account.credential = current;
        if (!matches.length || matches.every(a => a.name === name) && !sameAccount(current, value)) {
          pool.accounts.push({ provider, name: `backup-${randomUUID()}`, credential: current });
        }
      }
      const existing = pool.accounts.find(a => a.provider === provider && a.name === name);
      if (existing) existing.credential = value;
      else pool.accounts.push({ provider, name, credential: value });
      await savePool();
      Object.defineProperty(auth, provider, { value, enumerable: true, configurable: true, writable: true });
      await saveAuth();
    });
  }
  async rename(provider: string, name: string, label: string): Promise<void> {
    validateLabel(label);
    await this.transaction(async (_auth, pool, savePool) => {
      const account = pool.accounts.find(a => a.provider === provider && a.name === name);
      if (!account) throw new AccountError("Account not found.");
      if (pool.accounts.some(a => a !== account && a.provider === provider && a.name === label)) throw new AccountError("This label already exists. Choose a different label.");
      account.name = label;
      await savePool();
    });
  }
  async use(provider: string, name: string): Promise<void> {
    await this.transaction(async (auth, pool, savePool, saveAuth) => {
      const target = pool.accounts.find(a => a.provider === provider && a.name === name);
      if (!target) throw new AccountError("Account not found.");
      const current = auth[provider];
      if (current !== undefined && !credential(current)) throw new AccountError("The current credential format is unsupported. Account was not changed.");
      if (current) {
        const matches = pool.accounts.filter(a => a.provider === provider && sameAccount(a.credential, current));
        // Capture rotated OAuth tokens before switching away; never overwrite a different login.
        for (const account of matches) account.credential = current;
        if (!matches.length) pool.accounts.push({ provider, name: `backup-${randomUUID()}`, credential: current });
      }
      // Write the backup first. A failed auth write leaves the original account active.
      await savePool();
      Object.defineProperty(auth, provider, { value: target.credential, enumerable: true, configurable: true, writable: true });
      await saveAuth();
    });
  }
  async remove(provider: string, name: string): Promise<void> {
    await this.transaction(async (auth, pool, savePool) => {
      const index = pool.accounts.findIndex(a => a.provider === provider && a.name === name);
      if (index < 0) throw new AccountError("Account not found.");
      const current = auth[provider];
      if (credential(current) && sameAccount(pool.accounts[index]!.credential, current)) throw new AccountError("Switch to another account before removing the active account.");
      pool.accounts.splice(index, 1);
      await savePool();
    });
  }
}
