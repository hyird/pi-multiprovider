import { createModels, type Credential, type ModelAuth } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { AccountStore, conflictingOAuthIdentitySnapshots, credentialRevision, type OAuthIdentity } from "./store.ts";
import { createAuthSync } from "./auth-sync.ts";

export const ACCOUNTS_SERVICE_EVENT = "pi-accounts:service";
type Context = Pick<ExtensionContext, "modelRegistry" | "model" | "sessionManager">;
type Callback = (event: { providerId: string; ctx?: ExtensionContext; kind?: "metadata" }) => void;
const accountId = (provider: string, label: string) => `${provider}/${encodeURIComponent(label)}`;
const currentId = (provider: string) => `current:${provider}`;
function savedAccountIdentity(id: string): { provider: string; label: string } | undefined {
  if (id.startsWith("current:")) return;
  const separator = id.lastIndexOf("/");
  if (separator < 1) return;
  const provider = id.slice(0, separator);
  try {
    const label = decodeURIComponent(id.slice(separator + 1));
    if (accountId(provider, label) === id) return { provider, label };
  } catch {
    /* Malformed account IDs are ignored. */
  }
}

function accessToken(auth: ModelAuth | undefined): string | undefined {
  if (auth?.apiKey?.trim()) return auth.apiKey.trim();
  for (const [name, value] of Object.entries(auth?.headers ?? {})) {
    if (name.toLowerCase() !== "authorization" || typeof value !== "string") continue;
    const bearer = /^Bearer\s+(.+)$/i.exec(value.trim());
    if (bearer?.[1]?.trim()) return bearer[1].trim();
  }
}

function awaitWithAbort<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
    if (signal.aborted) abort();
  });
}

export function createUsageService(store: AccountStore) {
  const listeners = new Map<string, Set<Callback>>();
  const accountView = (
    account: NonNullable<Awaited<ReturnType<AccountStore["usageAccount"]>>>,
  ) => ({
    id: account.unmanaged ? currentId(account.provider) : accountId(account.provider, account.name),
    providerId: account.provider,
    label: account.name,
    authKind: account.authKind,
    active: account.active,
    credentialRevision: account.credentialRevision,
    ...("email" in account && account.email ? { email: account.email } : {}),
  });
  const accountById = async (id: string, accessToken?: string) => {
    if (id.startsWith("current:")) {
      const provider = id.slice("current:".length);
      if (!provider) return undefined;
      const account = await store.usageAccount(provider, undefined, accessToken);
      return account?.unmanaged
        ? {
            ...accountView(account),
            oauthIdentity: account.oauthIdentity,
            tokenMatches: account.tokenMatches,
            literalApiKey: account.literalApiKey,
          }
        : undefined;
    }
    const identity = savedAccountIdentity(id);
    if (!identity) return undefined;
    const account = await store.usageAccount(identity.provider, identity.label, accessToken);
    return account && !account.unmanaged
      ? {
          ...accountView(account),
          oauthIdentity: account.oauthIdentity,
          tokenMatches: account.tokenMatches,
          literalApiKey: account.literalApiKey,
        }
      : undefined;
  };
  const listAccounts = async () => {
    const { saved, unmanaged } = await store.usageAccounts();
    return [
      ...saved.map((a) => ({
        id: accountId(a.provider, a.name),
        providerId: a.provider,
        label: a.name,
        authKind: a.authKind,
        active: a.active,
        credentialRevision: a.credentialRevision,
        ...(a.email ? { email: a.email } : {}),
      })),
      ...unmanaged.map((a) => ({
        id: currentId(a.provider),
        providerId: a.provider,
        label: "Unmanaged",
        authKind: a.authKind,
        active: true,
        credentialRevision: a.credentialRevision,
      })),
    ];
  };
  const resolveCurrent = async (
    account: Awaited<ReturnType<typeof listAccounts>>[number] & { oauthIdentity?: OAuthIdentity },
    ctx: Context,
    signal?: AbortSignal,
  ) => {
    signal?.throwIfAborted();
    // Pi's registry auth API has no AbortSignal parameter, so stop waiting when the caller cancels.
    const resolved = await awaitWithAbort(
      ctx.modelRegistry.getProviderAuth(account.providerId),
      signal,
    );
    signal?.throwIfAborted();
    const token = accessToken(resolved?.auth);
    if (!token) throw new Error("Current account authentication unavailable");
    const current = await accountById(account.id, token);
    if (!current?.active) throw new Error("Current account changed during authentication");
    // A raw token can be reused while the OAuth account ID changes. Compare
    // the login identity before accepting the provider's resolved token.
    if (conflictingOAuthIdentitySnapshots(account.oauthIdentity, current.oauthIdentity))
      throw new Error("Current account changed during authentication");
    // These built-in providers forward the stored access/key unchanged. A
    // runtime override must not be attributed to the saved login in auth.json.
    const directOAuth =
      current.authKind === "oauth" &&
      (account.providerId === "openai-codex" || account.providerId === "xai");
    const directApiKey =
      account.providerId === "opencode-go" &&
      current.authKind === "api_key" &&
      current.literalApiKey;
    if ((directOAuth || directApiKey) && !current.tokenMatches)
      throw new Error("Current account changed during authentication");
    if (current.credentialRevision !== account.credentialRevision && !current.tokenMatches)
      throw new Error("Current account changed during authentication");
    signal?.throwIfAborted();
    return {
      accessToken: token,
      label: current.label,
      ...(current.email ? { email: current.email } : {}),
      credentialRevision: current.credentialRevision,
      slotId: current.id,
      authKind: current.authKind,
    };
  };
  const service = {
    listAccounts,
    async updateAccountEmail(id: string, email: string, accessToken: string) {
      const account = savedAccountIdentity(id);
      if (account) await store.updateEmail(account.provider, account.label, email, accessToken);
    },
    async getActiveAccount(provider: string, _ctx: Context) {
      const account = await store.usageAccount(provider);
      return account ? accountView(account) : undefined;
    },
    async resolveAccountAuth(id: string, ctx: Context, signal?: AbortSignal) {
      const account = await accountById(id);
      if (!account) throw new Error("Account not found");
      let resolved;
      if (account.active) resolved = await resolveCurrent(account, ctx, signal);
      else {
        const provider = ctx.modelRegistry.getProvider(account.providerId);
        if (!provider) throw new Error("Provider unavailable");
        // Each profile gets an isolated credential store. Refresh never activates an inactive account.
        resolved = await store.withAccount(
        account.providerId,
        account.label,
        async (value) => {
          let credential = value as Credential;
          if (credential.type === "api_key" && credential.key?.startsWith("!"))
            throw new Error("Inactive command-based keys cannot be queried in isolation");
          const models = createModels({
            credentials: {
              read: async (key) => (key === account.providerId ? credential : undefined),
              list: async () => [{ providerId: account.providerId, type: credential.type }],
              modify: async (key, fn) => {
                if (key !== account.providerId) throw new Error("Wrong provider");
                credential = (await fn(credential)) ?? credential;
                return credential;
              },
              delete: async () => {
                throw new Error("Read/refresh only");
              },
            },
          });
          models.setProvider(provider);
          signal?.throwIfAborted();
          const resolved = await models.getAuth(account.providerId, { signal });
          signal?.throwIfAborted();
          const token = accessToken(resolved?.auth);
          if (!token) throw new Error("Account authentication unavailable");
          return {
            credential,
            result: {
              accessToken: token,
              label: account.label,
              ...(account.email ? { email: account.email } : {}),
              credentialRevision: credentialRevision(credential),
            },
          };
        },
        signal,
        );
      }
      const identity = savedAccountIdentity(id);
      return {
        ...resolved,
        updateEmail: identity
          ? (email: string) => store.updateEmail(
              identity.provider, identity.label, email, resolved.accessToken, resolved.credentialRevision,
            )
          : undefined,
      };
    },
    async resolveActiveAccountAuth(provider: string, ctx: Context, signal?: AbortSignal) {
      const current = await store.usageAccount(provider);
      const account = current ? { ...accountView(current), oauthIdentity: current.oauthIdentity } : undefined;
      if (!account) return undefined;
      return resolveCurrent(account, ctx, signal);
    },
    onActiveAccountChanged(provider: string, callback: Callback) {
      let callbacks = listeners.get(provider);
      if (!callbacks) {
        callbacks = new Set();
        listeners.set(provider, callbacks);
      }
      callbacks.add(callback);
      return () => {
        callbacks.delete(callback);
        if (!callbacks.size && listeners.get(provider) === callbacks) listeners.delete(provider);
      };
    },
    changed(provider: string, ctx?: ExtensionContext, kind?: "metadata") {
      for (const callback of listeners.get(provider) ?? []) {
        try {
          callback({ providerId: provider, ctx, ...(kind ? { kind } : {}) });
        } catch {
          /* One usage consumer must not interrupt account synchronization. */
        }
      }
    },
  };
  return service;
}

export function registerUsageService(pi: ExtensionAPI, store: AccountStore) {
  const service = createUsageService(store);
  let ctx: ExtensionContext | undefined;
  const sync = createAuthSync(
    store,
    (result) => {
      for (const provider of result.changed)
        service.changed(
          provider,
          ctx,
          result.metadataChanged?.includes(provider) ? "metadata" : undefined,
        );
      if (ctx?.hasUI && result.added.length) {
        ctx.ui.notify(
          `Saved new accounts: ${result.added.map((a) => `${a.provider} / ${a.name}`).join(", ")}. Rename with /switch-account.`,
          "info",
        );
      }
    },
    () =>
      ctx?.ui.notify(
        "Account synchronization failed. Check account storage and permissions; synchronization will retry automatically.",
        "warning",
      ),
  );
  pi.events.on("pi-accounts:changed", (value) => {
    if (
      !value ||
      typeof value !== "object" ||
      !("provider" in value) ||
      typeof value.provider !== "string"
    )
      return;
    // A preferred-label switch has already changed accounts.json. Reconcile
    // now so the later file-watch event does not notify consumers twice.
    if (
      "storageChanged" in value &&
      value.storageChanged === true &&
      "kind" in value &&
      value.kind === "metadata"
    )
      void sync.reconcile();
    // Repeating the current selection can refresh Pi's runtime without any
    // storage change, so it still needs a direct notification.
    else if ("forceNotify" in value && value.forceNotify === true)
      service.changed(
        value.provider,
        ctx,
        "kind" in value && value.kind === "metadata" ? "metadata" : undefined,
      );
    else sync.schedule();
  });
  pi.on("session_start", async (_event, context) => {
    ctx = context;
    await sync.start();
    pi.events.emit(ACCOUNTS_SERVICE_EVENT, service);
  });
  pi.on("session_shutdown", async () => {
    await sync.stop();
    ctx = undefined;
  });
  pi.events.on("pi-accounts:request-service", () =>
    pi.events.emit(ACCOUNTS_SERVICE_EVENT, service),
  );
  pi.events.emit(ACCOUNTS_SERVICE_EVENT, service);
}
