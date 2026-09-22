import { mkdir, readFile, rename, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
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
  constructor(private dir: string) {}
  private async transaction<T>(fn: (auth: Record<string, unknown>, pool: Pool, savePool: () => Promise<void>, saveAuth: () => Promise<void>) => Promise<T>): Promise<T> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const authPath = join(this.dir, "auth.json");
    const poolPath = join(this.dir, "accounts.json");
    // Match Pi's lock path and hold it across both files, including backups.
    let compromised = false;
    const release = await lockfile.lock(authPath, { realpath: false, stale: 30000, retries: { retries: 8, minTimeout: 40, maxTimeout: 500 }, onCompromised: () => { compromised = true; } });
    try {
      const auth = await readJson(authPath, {});
      const pool = await readJson(poolPath, { version: 1, accounts: [] });
      if (!record(auth) || !record(pool) || pool.version !== 1 || !Array.isArray(pool.accounts) ||
        !pool.accounts.every(a => record(a) && typeof a.provider === "string" && typeof a.name === "string" && credential(a.credential))) {
        throw new AccountError("Invalid account storage format. Existing files were not overwritten.");
      }
      const save = async (path: string, value: unknown) => {
        if (compromised) throw new AccountError("The storage lock was lost. Try again.");
        await atomicWrite(path, value);
      };
      return await fn(auth, pool as Pool, () => save(poolPath, pool), () => save(authPath, auth));
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
  async ensureCurrent(provider: string): Promise<void> {
    await this.transaction(async (auth, pool, savePool) => {
      const current = auth[provider];
      if (!credential(current) || pool.accounts.some(a => a.provider === provider && sameAccount(a.credential, current))) return;
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
  async add(provider: string, name: string, value: unknown): Promise<void> {
    validateLabel(name);
    if (!credential(value)) throw new AccountError("Login returned an unsupported credential format. Nothing was saved.");
    await this.transaction(async (_auth, pool, savePool) => {
      if (pool.accounts.some(a => a.provider === provider && a.name === name)) throw new AccountError("This label already exists. Choose a different label.");
      pool.accounts.push({ provider, name, credential: value });
      await savePool();
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
