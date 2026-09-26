import { createModels, type Credential } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { AccountStore } from "./store.ts";
import { createAuthSync } from "./auth-sync.ts";

export const ACCOUNTS_SERVICE_EVENT = "pi-accounts:service";
type Context = Pick<ExtensionContext, "modelRegistry" | "model" | "sessionManager">;
type Callback = (event: { providerId: string; ctx?: ExtensionContext }) => void;
const accountId = (provider: string, label: string) => `${provider}/${encodeURIComponent(label)}`;
const currentId = (provider: string) => `current:${provider}`;

export function createUsageService(store: AccountStore) {
  const listeners = new Map<string, Set<Callback>>();
  const listAccounts = async () => {
    return [
      ...(await store.listAccounts()).map(a => ({ id: accountId(a.provider, a.name), providerId: a.provider, label: a.name, authKind: a.authKind, active: a.active })),
      ...(await store.unmanagedAccounts()).map(a => ({ id: currentId(a.provider), providerId: a.provider, label: "Unmanaged", authKind: a.authKind, active: true })),
    ];
  };
  const service = {
    listAccounts,
    async updateAccountEmail(id: string, email: string, accessToken: string) {
      const account = (await listAccounts()).find(a => a.id === id);
      if (account && !id.startsWith("current:")) await store.updateEmail(account.providerId, account.label, email, accessToken);
    },
    async getActiveAccount(provider: string, _ctx: Context) {
      return (await listAccounts()).find(a => a.providerId === provider && a.active);
    },
    async resolveAccountAuth(id: string, ctx: Context, signal?: AbortSignal) {
      const account = (await listAccounts()).find(a => a.id === id);
      if (!account) throw new Error("Account not found");
      if (account.active) return service.resolveActiveAccountAuth(account.providerId, ctx, signal);
      const provider = ctx.modelRegistry.getProvider(account.providerId);
      if (!provider) throw new Error("Provider unavailable");
      // Each profile gets an isolated credential store. Refresh never activates an inactive account.
      return store.withAccount(account.providerId, account.label, async value => {
        let credential = value as Credential;
        if (credential.type === "api_key" && credential.key?.startsWith("!")) throw new Error("Inactive command-based keys cannot be queried in isolation");
        const models = createModels({ credentials: {
          read: async key => key === account.providerId ? credential : undefined,
          list: async () => [{ providerId: account.providerId, type: credential.type }],
          modify: async (key, fn) => {
            if (key !== account.providerId) throw new Error("Wrong provider");
            credential = await fn(credential) ?? credential;
            return credential;
          },
          delete: async () => { throw new Error("Read/refresh only"); },
        } });
        models.setProvider(provider);
        signal?.throwIfAborted();
        const resolved = await models.getAuth(account.providerId, { signal });
        signal?.throwIfAborted();
        const auth = resolved?.auth;
        const authorization = auth?.headers?.Authorization ?? auth?.headers?.authorization;
        const accessToken = auth?.apiKey ?? (typeof authorization === "string" && /^bearer /i.test(authorization) ? authorization.slice(7) : undefined);
        if (!accessToken) throw new Error("Account authentication unavailable");
        return { credential, result: { accessToken, label: account.label } };
      });
    },
    async resolveActiveAccountAuth(provider: string, ctx: Context, signal?: AbortSignal) {
      const account = await service.getActiveAccount(provider, ctx);
      if (!account) return undefined;
      signal?.throwIfAborted();
      const resolved = await ctx.modelRegistry.getProviderAuth(provider);
      signal?.throwIfAborted();
      const auth = resolved?.auth;
      const authorization = auth?.headers?.Authorization ?? auth?.headers?.authorization;
      const accessToken = auth?.apiKey ?? (typeof authorization === "string" && /^bearer /i.test(authorization) ? authorization.slice(7) : undefined);
      if (!accessToken) throw new Error("Current account authentication unavailable");
      return { accessToken, label: account.label };
    },
    onActiveAccountChanged(provider: string, callback: Callback) {
      let callbacks = listeners.get(provider);
      if (!callbacks) { callbacks = new Set(); listeners.set(provider, callbacks); }
      callbacks.add(callback);
      return () => { callbacks.delete(callback); };
    },
    changed(provider: string, ctx?: ExtensionContext) {
      for (const callback of listeners.get(provider) ?? []) callback({ providerId: provider, ctx });
    },
  };
  return service;
}

export function registerUsageService(pi: ExtensionAPI, store: AccountStore) {
  const service = createUsageService(store);
  let ctx: ExtensionContext | undefined;
  const sync = createAuthSync(store, result => {
    for (const provider of result.changed) service.changed(provider, ctx);
    if (ctx?.hasUI && result.added.length) {
      ctx.ui.notify(`Saved new accounts: ${result.added.map(a => `${a.provider} / ${a.name}`).join(", ")}. Rename with /switch-account.`, "info");
    }
  }, () => ctx?.ui.notify("Account synchronization failed. Check account storage and permissions; synchronization will retry automatically.", "warning"));
  pi.events.on("pi-accounts:changed", value => {
    if (value && typeof value === "object" && "provider" in value && typeof value.provider === "string") sync.schedule();
  });
  pi.on("session_start", async (_event, context) => {
    ctx = context;
    await sync.start();
    pi.events.emit(ACCOUNTS_SERVICE_EVENT, service);
  });
  pi.on("session_shutdown", async () => { await sync.stop(); ctx = undefined; });
  pi.events.on("pi-accounts:request-service", () => pi.events.emit(ACCOUNTS_SERVICE_EVENT, service));
  pi.events.emit(ACCOUNTS_SERVICE_EVENT, service);
}
