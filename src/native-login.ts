import { LoginDialogComponent, OAuthSelectorComponent, ExtensionSelectorComponent, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { AccountError } from "./store.ts";

type Provider = NonNullable<ReturnType<ExtensionCommandContext["modelRegistry"]["getProvider"]>>;
type Interaction = Parameters<NonNullable<Provider["auth"]["oauth"]>["login"]>[0];
export type LoginSelection = { provider: Provider; authType: "oauth" | "api_key" };

export async function selectLogin(ctx: ExtensionCommandContext, ids: string[], mode: "login" | "logout" = "login"): Promise<LoginSelection | undefined> {
  const options = ids.flatMap(id => {
    const provider = ctx.modelRegistry.getProvider(id);
    if (!provider) return [];
    const status = ctx.modelRegistry.getProviderAuthStatus(id);
    const common = { id, name: provider.name, status: status.configured ? { type: provider.auth.oauth ? "oauth" as const : "api_key" as const, source: status.label ?? status.source } : undefined };
    return [
      ...(provider.auth.oauth ? [{ ...common, authType: "oauth" as const, method: provider.auth.oauth }] : []),
      ...(provider.auth.apiKey ? [{ ...common, authType: "api_key" as const, method: provider.auth.apiKey }] : []),
    ];
  }).sort((a, b) => a.name.localeCompare(b.name));
  return ctx.ui.custom<LoginSelection | undefined>((_tui, _theme, _keys, done) => new OAuthSelectorComponent(mode, options,
    (id, authType) => { const provider = ctx.modelRegistry.getProvider(id); done(provider ? { provider, authType } : undefined); },
    () => done(undefined)));
}

async function cancellable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort: () => void = () => {};
  const cancelled = new Promise<never>((_resolve, reject) => { abort = () => reject(new Error("Login cancelled")); signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) abort(); });
  try { return await Promise.race([promise, cancelled]); }
  finally { signal.removeEventListener("abort", abort); }
}

export async function nativeLogin(ctx: ExtensionCommandContext, selection: LoginSelection): Promise<unknown> {
  const result = await ctx.ui.custom<{ credential?: unknown; failed?: boolean } | undefined>((tui, _theme, _keys, done) => {
    let finished = false;
    const finish = (value: { credential?: unknown; failed?: boolean } | undefined) => { if (!finished) { finished = true; done(value); } };
    const dialog = new LoginDialogComponent(tui, selection.provider.id, () => finish(undefined), selection.provider.name);
    dialog.focused = true;
    let view: Component = dialog;
    const interaction: Interaction = {
      signal: dialog.signal,
      prompt: async prompt => {
        const signal = prompt.signal ? AbortSignal.any([dialog.signal, prompt.signal]) : dialog.signal;
        signal.throwIfAborted();
        if (prompt.type === "select") {
          let selector: ExtensionSelectorComponent | undefined;
          try {
            return await cancellable(new Promise<string>((resolve, reject) => {
              selector = new ExtensionSelectorComponent(prompt.message, prompt.options.map(o => o.label), label => {
                const option = prompt.options.find(o => o.label === label);
                if (option) resolve(option.id); else reject(new Error("Login cancelled"));
              }, () => { dialog.handleInput("\u001b"); reject(new Error("Login cancelled")); }, { tui });
              view = selector;
              tui.requestRender();
            }), signal);
          } finally { selector?.dispose(); view = dialog; tui.requestRender(); }
        }
        return cancellable(prompt.type === "manual_code" ? dialog.showManualInput(prompt.message) : dialog.showPrompt(prompt.message, prompt.placeholder), signal);
      },
      notify: event => {
        if (finished) return;
        if (event.type === "auth_url") dialog.showAuth(event.url, event.instructions);
        else if (event.type === "device_code") { dialog.showDeviceCode(event); dialog.showWaiting("Waiting for authentication..."); }
        else if (event.type === "info") dialog.showInfo(event.message, event.links);
        else dialog.showProgress(event.message);
      },
    };
    queueMicrotask(async () => {
      try {
        const method = selection.authType === "oauth" ? selection.provider.auth.oauth : selection.provider.auth.apiKey;
        const credential = method?.login ? await method.login(interaction) : { type: "api_key", key: (await interaction.prompt({ type: "secret", message: `Enter ${selection.provider.name} API key:` })).trim() };
        dialog.signal.throwIfAborted();
        if (credential.type === "api_key" && "key" in credential && credential.key === "") throw new Error("Empty key");
        finish({ credential });
      } catch { finish(dialog.signal.aborted ? undefined : { failed: true }); }
    });
    return { render: width => view.render(width), invalidate: () => view.invalidate(), handleInput: data => view.handleInput?.(data), dispose: () => { dialog.handleInput("\u001b"); } };
  });
  if (result?.failed) throw new AccountError("Login failed. The current account was not changed. Try again.");
  return result?.credential;
}
