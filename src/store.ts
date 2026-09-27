import { mkdir, readFile, rename, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import lockfile from "proper-lockfile";
import { credentialEmail, validEmail } from "./account-identity.ts";

type Credential = Record<string, unknown> & { type: "oauth" | "api_key" };
type Account = { provider: string; name: string; credential: Credential; email?: string };
type Pool = { version: 1; accounts: Account[] };

export class AccountError extends Error {}
function wellFormedUnicode(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (++i === value.length) return false;
      const next = value.charCodeAt(i);
      if (next < 0xdc00 || next > 0xdfff) return false;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}
export function validateLabel(name: string): void {
  if (name.length > 80 || name !== name.trim() || /[\p{Cc}\p{Bidi_Control}\u00ad\u200b\u2060\ufeff]/u.test(name) ||
    !wellFormedUnicode(name) || !name.replace(/[\p{White_Space}\p{Default_Ignorable_Code_Point}]/gu, ""))
    throw new AccountError("Labels must contain 1–80 visible characters without controls or surrounding whitespace.");
}
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function credential(value: unknown): value is Credential {
  return record(value) && (
    (value.type === "api_key" && (typeof value.key === "string" || record(value.env))) ||
    (value.type === "oauth" && typeof value.access === "string" && typeof value.refresh === "string" &&
      typeof value.expires === "number" && Number.isFinite(value.expires))
  );
}
function tokenIdentity(value: unknown): { subject?: string; accountId?: string } {
  if (typeof value !== "string" || value.length > 65536) return {};
  try {
    const payload: unknown = JSON.parse(Buffer.from(value.split(".")[1] ?? "", "base64url").toString());
    if (!record(payload)) return {};
    const auth = payload["https://api.openai.com/auth"];
    return {
      subject: typeof payload.sub === "string" ? payload.sub : undefined,
      accountId: record(auth) && typeof auth.chatgpt_account_id === "string" ? auth.chatgpt_account_id : undefined,
    };
  } catch { /* Opaque tokens have no stable identity. */ }
  return {};
}
export type OAuthIdentity = { explicitAccountId?: string; tokenAccountId?: string; subject?: string };
function oauthIdentity(value: Credential): OAuthIdentity | undefined {
  if (value.type !== "oauth") return undefined;
  const token = tokenIdentity(value.access);
  return {
    explicitAccountId: typeof value.accountId === "string" && value.accountId ? value.accountId : undefined,
    tokenAccountId: token.accountId,
    subject: token.subject,
  };
}
export function conflictingOAuthIdentitySnapshots(a?: OAuthIdentity, b?: OAuthIdentity): boolean {
  if (!a || !b) return false;
  const differs = (first?: string, second?: string) => !!(first && second && first !== second);
  return differs(a.explicitAccountId, b.explicitAccountId) ||
    differs(a.tokenAccountId, b.tokenAccountId) ||
    (!b.explicitAccountId && differs(a.explicitAccountId, b.tokenAccountId)) ||
    (!a.explicitAccountId && differs(b.explicitAccountId, a.tokenAccountId)) ||
    differs(a.subject, b.subject);
}
function conflictingOAuthIdentity(a: Credential, b: Credential,
  left = tokenIdentity(a.access), right = tokenIdentity(b.access)): boolean {
  // A missing explicit ID may be filled by a token claim. Compare across
  // credentials without rejecting an unchanged legacy credential outright.
  return conflictingOAuthIdentitySnapshots(
    { explicitAccountId: typeof a.accountId === "string" ? a.accountId : undefined,
      tokenAccountId: left.accountId, subject: left.subject },
    { explicitAccountId: typeof b.accountId === "string" ? b.accountId : undefined,
      tokenAccountId: right.accountId, subject: right.subject },
  );
}
function sameEnv(a: unknown, b: unknown): boolean {
  if (a === undefined || b === undefined) return a === b;
  if (!record(a) || !record(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && a[key] === b[key]);
}
function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, item) => record(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]]))
    : item);
}
export function credentialRevision(value: object): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}
export function sameAccount(a: Credential, b: Credential): boolean {
  if (a.type !== b.type) return false;
  if (a.type === "api_key") return a.key === b.key && sameEnv(a.env, b.env);
  // Providers can add accountId after an initial login. A missing ID is not
  // evidence of a different account when refresh/access identity still matches.
  if (a.accountId && b.accountId && a.accountId !== b.accountId) return false;
  // Equal access and equal explicit IDs need no JWT decode. When one ID is
  // missing, compare the other's ID with the token claim before merging.
  if (a.access && a.access === b.access && a.accountId === b.accountId) return true;
  const left = tokenIdentity(a.access), right = tokenIdentity(b.access);
  // A repeated refresh token cannot override contradictory account/user claims.
  if (conflictingOAuthIdentity(a, b, left, right)) return false;
  if (a.access && a.access === b.access) return true;
  if (a.refresh && a.refresh === b.refresh) return true;
  return !!left.subject && left.subject === right.subject;
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

async function waitForAccountTurn(previous: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) return previous;
  signal.throwIfAborted();
  let onAbort!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason ?? new AccountError("Account lookup cancelled."));
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try {
    await Promise.race([previous, cancelled]);
    signal.throwIfAborted();
  } finally { signal.removeEventListener("abort", onAbort); }
}

export class AccountStore {
  private observed = new Map<string, string>();
  private observedCredentials = new Map<string, string>();
  private activeCredentials = new Map<string, Credential>();
  private accountWork = new Map<string, Promise<void>>();
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
      const accountsByProvider = new Map<string, Account[]>();
      for (const account of pool.accounts) {
        const group = accountsByProvider.get(account.provider) ?? [];
        group.push(account);
        accountsByProvider.set(account.provider, group);
      }
      for (const [provider, current] of Object.entries(auth)) {
        if (!credential(current)) continue;
        const accounts = accountsByProvider.get(provider) ?? [];
        const matches = accounts.filter(a => sameAccount(a.credential, current));
        if (matches.length) {
          const currentJson = stableJson(current);
          for (const account of matches) {
            if (stableJson(account.credential) !== currentJson) {
              account.credential = current;
              dirty = true;
            }
          }
        } else {
          let name = "default";
          let suffix = 2;
          while (accounts.some(a => a.name === name)) name = `default-${suffix++}`;
          const addedAccount = { provider, name, credential: current };
          pool.accounts.push(addedAccount);
          accounts.push(addedAccount);
          accountsByProvider.set(provider, accounts);
          added.push({ provider, name });
          dirty = true;
        }
      }
      if (dirty) await savePool();
      if (authPresent) this.rememberActive(auth);
      const next = new Map<string, string>();
      const nextCredentials = new Map<string, string>();
      for (const provider of new Set([...Object.keys(auth), ...accountsByProvider.keys()])) {
        // Hash credentials instead of retaining another copy of tokens in memory.
        const accounts = accountsByProvider.get(provider) ?? [];
        const slots = accounts.map(a => ({
          name: a.name,
          type: a.credential.type,
          email: validEmail(a.email) ?? credentialEmail(a.credential),
          revision: credentialRevision(a.credential),
        }));
        // Renames and aliases change the roster, but an existing credential
        // still owns the same quota. Hash distinct saved credentials only.
        const savedCredentials = [...new Set(slots.map(slot => slot.revision))].sort();
        const credentials = stableJson([auth[provider], savedCredentials]);
        nextCredentials.set(provider, createHash("sha256").update(credentials).digest("hex"));
        const state = stableJson([auth[provider], slots]);
        next.set(provider, createHash("sha256").update(state).digest("hex"));
      }
      const changed = [...new Set([...this.observed.keys(), ...next.keys()])]
        .filter(provider => this.observed.get(provider) !== next.get(provider));
      const metadataChanged = changed.filter(provider =>
        this.observedCredentials.has(provider) &&
        this.observedCredentials.get(provider) === nextCredentials.get(provider));
      this.observed = next;
      this.observedCredentials = nextCredentials;
      return { changed, added, ...(metadataChanged.length ? { metadataChanged } : {}) };
    });
  }
  private rememberActive(auth: Record<string, unknown>) {
    const next = new Map(this.activeCredentials);
    for (const provider of next.keys()) if (!Object.hasOwn(auth, provider)) next.delete(provider);
    for (const [provider, value] of Object.entries(auth)) {
      if (credential(value)) next.set(provider, structuredClone(value));
      // An unsupported interim value cannot establish a new login or erase
      // the last known identity needed to recognize a later native logout.
    }
    this.activeCredentials = next;
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
        !pool.accounts.every(a => record(a) && typeof a.provider === "string" && typeof a.name === "string" && wellFormedUnicode(a.name) && credential(a.credential))) {
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
  async list(provider: string): Promise<{ name: string; active: boolean; email?: string }[]> {
    return this.transaction(async (auth, pool) => pool.accounts.filter(a => a.provider === provider).map(a => {
      const email = validEmail(a.email) ?? credentialEmail(a.credential);
      return { name: a.name, active: credential(auth[provider]) && sameAccount(a.credential, auth[provider]), ...(email ? { email } : {}) };
    }));
  }
  async updateEmail(provider: string, name: string, value: unknown, accessToken: string, verifiedRevision?: string): Promise<void> {
    const email = validEmail(value);
    if (!email) return;
    await this.transaction(async (auth, pool, savePool) => {
      const account = pool.accounts.find(a => a.provider === provider && a.name === name);
      if (!account) return;
      const storedToken = account.credential.type === "oauth" ? account.credential.access : account.credential.key;
      const current = auth[provider];
      // Native OAuth refresh may update auth.json before the watcher copies the
      // new token into accounts.json. Accept that token only for the same login.
      const refreshedActive = account.credential.type === "oauth" && credential(current) &&
        current.type === "oauth" && current.access === accessToken && sameAccount(account.credential, current);
      // A provider can transform the runtime token. Only the email callback
      // returned by a successful account resolution supplies this revision.
      const activeCredential = credential(current) && sameAccount(account.credential, current) ? current : undefined;
      const sameResolvedCredential = verifiedRevision !== undefined &&
        credentialRevision(activeCredential ?? account.credential) === verifiedRevision;
      // Ignore metadata from a credential that no longer belongs to this slot.
      // A verified resolution must match its exact revision even when the raw
      // access token is shared by two accounts with different account IDs.
      const authorized = verifiedRevision === undefined
        ? storedToken === accessToken || refreshedActive
        : sameResolvedCredential;
      if (!authorized || account.email === email) return;
      account.email = email;
      await savePool();
    });
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
  async menuSnapshot() {
    return this.transaction(async (auth, pool) => ({
      providers: [...new Set([...Object.keys(auth), ...pool.accounts.map(a => a.provider)])],
      accounts: pool.accounts.map(a => {
        const current = auth[a.provider];
        const email = validEmail(a.email) ?? credentialEmail(a.credential);
        return {
          provider: a.provider, name: a.name,
          active: credential(current) && sameAccount(a.credential, current),
          ...(email ? { email } : {}),
        };
      }),
    }));
  }
  async currentAuthKinds(): Promise<Record<string, Credential["type"]>> {
    return this.transaction(async (auth) => Object.fromEntries(
      Object.entries(auth).filter((entry): entry is [string, Credential] => credential(entry[1]))
        .map(([provider, current]) => [provider, current.type]),
    ));
  }
  async usageAccounts() {
    return this.transaction(async (auth, pool) => {
      const matchedProviders = new Set<string>();
      const activeRevisions = new Map<string, string>();
      const saved = pool.accounts.map(a => {
        const current = auth[a.provider];
        const activeCredential = credential(current) && sameAccount(a.credential, current) ? current : undefined;
        if (activeCredential) matchedProviders.add(a.provider);
        const email = validEmail(a.email) ?? credentialEmail(a.credential);
        const revision = activeCredential
          ? activeRevisions.get(a.provider) ?? credentialRevision(activeCredential)
          : credentialRevision(a.credential);
        if (activeCredential) activeRevisions.set(a.provider, revision);
        return {
          provider: a.provider, name: a.name, authKind: a.credential.type === "oauth" ? "oauth" : "api_key",
          active: !!activeCredential,
          credentialRevision: revision,
          ...(email ? { email } : {}),
        };
      });
      const unmanaged = Object.entries(auth).flatMap(([provider, current]) => {
        if (!credential(current) || matchedProviders.has(provider)) return [];
        return [{ provider, authKind: current.type === "oauth" ? "oauth" : "api_key", credentialRevision: credentialRevision(current) }];
      });
      return { saved, unmanaged };
    });
  }
  async usageAccount(provider: string, name?: string, accessToken?: string) {
    return this.transaction(async (auth, pool) => {
      const current = auth[provider];
      const tokenMatches = accessToken !== undefined && credential(current) &&
        (current.type === "oauth" ? current.access : current.key) === accessToken;
      // Pi expands $VAR templates and executes !commands during auth resolution.
      // Only an ordinary literal key can be compared directly to the result.
      const literalApiKey = credential(current) && current.type === "api_key" &&
        typeof current.key === "string" && !current.key.startsWith("!") && !current.key.includes("$");
      const account = name === undefined
        ? credential(current) ? pool.accounts.find(a => a.provider === provider && sameAccount(a.credential, current)) : undefined
        : pool.accounts.find(a => a.provider === provider && a.name === name);
      if (account) {
        const activeCredential = credential(current) && sameAccount(account.credential, current) ? current : undefined;
        const email = validEmail(account.email) ?? credentialEmail(account.credential);
        return {
          provider, name: account.name, authKind: account.credential.type === "oauth" ? "oauth" as const : "api_key" as const,
          active: !!activeCredential, credentialRevision: credentialRevision(activeCredential ?? account.credential),
          unmanaged: false as const, tokenMatches, literalApiKey,
          oauthIdentity: oauthIdentity(activeCredential ?? account.credential), ...(email ? { email } : {}),
        };
      }
      if (name !== undefined || !credential(current)) return undefined;
      return {
        provider, name: "Unmanaged", authKind: current.type === "oauth" ? "oauth" as const : "api_key" as const,
        active: true, credentialRevision: credentialRevision(current), unmanaged: true as const, tokenMatches, literalApiKey,
        oauthIdentity: oauthIdentity(current),
      };
    });
  }
  async listAccounts() { return (await this.usageAccounts()).saved; }
  async withAccount<T>(provider: string, name: string, fn: (value: unknown) => Promise<{ credential: unknown; result: T }>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    const initial = await this.transaction(async (_auth, pool) => {
      const account = pool.accounts.find(a => a.provider === provider && a.name === name);
      if (!account) throw new AccountError("Account not found.");
      const serialized = stableJson(account.credential);
      return {
        credential: structuredClone(account.credential),
        aliases: pool.accounts.filter(a => a.provider === provider &&
          stableJson(a.credential) === serialized).map(a => a.name),
      };
    });
    // Queue by saved slots, not a token revision that changes after refresh.
    // Every alias of one credential joins the same queue; other accounts remain concurrent.
    const keys = [...new Set(initial.aliases.map(label => JSON.stringify([provider, label])))];
    const queued = [...new Set(keys.map(key => this.accountWork.get(key)).filter((work): work is Promise<void> => !!work))];
    const previous = Promise.all(queued).then(() => {});
    let release!: () => void;
    const ownTurn = new Promise<void>(resolve => { release = resolve; });
    // An aborted waiter may return early, but its queue position must remain
    // behind the active refresh until that refresh releases the credential.
    const work = previous.then(() => ownTurn);
    for (const key of keys) this.accountWork.set(key, work);
    void work.then(() => {
      for (const key of keys)
        if (this.accountWork.get(key) === work) this.accountWork.delete(key);
    });
    try {
      await waitForAccountTurn(previous, signal);
      return await this.resolveAccount(provider, name, fn, queued.length ? undefined : initial.credential);
    } finally {
      release();
    }
  }
  private async resolveAccount<T>(provider: string, name: string, fn: (value: unknown) => Promise<{ credential: unknown; result: T }>, initial?: Credential): Promise<T> {
    // Credential resolution can refresh OAuth over the network. Do not hold
    // Pi's auth-file lock while the provider is responding.
    const original = initial ?? await this.transaction(async (_auth, pool) => {
      const account = pool.accounts.find(a => a.provider === provider && a.name === name);
      if (!account) throw new AccountError("Account not found.");
      return structuredClone(account.credential);
    });
    const next = await fn(structuredClone(original));
    const refreshed = next.credential;
    if (!credential(refreshed)) throw new AccountError("Invalid refreshed credential.");
    if (original.type !== refreshed.type ||
        (original.type === "oauth" && conflictingOAuthIdentity(original, refreshed)))
      throw new AccountError("Refreshed credential belongs to a different account.");
    const originalJson = stableJson(original);
    return this.transaction(async (auth, pool, savePool, saveAuth) => {
      const account = pool.accounts.find(a => a.provider === provider && a.name === name);
      if (!account || stableJson(account.credential) !== originalJson) {
        throw new AccountError("Account changed during authentication. Retry the usage request.");
      }
      if (credential(auth[provider]) && sameAccount(original, auth[provider]) && stableJson(auth[provider]) !== originalJson) {
        throw new AccountError("Active credential changed during authentication. Retry the usage request.");
      }
      if (stableJson(refreshed) !== originalJson) {
        // Aliases with the same starting credential share this refresh. Do not
        // replace an alias that was independently updated while the request ran.
        for (const alias of pool.accounts) {
          if (alias.provider === provider && stableJson(alias.credential) === originalJson)
            alias.credential = refreshed;
        }
        await savePool();
        if (credential(auth[provider]) && sameAccount(original, auth[provider])) {
          auth[provider] = refreshed;
          await saveAuth();
        }
      }
      return next.result;
    });
  }
  async unmanagedAccounts() { return (await this.usageAccounts()).unmanaged; }
  async ensureCurrent(provider: string, saveUnknown = true): Promise<void> {
    await this.transaction(async (auth, pool, savePool) => {
      const current = auth[provider];
      if (!credential(current)) return;
      const matches = pool.accounts.filter(a => a.provider === provider && sameAccount(a.credential, current));
      if (matches.length) {
        const currentJson = stableJson(current);
        if (matches.some(a => stableJson(a.credential) !== currentJson)) {
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
      if (existing) {
        if (!sameAccount(existing.credential, value)) delete existing.email;
        existing.credential = value;
      }
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
  async use(provider: string, name: string): Promise<{ credentialChanged: boolean; preferredLabelChanged?: boolean }> {
    return this.transaction(async (auth, pool, savePool, saveAuth) => {
      const target = pool.accounts.find(a => a.provider === provider && a.name === name);
      if (!target) throw new AccountError("Account not found.");
      const current = auth[provider];
      if (current !== undefined && !credential(current)) throw new AccountError("The current credential format is unsupported. Account was not changed.");
      const previousPool = stableJson(pool.accounts);
      if (current) {
        const matches = pool.accounts.filter(a => a.provider === provider && sameAccount(a.credential, current));
        // Capture rotated OAuth tokens before switching away; never overwrite a different login.
        for (const account of matches) account.credential = current;
        if (!matches.length) pool.accounts.push({ provider, name: `backup-${randomUUID()}`, credential: current });
      }
      const credentialChanged = stableJson(current) !== stableJson(target.credential);
      // Aliases can share a credential. Keep the selected label first so the
      // active-account view still identifies it after a new session or restart.
      const firstIndex = pool.accounts.findIndex(account => account.provider === provider);
      const targetIndex = pool.accounts.indexOf(target);
      const preferredLabelChanged = targetIndex !== firstIndex;
      if (preferredLabelChanged) {
        pool.accounts.splice(targetIndex, 1);
        pool.accounts.splice(firstIndex, 0, target);
      }
      // Write the backup first. A failed auth write leaves the original account active.
      if (stableJson(pool.accounts) !== previousPool) await savePool();
      if (credentialChanged) {
        Object.defineProperty(auth, provider, { value: target.credential, enumerable: true, configurable: true, writable: true });
        await saveAuth();
      }
      return { credentialChanged, ...(preferredLabelChanged ? { preferredLabelChanged: true } : {}) };
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
