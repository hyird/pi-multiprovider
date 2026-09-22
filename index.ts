import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { AccountError, AccountStore } from "./src/store.ts";
import { runAccountCommand, type AccountCommand } from "./src/menu.ts";
import { registerUsageService } from "./src/usage-service.ts";

export default function accounts(pi: ExtensionAPI) {
  const store = new AccountStore(getAgentDir());
  registerUsageService(pi, store);
  let busy = false;
  const commands: { name: string; action: AccountCommand; description: string }[] = [
    { name: "multilogin", action: "login", description: "Sign in to a provider and label the account" },
    { name: "multilogout", action: "logout", description: "Remove a saved login or API key" },
    { name: "switch-account", action: "switch", description: "Switch accounts permanently and close" },
  ];
  for (const command of commands) pi.registerCommand(command.name, {
    description: command.description,
    handler: async (args, ctx) => {
      if (busy || !ctx.isIdle()) { ctx.ui.notify("Wait for the current request to finish.", "warning"); return; }
      busy = true;
      try {
        const [provider, ...label] = args.trim().split(/\s+/).filter(Boolean);
        await runAccountCommand(pi, ctx, store, command.action, provider, label.join(" ") || undefined);
      } catch (error) {
        ctx.ui.notify(error instanceof AccountError ? error.message : "Account operation failed. Check permissions or try again.", "error");
      } finally { busy = false; }
    },
  });
}
