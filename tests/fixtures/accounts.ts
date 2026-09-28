import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AccountStore } from "../../src/store.ts";

/** Prepare storage directly; fixtures do not implement account operations. */
export async function seedAccount(
  store: AccountStore,
  provider: string,
  name: string,
  credential?: unknown,
): Promise<void> {
  if (credential === undefined) {
    const auth = JSON.parse(await readFile(join(store.directory, "auth.json"), "utf8"));
    credential = auth[provider];
  }
  const path = join(store.directory, "accounts.json");
  const pool = JSON.parse(
    await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return '{"version":1,"accounts":[]}';
    }),
  );
  const index = pool.accounts.findIndex(
    (account: { provider: string; name: string }) =>
      account.provider === provider && account.name === name,
  );
  const account = { provider, name, credential };
  if (index < 0) pool.accounts.push(account);
  else pool.accounts[index] = account;
  await writeFile(path, JSON.stringify(pool));
}

export async function replaceAccount(
  store: AccountStore,
  provider: string,
  name: string,
  credential: unknown,
): Promise<void> {
  await seedAccount(store, provider, name, credential);
  const path = join(store.directory, "auth.json");
  const auth = JSON.parse(
    await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return "{}";
    }),
  );
  auth[provider] = credential;
  await writeFile(path, JSON.stringify(auth));
}
