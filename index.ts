import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { AccountError, AccountStore } from "./src/store.ts";
import { runAccountCommand } from "./src/menu.ts";
import { registerUsageService } from "./src/usage-service.ts";

export default function accounts(pi: ExtensionAPI) {
  const store = new AccountStore(getAgentDir());
  registerUsageService(pi, store);
  let busy = false;
  pi.registerCommand("switch-account", {
    description: "Switch or rename saved accounts",
    handler: async (args, ctx) => {
      if (busy || !ctx.isIdle()) { ctx.ui.notify("Wait for the current request to finish.", "warning"); return; }
      busy = true;
      try {
        const [provider, ...label] = args.trim().split(/\s+/).filter(Boolean);
        await runAccountCommand(pi, ctx, store, provider, label.join(" ") || undefined);
      } catch (error) {
        ctx.ui.notify(error instanceof AccountError ? error.message : "Account operation failed. Check permissions or try again.", "error");
      } finally { busy = false; }
    },
  });
}
