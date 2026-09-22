import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { AccountError, AccountStore, validateLabel } from "./store.ts";
import { providerChoices, selectMenu } from "./selector.ts";

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
    ctx.ui.notify(`Switched permanently to ${ctx.modelRegistry.getProviderDisplayName(provider)} / ${name}. Effective on the next request.`, "info");
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
    await store.ensureCurrent(provider);
    const accounts = await store.list(provider);
    const active = accounts.find(a => a.active);
    const action = await selectMenu(ctx, ctx.modelRegistry.getProviderDisplayName(provider), [
      { id: "label", label: `Label    ${active?.name ?? "default"}` },
      { id: "switch", label: `Switch   ${active?.name ?? "Not signed in"}` },
      { id: "back", label: "Back" },
    ]);
    if (!action || action === "back") return;
    try {
      if (!ctx.isIdle()) throw new AccountError("A request is running. Try again when it finishes.");
      if (action === "label") {
        if (!active) throw new AccountError("Select an account before editing its label.");
        const label = (await ctx.ui.input("Label", active.name))?.trim();
        if (!label) continue;
        await store.rename(provider, active.name, label);
        pi.events.emit("pi-accounts:changed", { provider, name: label });
      } else {
        if (!accounts.length) { ctx.ui.notify("No saved accounts yet. Use Add provider to sign in.", "info"); continue; }
        const name = await selectMenu(ctx, "Switch account / API key", accounts.map(a => ({ id: a.name, label: `${a.active ? "● " : "○ "}${a.name}` })));
        if (!name) continue;
        await activate(pi, ctx, store, provider, name);
      }
    } catch (error) { reportError(ctx, error); }
  }
}
export async function accountMenu(pi: ExtensionAPI, ctx: Context, store: AccountStore, initialProvider?: string) {
  if (!ctx.hasUI) throw new AccountError("The account manager requires an interactive terminal. Use /accounts list <provider> instead.");
  if (initialProvider) await providerMenu(pi, ctx, store, initialProvider);
  while (true) {
    const providers = (await store.providers()).sort();
    const selected = await selectMenu(ctx, "Accounts · Providers", [...providerChoices(ctx, providers), { id: "add-provider", label: "Add provider" }, { id: "remove-provider", label: "Remove provider" }]);
    if (!selected) return;
    try {
      if (!ctx.isIdle()) throw new AccountError("A request is running. Try again when it finishes.");
      if (selected === "remove-provider") {
        if (!providers.length) { ctx.ui.notify("No providers to remove.", "info"); continue; }
        const provider = await selectMenu(ctx, "Remove provider", providerChoices(ctx, providers));
        if (!provider) continue;
        if (!await ctx.ui.confirm("Remove provider", `Remove all saved accounts and the current Pi login for ${ctx.modelRegistry.getProviderDisplayName(provider)}?`)) continue;
        await store.removeProvider(provider);
        const result = await ctx.modelRegistry.refresh({ providers: [provider], allowNetwork: false });
        pi.events.emit("pi-accounts:changed", { provider });
        ctx.ui.notify(result.errors.size || result.aborted ? "Provider removed, but runtime refresh failed. Reload Pi before continuing." : "Provider removed.", result.errors.size || result.aborted ? "warning" : "info");
      } else if (selected === "add-provider") {
        const available = [...new Set([...ctx.modelRegistry.getAll().map(m => m.provider), ...ctx.modelRegistry.getRegisteredProviderIds(), ...providers])];
        if (!available.length) { ctx.ui.notify("No providers are available. Register a provider in Pi first.", "info"); continue; }
        const provider = await selectMenu(ctx, "Add provider", providerChoices(ctx, available));
        if (!provider) continue;
        if (await addAccount(pi, ctx, store, provider)) await providerMenu(pi, ctx, store, provider);
      } else await providerMenu(pi, ctx, store, selected);
    } catch (error) { reportError(ctx, error); }
  }
}
