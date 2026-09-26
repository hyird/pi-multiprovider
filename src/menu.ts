import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { AccountError, AccountStore } from "./store.ts";
import { providerChoices, selectMenu } from "./selector.ts";

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

export async function runAccountCommand(pi: ExtensionAPI, ctx: Context, store: AccountStore, explicitProvider?: string, explicitLabel?: string) {
  const title = "Switch account";
  const stored = await store.providers();
  const ids = stored;
  if (!ids.length) throw new AccountError("No saved accounts. Use /login to sign in.");
  if (!ctx.hasUI && (!explicitProvider || !explicitLabel)) throw new AccountError("This command requires an interactive terminal.");
  const choices = providerChoices(ctx, ids);
  for (const item of choices) {
    const saved = await store.list(item.id);
    item.value = saved.find(a => a.active)?.name ?? (stored.includes(item.id) ? "Pi default" : "Not signed in");
    item.description = `${saved.length} saved accounts · ${item.id}`;
  }
  const provider = explicitProvider ?? await selectMenu(ctx, `${title}  /  Providers`, choices);
  if (!provider) return;
  if (!ids.includes(provider)) throw new AccountError("Provider not found.");
  if (!ctx.isIdle()) throw new AccountError("A request is running. Try again when it finishes.");
  const displayName = ctx.modelRegistry.getProviderDisplayName(provider);
  await store.ensureCurrent(provider);
  let accounts = await store.list(provider);
  const accountChoices = () => accounts.map(a => ({
    id: `account:${a.name}`, label: a.name, value: a.active ? "Active" : "Saved",
    description: "Switch permanently, then close this menu.",
    editId: `label:${a.name}`,
  }));
  let selection = explicitLabel === undefined
    ? await selectMenu(ctx, `${title}  /  ${displayName}`, accountChoices())
    : `account:${explicitLabel}`;
  while (selection?.startsWith("label:")) {
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
  await activate(pi, ctx, store, provider, name);
}
