import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { AccountError, AccountStore, validateLabel } from "./store.ts";
import { providerChoices, selectMenu } from "./selector.ts";
import { nativeLogin, selectLogin } from "./native-login.ts";

type Context = ExtensionCommandContext;



export async function activate(pi: ExtensionAPI, ctx: Context, store: AccountStore, provider: string, name: string) {
  if (!ctx.isIdle()) throw new AccountError("A request is running. Try again when it finishes.");
  await store.use(provider, name);
  try {
    const result = await ctx.modelRegistry.refresh({ providers: [provider], allowNetwork: false });
    if (result.errors.size || result.aborted) throw new Error("Refresh incomplete");
    pi.events.emit("pi-accounts:changed", { provider, name });
    ctx.ui.notify(`Switched permanently to ${ctx.modelRegistry.getProviderDisplayName(provider)} / ${name}. Effective on the next request.`, "info");
  } catch {
    ctx.ui.notify("Account selection was saved, but runtime refresh failed. Retry the switch before continuing.", "warning");
  }
}

export type AccountCommand = "login" | "logout" | "switch";

export async function runAccountCommand(pi: ExtensionAPI, ctx: Context, store: AccountStore, command: AccountCommand, explicitProvider?: string, explicitLabel?: string) {
  const title = command === "login" ? "Sign in" : command === "logout" ? "Sign out" : "Switch account";
  const stored = await store.providers();
  const ids = command === "login"
    ? [...new Set([...ctx.modelRegistry.getAll().map(m => m.provider), ...ctx.modelRegistry.getRegisteredProviderIds(), ...stored])]
      .filter(id => { const auth = ctx.modelRegistry.getProvider(id)?.auth; return !!(auth?.oauth || auth?.apiKey); })
    : stored;
  if (!ids.length) throw new AccountError(command === "login" ? "No login providers are available." : "No saved accounts. Use /multilogin to sign in.");
  if (!ctx.hasUI && (!explicitProvider || !explicitLabel || command !== "switch")) throw new AccountError("This command requires an interactive terminal.");
  const choices = providerChoices(ctx, ids);
  for (const item of choices) {
    const saved = await store.list(item.id);
    item.value = saved.find(a => a.active)?.name ?? (stored.includes(item.id) ? "Pi default" : "Not signed in");
    item.description = command === "login" ? "Sign in with OAuth or an API key." : `${saved.length} saved accounts · ${item.id}`;
  }
  const loginSelection = command !== "switch" ? await selectLogin(ctx, explicitProvider ? ids.filter(id => id === explicitProvider) : ids, command === "login" ? "login" : "logout") : undefined;
  if (command !== "switch" && !loginSelection) return;
  const provider = loginSelection?.provider.id ?? explicitProvider ?? await selectMenu(ctx, `${title}  /  Providers`, choices);
  if (!provider) return;
  if (!ids.includes(provider)) throw new AccountError("Provider not found.");
  if (!ctx.isIdle()) throw new AccountError("A request is running. Try again when it finishes.");
  const displayName = ctx.modelRegistry.getProviderDisplayName(provider);
  if (command === "login") {
    await store.ensureCurrent(provider);
    const accounts = await store.list(provider);
    let initialLabel = "default";
    let suffix = 2;
    while (accounts.some(a => a.name === initialLabel)) initialLabel = `default-${suffix++}`;
    const value = await nativeLogin(ctx, loginSelection!);
    if (!value) return;
    const requestedLabel = explicitLabel ?? await ctx.ui.input("Account label (optional)", initialLabel);
    const label = requestedLabel?.trim() || initialLabel;
    validateLabel(label);
    await store.saveLogin(provider, label, value);
    await activate(pi, ctx, store, provider, label);
    return;
  }
  await store.ensureCurrent(provider);
  let accounts = await store.list(provider);
  const accountChoices = () => accounts.map(a => ({
    id: `account:${a.name}`, label: a.name, value: a.active ? "Active" : "Saved",
    description: command === "switch" ? "Switch permanently, then close this menu." : "Remove this saved login from Pi.",
    danger: command === "logout",
    editId: command === "switch" ? `label:${a.name}` : undefined,
  }));
  let selection = explicitLabel === undefined
    ? await selectMenu(ctx, `${title}  /  ${displayName}`, accountChoices())
    : `account:${explicitLabel}`;
  while (command === "switch" && selection?.startsWith("label:")) {
    const selected = selection.slice("label:".length);
    if (!accounts.some(a => a.name === selected)) throw new AccountError("Account not found.");
    const label = (await ctx.ui.input("Edit label", selected))?.trim();
    if (label) {
      if (!ctx.isIdle()) throw new AccountError("A request is running. Try again when it finishes.");
      await store.rename(provider, selected, label);
      if (accounts.find(a => a.name === selected)?.active) pi.events.emit("pi-accounts:changed", { provider, name: label });
      ctx.ui.notify(`Label updated: ${label}.`, "info");
    }
    accounts = await store.list(provider);
    selection = await selectMenu(ctx, `${title}  /  ${displayName}`, accountChoices());
  }
  const name = selection?.slice("account:".length);
  if (!name) return;
  if (!accounts.some(a => a.name === name)) throw new AccountError("Account not found.");
  if (!ctx.isIdle()) throw new AccountError("A request is running. Try again when it finishes.");
  if (command === "switch") { await activate(pi, ctx, store, provider, name); return; }
  if (!await ctx.ui.confirm("Sign out", `Remove ${displayName} / ${name}? If active, its current Pi login will also be removed.`)) return;
  await store.logout(provider, name);
  const result = await ctx.modelRegistry.refresh({ providers: [provider], allowNetwork: false });
  pi.events.emit("pi-accounts:changed", { provider });
  const failed = result.errors.size > 0 || result.aborted;
  ctx.ui.notify(failed ? "Signed out, but runtime refresh failed. Reload Pi before continuing." : `Signed out of ${displayName} / ${name}.`, failed ? "warning" : "info");
}
