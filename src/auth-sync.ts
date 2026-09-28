import { watch, type FSWatcher } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { AccountStore } from "./store.ts";

type Result = Awaited<ReturnType<AccountStore["reconcileCurrentAccounts"]>>;
type WatchDirectory = (
  directory: string,
  listener: (event: string, filename: string | Buffer | null) => void,
) => FSWatcher;

export function createAuthSync(
  store: AccountStore,
  onChange: (result: Result) => void,
  onError: () => void,
  watchDirectory: WatchDirectory = (directory, listener) =>
    watch(directory, { persistent: false }, listener),
  now: () => number = () => performance.now(),
) {
  let watcher: FSWatcher | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let fallback: ReturnType<typeof setInterval> | undefined;
  let stopped = false;
  let failed = false;
  let lastStamp: string | undefined;
  let lastReconciledAt = 0;
  let lastRequestedAt = 0;
  let queue = Promise.resolve();
  let scheduled = false;
  let unknownEventsOnly = false;
  const fileStamp = async () => {
    const stamp = async (name: string) => {
      try {
        const info = await stat(join(store.directory, name), { bigint: true });
        return `${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
        throw error;
      }
    };
    return (await Promise.all([stamp("auth.json"), stamp("accounts.json")])).join("|");
  };
  // An already requested minute pass satisfies the timer while it is running.
  // File changes and failed passes still trigger another reconciliation.
  const needsReconcile = (stamp: string) =>
    failed || stamp !== lastStamp || now() - Math.max(lastReconciledAt, lastRequestedAt) >= 60_000;
  const reconcile = () => {
    if (stopped || scheduled) return queue;
    // A burst of watcher/fallback events needs one pending pass. An event that
    // arrives while a pass is running schedules one more pass after it.
    scheduled = true;
    lastRequestedAt = now();
    queue = queue.then(async () => {
      scheduled = false;
      if (stopped) return;
      // Capture the version before reconciliation. If another process writes
      // during it, the next fallback check still sees a different version.
      const stamp = await fileStamp().catch(() => undefined);
      let result: Result;
      try {
        result = await store.reconcileCurrentAccounts();
      } catch {
        const notify = !stopped && !failed;
        failed = true;
        if (notify) {
          try {
            onError();
          } catch {
            /* A broken notification UI must not poison the sync queue. */
          }
        }
        return;
      }
      failed = false;
      lastStamp = stamp;
      lastReconciledAt = now();
      if (!stopped && result.changed.length) {
        try {
          onChange(result);
        } catch {
          /* Storage was reconciled; a consumer callback cannot stop future syncs. */
        }
      }
    });
    return queue;
  };
  const schedule = (unknownFile = false) => {
    if (stopped) return;
    unknownEventsOnly = timer ? unknownEventsOnly && unknownFile : unknownFile;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      const checkStamp = unknownEventsOnly;
      unknownEventsOnly = false;
      if (!checkStamp) {
        void reconcile();
        return;
      }
      // An empty watcher filename can also describe an unrelated lock file.
      // Reconcile only when a tracked file changed or the fallback is due.
      void fileStamp().then(
        (stamp) => {
          if (!stopped && needsReconcile(stamp)) void reconcile();
        },
        () => {
          if (!stopped) void reconcile();
        },
      );
    }, 150);
    timer.unref();
  };
  const ensureWatcher = () => {
    if (stopped || watcher) return;
    try {
      // Watch the directory: auth.json and accounts.json are atomically replaced.
      const handle = watchDirectory(store.directory, (_event, filename) => {
        if (filename === null) schedule(true);
        else if (filename.toString() === "auth.json" || filename.toString() === "accounts.json")
          schedule();
      });
      watcher = handle;
      handle.on("error", () => {
        if (watcher === handle) watcher = undefined;
        try {
          handle.close();
        } catch {
          /* The failed handle may already be closed. */
        }
        schedule();
      });
      handle.on("close", () => {
        if (watcher !== handle) return;
        watcher = undefined;
        // Some watcher failures close the handle without an error event.
        // Reconcile once and reopen it on the next fallback check.
        schedule();
      });
    } catch {
      /* Periodic reconciliation remains available. */
    }
  };
  return {
    reconcile,
    schedule,
    async start() {
      // A session can start again after a prior shutdown. stop() has already
      // drained queued work, so re-arm the watcher and fallback on this call.
      stopped = false;
      await mkdir(store.directory, { recursive: true, mode: 0o700 });
      if (stopped) return;
      if (!fallback) {
        // Check cheap file metadata every five seconds. Retry failures and do
        // one full pass per minute even if metadata appears unchanged.
        fallback = setInterval(() => {
          ensureWatcher();
          void fileStamp().then(
            (stamp) => {
              if (!stopped && needsReconcile(stamp)) void reconcile();
            },
            () => {
              if (!stopped) void reconcile();
            },
          );
        }, 5000);
        fallback.unref();
      }
      ensureWatcher();
      await reconcile();
    },
    async stop() {
      stopped = true;
      watcher?.close();
      watcher = undefined;
      if (timer) clearTimeout(timer);
      timer = undefined;
      unknownEventsOnly = false;
      if (fallback) clearInterval(fallback);
      fallback = undefined;
      await queue;
    },
  };
}
