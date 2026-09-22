import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { AccountError, AccountStore, validateLabel } from "./store.ts";

type Context = ExtensionCommandContext;
type Provider = NonNullable<ReturnType<Context["modelRegistry"]["getProvider"]>>;
type Interaction = Parameters<NonNullable<Provider["auth"]["oauth"]>["login"]>[0];

export async function activate(pi: ExtensionAPI, ctx: Context, store: AccountStore, provider: string, name: string) {
  if (!ctx.isIdle()) throw new AccountError("A request is running. Try again when it finishes.");
  await store.use(provider, name);
  try {
    const result = await ctx.modelRegistry.refresh({ providers: [provider], allowNetwork: false });
    if (result.errors.size || result.aborted) throw new Error("Refresh incomplete");
    pi.events.emit("pi-accounts:changed", { provider, name });
    ctx.ui.notify(`Switched permanently to ${provider} / ${name}. Effective on the next request.`, "info");
  } catch {
    ctx.ui.notify("Account selection was saved, but runtime refresh failed. Retry the switch before continuing.", "warning");
  }
}

export async function loginAccount(ctx: Context, provider: Provider): Promise<unknown> {
  const methods = [
    ...(provider.auth.oauth ? [{ label: "Browser / OAuth login", method: provider.auth.oauth }] : []),
    ...(provider.auth.apiKey ? [{ label: "API key login", method: { login: provider.auth.apiKey.login ?? (async (interaction: Interaction) => {
      const key = (await interaction.prompt({ type: "secret", message: "API key" })).trim();
      if (!key) throw new AccountError("An API key is required.");
      return { type: "api_key" as const, key };
    }) } }] : []),
  ];
  if (!methods.length) throw new AccountError("This provider does not support interactive login. You can save its current credentials.");
  const choice = methods.length === 1 ? methods[0]!.label : await ctx.ui.select("Select authentication method", methods.map(m => m.label));
  const method = methods.find(m => m.label === choice)?.method;
  if (!method?.login) return;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10 * 60 * 1000);
  let promptActive = false;
  const unsubscribe = ctx.ui.onTerminalInput(data => {
    if (data === "\u001b" && !promptActive) { controller.abort(); return { consume: true }; }
    return undefined;
  });
  const interaction: Interaction = {
    signal: controller.signal,
    prompt: async prompt => {
      const signal = prompt.signal ? AbortSignal.any([controller.signal, prompt.signal]) : controller.signal;
      signal.throwIfAborted();
      promptActive = true;
      try {
        let result: string | undefined;
        if (prompt.type === "select") {
          const labels = prompt.options.map(o => o.label);
          const selected = await ctx.ui.select(prompt.message, labels, { signal });
          result = prompt.options[labels.indexOf(selected ?? "")]?.id;
        } else {
          result = await ctx.ui.input(prompt.message, prompt.placeholder, { signal });
        }
        // A callback can cancel its manual-code prompt without cancelling the login.
        signal.throwIfAborted();
        if (result === undefined) { controller.abort(); throw new AccountError("Login cancelled."); }
        return result;
      } finally { promptActive = false; }
    },
    notify: event => {
      if (event.type === "auth_url") ctx.ui.notify(`Open this URL to sign in:\n${event.url}\n${event.instructions ?? ""}`, "info");
      else if (event.type === "device_code") ctx.ui.notify(`Open ${event.verificationUri}\nVerification code: ${event.userCode}\nWaiting for authorization. Press Esc to cancel.`, "info");
      else ctx.ui.notify(event.message + (event.type === "info" ? (event.links ?? []).map(link => `\n${link.label ?? ""} ${link.url}`).join("") : ""), "info");
    },
  };
  try {
    const result = await method.login(interaction);
    controller.signal.throwIfAborted();
    return result;
  } catch {
    throw new AccountError(controller.signal.aborted ? "Login cancelled or timed out. The current account was not changed." : "Login failed. The current account was not changed. Try again.");
  } finally { clearTimeout(timeout); unsubscribe(); }
}

function reportError(ctx: Context, error: unknown) {
  ctx.ui.notify(error instanceof AccountError ? error.message : "Account operation failed. Check file permissions or try again.", "error");
}

async function addAccount(pi: ExtensionAPI, ctx: Context, store: AccountStore, provider: string): Promise<boolean> {
  const label = (await ctx.ui.input("Account label", "e.g. work / personal"))?.trim();
  if (!label) return false;
  validateLabel(label);
  if ((await store.list(provider)).some(a => a.name === label)) throw new AccountError("This label already exists. Choose a different label.");
  const definition = ctx.modelRegistry.getProvider(provider);
  if (!definition) throw new AccountError("No login method was found for this provider.");
  const value = await loginAccount(ctx, definition);
  if (!value) return false;
  await store.add(provider, label, value);
  await activate(pi, ctx, store, provider, label);
  return true;
}

async function providerMenu(pi: ExtensionAPI, ctx: Context, store: AccountStore, provider: string) {
  while (true) {
    const accounts = await store.list(provider);
    const active = accounts.find(a => a.active)?.name ?? "Pi default (not saved)";
    const rows = accounts.map(a => `${a.active ? "● " : "○ "}${a.name}`);
    const action = await ctx.ui.select(`${provider}\nActive: ${active} · Select an account / API key to switch`, [...rows, "Add account / API key", "Edit label", "Save current login", "Remove account", "Back"]);
    if (!action || action === "Back") return;
    try {
      if (!ctx.isIdle()) throw new AccountError("A request is running. Try again when it finishes.");
      if (action === "Add account / API key") await addAccount(pi, ctx, store, provider);
      else if (action === "Edit label" || action === "Remove account") {
        if (!accounts.length) { ctx.ui.notify("No saved accounts yet.", "info"); continue; }
        const selected = await ctx.ui.select(action, rows);
        const account = accounts[rows.indexOf(selected ?? "")];
        if (!account) continue;
        if (action === "Edit label") {
          const label = (await ctx.ui.input(`Edit label: ${account.name}`, "Enter a new label"))?.trim();
          if (!label) continue;
          await store.rename(provider, account.name, label);
          if (account.active) pi.events.emit("pi-accounts:changed", { provider, name: label });
          ctx.ui.notify(`Label updated: ${label}`, "info");
        } else if (await ctx.ui.confirm("Remove account", `Remove the saved credentials for ${account.name}?`)) {
          await store.remove(provider, account.name);
        }
      }
      else if (action === "Save current login") {
        const label = (await ctx.ui.input("Account label", "e.g. work / personal"))?.trim();
        if (!label) continue;
        await store.save(provider, label);
        ctx.ui.notify(`Saved account: ${label}`, "info");
      } else {
        const account = accounts[rows.indexOf(action)];
        if (account) await activate(pi, ctx, store, provider, account.name);
      }
    } catch (error) { reportError(ctx, error); }
  }
}

export async function accountMenu(pi: ExtensionAPI, ctx: Context, store: AccountStore, initialProvider?: string) {
  if (!ctx.hasUI) throw new AccountError("The account manager requires an interactive terminal. Use /accounts list <provider> instead.");
  if (initialProvider) await providerMenu(pi, ctx, store, initialProvider);
  while (true) {
    const providers = (await store.providers()).sort();
    const selected = await ctx.ui.select("Accounts · Providers", [...providers, "Add provider"]);
    if (!selected) return;
    try {
      if (selected === "Add provider") {
        const available = [...new Set([...ctx.modelRegistry.getAll().map(m => m.provider), ...ctx.modelRegistry.getRegisteredProviderIds()])]
          .filter(id => !providers.includes(id)).sort();
        if (!available.length) { ctx.ui.notify("All available providers have already been added.", "info"); continue; }
        const provider = await ctx.ui.select("Add provider", available);
        if (!provider) continue;
        if (await addAccount(pi, ctx, store, provider)) await providerMenu(pi, ctx, store, provider);
      } else await providerMenu(pi, ctx, store, selected);
    } catch (error) { reportError(ctx, error); }
  }
}
