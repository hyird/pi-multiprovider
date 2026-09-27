import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { AccountError, AccountStore } from "./src/store.ts";
import { runAccountCommand } from "./src/menu.ts";
import { registerUsageService } from "./src/usage-service.ts";

export default function accounts(pi: ExtensionAPI) {
  // OMP children use Pi's auth.json directly. Only the parent should watch and
  // reconcile the shared account pool or expose account-switching UI.
  if (process.env.PI_OMP_CHILD === "1") return;
  const store = new AccountStore(getAgentDir());
  registerUsageService(pi, store);
  let busy = false;
  pi.registerCommand("switch-account", {
    description: "Switch or rename saved accounts",
    handler: async (args, ctx) => {
      if (busy || !ctx.isIdle()) { ctx.ui.notify("Wait for the current request to finish.", "warning"); return; }
      busy = true;
      try {
        const input = args.trim();
        const separator = input.search(/\s/);
        const provider = separator < 0 ? input : input.slice(0, separator);
        const label = separator < 0 ? undefined : input.slice(separator).trim();
        await runAccountCommand(pi, ctx, store, provider || undefined, label || undefined);
      } catch (error) {
        ctx.ui.notify(error instanceof AccountError ? error.message : "Account operation failed. Check permissions or try again.", "error");
      } finally { busy = false; }
    },
  });
}
