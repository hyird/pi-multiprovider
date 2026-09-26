import { watch, type FSWatcher } from "node:fs";
import { mkdir } from "node:fs/promises";
import { AccountStore } from "./store.ts";

type Result = Awaited<ReturnType<AccountStore["reconcileCurrentAccounts"]>>;

export function createAuthSync(store: AccountStore, onChange: (result: Result) => void, onError: () => void) {
  let watcher: FSWatcher | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let fallback: ReturnType<typeof setInterval> | undefined;
  let stopped = false;
  let failed = false;
  let queue = Promise.resolve();
  const reconcile = () => {
    queue = queue.then(async () => {
      if (stopped) return;
      try {
        const result = await store.reconcileCurrentAccounts();
        failed = false;
        if (!stopped && result.changed.length) onChange(result);
      } catch {
        if (!stopped && !failed) onError();
        failed = true;
      }
    });
    return queue;
  };
  const schedule = () => {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = undefined; void reconcile(); }, 150);
    timer.unref();
  };
  return {
    reconcile,
    schedule,
    async start() {
      await mkdir(store.directory, { recursive: true, mode: 0o700 });
      if (stopped) return;
      if (!fallback) {
        // Also recover from missed watch events, transient writes and watcher errors.
        fallback = setInterval(() => { void reconcile(); }, 5000);
        fallback.unref();
      }
      if (!watcher) {
        try {
          // Watch the directory: auth.json and accounts.json are atomically replaced.
          watcher = watch(store.directory, { persistent: false }, (_event, filename) => {
            if (filename === null || filename.toString() === "auth.json" || filename.toString() === "accounts.json") schedule();
          });
          watcher.on("error", () => { watcher?.close(); watcher = undefined; schedule(); });
        } catch { /* Periodic reconciliation remains available. */ }
      }
      await reconcile();
    },
    async stop() {
      stopped = true;
      watcher?.close();
      if (timer) clearTimeout(timer);
      if (fallback) clearInterval(fallback);
      await queue;
    },
  };
}
