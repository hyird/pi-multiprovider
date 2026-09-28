import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { AccountError, AccountStore } from "./store.ts";
import { providerChoices, selectMenu } from "./selector.ts";

type Context = ExtensionCommandContext;

export async function activate(
  pi: ExtensionAPI,
  ctx: Context,
  store: AccountStore,
  provider: string,
  name: string,
) {
  if (!ctx.isIdle()) throw new AccountError("A request is running. Try again when it finishes.");
  const { credentialChanged, preferredLabelChanged, email } = await store.use(provider, name);
  try {
    const result = await ctx.modelRegistry.refresh({ providers: [provider], allowNetwork: false });
    if (result.errors.size || result.aborted) throw new Error("Refresh incomplete");
    ctx.ui.notify(
      `Switched permanently to ${ctx.modelRegistry.getProviderDisplayName(provider)} / ${email ?? name}. Effective on the next request.`,
      "info",
    );
  } catch {
    ctx.ui.notify(
      "Account selection was saved, but runtime refresh failed. Retry the switch before continuing.",
      "warning",
    );
  } finally {
    // Storage is already authoritative. Notify after refresh settles so usage
    // readers cannot race it, including when the refresh failed.
    try {
      pi.events.emit("pi-accounts:changed", {
        provider,
        name,
        forceNotify: true,
        ...(credentialChanged
          ? { storageChanged: true }
          : preferredLabelChanged
            ? { kind: "metadata", storageChanged: true }
            : {}),
      });
    } catch {
      /* The auth.json watcher still reconciles a committed switch. */
    }
  }
}

export async function runAccountCommand(
  pi: ExtensionAPI,
  ctx: Context,
  store: AccountStore,
  explicitProvider?: string,
  explicitLabel?: string,
) {
  const title = "Switch account";
  const { providers: stored, accounts: menuAccounts } = await store.menuSnapshot();
  const ids = stored;
  if (!ids.length) throw new AccountError("No saved accounts. Use /login to sign in.");
  if (!ctx.hasUI && (!explicitProvider || !explicitLabel))
    throw new AccountError("This command requires an interactive terminal.");
  const choices = providerChoices(ctx, ids);
  const accountsByProvider = new Map<string, typeof menuAccounts>();
  for (const account of menuAccounts) {
    const saved = accountsByProvider.get(account.provider) ?? [];
    saved.push(account);
    accountsByProvider.set(account.provider, saved);
  }
  for (const item of choices) {
    const saved = accountsByProvider.get(item.id) ?? [];
    const active = saved.find((a) => a.active);
    item.value =
      active?.email ?? active?.name ?? (stored.includes(item.id) ? "Pi default" : "Not signed in");
    item.description = `${saved.length} saved accounts · ${item.id}`;
  }
  const provider = explicitProvider ?? (await selectMenu(ctx, `${title}  /  Providers`, choices));
  if (!provider) return;
  if (!ids.includes(provider)) throw new AccountError("Provider not found.");
  if (!ctx.isIdle()) throw new AccountError("A request is running. Try again when it finishes.");
  const displayName = ctx.modelRegistry.getProviderDisplayName(provider);
  await store.ensureCurrent(provider);
  let accounts = await store.list(provider);
  const accountChoices = () => {
    const emailCounts = new Map<string, number>();
    for (const account of accounts) {
      if (account.email) emailCounts.set(account.email, (emailCounts.get(account.email) ?? 0) + 1);
    }
    return accounts.map((a) => ({
      id: `account:${a.name}`,
      label: a.email ?? a.name,
      value: `${a.active ? "Active" : "Saved"}${a.email && (emailCounts.get(a.email) ?? 0) > 1 ? ` · ${a.name}` : ""}`,
      description: a.email
        ? `${a.email} · Switch permanently, then close this menu.`
        : "Switch permanently, then close this menu. Ctrl+E edits the label.",
      editId: a.email ? undefined : `label:${a.name}`,
    }));
  };
  let selection =
    explicitLabel === undefined
      ? await selectMenu(ctx, `${title}  /  ${displayName}`, accountChoices())
      : `account:${explicitLabel}`;
  while (selection?.startsWith("label:")) {
    const selected = selection.slice("label:".length);
    if (!accounts.some((a) => a.name === selected)) throw new AccountError("Account not found.");
    if (accounts.find((a) => a.name === selected)?.email)
      throw new AccountError("This account uses its email as the display name.");
    const label = (await ctx.ui.input("Edit label", selected))?.trim();
    if (label) {
      if (!ctx.isIdle())
        throw new AccountError("A request is running. Try again when it finishes.");
      await store.rename(provider, selected, label);
      // Saved-account reports also show inactive labels. Reconcile the roster
      // immediately and keep the credential's quota cache warm.
      try {
        pi.events.emit("pi-accounts:changed", {
          provider,
          name: label,
          kind: "metadata",
          storageChanged: true,
        });
      } catch {
        /* The accounts.json watcher still reconciles a committed rename. */
      }
      ctx.ui.notify(`Label updated: ${label}.`, "info");
    }
    accounts = await store.list(provider);
    selection = await selectMenu(ctx, `${title}  /  ${displayName}`, accountChoices());
  }
  const name = selection?.slice("account:".length);
  if (!name) return;
  if (!accounts.some((a) => a.name === name)) throw new AccountError("Account not found.");
  if (!ctx.isIdle()) throw new AccountError("A request is running. Try again when it finishes.");
  await activate(pi, ctx, store, provider, name);
}
