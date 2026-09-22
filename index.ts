import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { AccountError, AccountStore } from "./src/store.ts";
import { accountMenu, activate } from "./src/menu.ts";
import { selectMenu } from "./src/selector.ts";

export default function accounts(pi: ExtensionAPI) {
  const store = new AccountStore(getAgentDir());
  let busy = false;
  pi.registerCommand("accounts", {
    description: "Manage accounts: add, switch permanently, and edit labels",
    handler: async (args, ctx) => {
      if (busy || !ctx.isIdle()) {
        ctx.ui.notify("Wait for the current request to finish before managing accounts.", "warning");
        return;
      }
      busy = true;
      try {
        const [action = "menu", explicitProvider, ...rest] = args.trim().split(/\s+/).filter(Boolean);
        const provider = explicitProvider ?? ctx.model?.provider;
        if (action === "menu") {
          await accountMenu(pi, ctx, store, explicitProvider);
          return;
        }
        if (!provider) throw new AccountError("Specify a provider, for example /accounts list openai-codex.");
        const name = rest.join(" ");
        if (action === "save") {
          const label = name || (ctx.hasUI ? await ctx.ui.input("Save current account", "e.g. work / personal") : undefined);
          if (!label) return;
          await store.save(provider, label.trim());
          ctx.ui.notify(`Saved ${provider} / ${label}.`, "info");
        } else if (action === "remove") {
          if (!name) throw new AccountError("Usage: /accounts remove <provider> <name>");
          await store.remove(provider, name);
          ctx.ui.notify(`Removed saved account ${name}.`, "info");
        } else if (action === "use" || action === "list") {
          const saved = await store.list(provider);
          if (!saved.length) throw new AccountError(`No saved accounts. Run /login ${provider}, then /accounts save ${provider} <name>.`);
          if (action === "list" || (!ctx.hasUI && !name)) {
            ctx.ui.notify(`${ctx.modelRegistry.getProviderDisplayName(provider)}\n${saved.map(a => `${a.active ? "●" : "○"} ${a.name}`).join("\n")}`, "info");
            return;
          }
          const choices = saved.map(a => `${a.active ? "● " : "○ "}${a.name}`);
          const chosen = name ? undefined : await selectMenu(ctx, `Switch ${ctx.modelRegistry.getProviderDisplayName(provider)} account (persistent)`, choices);
          const target = name || saved[choices.indexOf(chosen ?? "")]?.name;
          if (!target) return;
          await activate(pi, ctx, store, provider, target);
        } else throw new AccountError("Usage: /accounts [list|save|use|remove] [provider] [name]");
      } catch (error) {
        // Raw I/O or parser errors can contain credential material; don't print them.
        ctx.ui.notify(error instanceof AccountError ? error.message : "Account operation failed. Check file permissions or try again.", "error");
      } finally { busy = false; }
    },
  });
}
