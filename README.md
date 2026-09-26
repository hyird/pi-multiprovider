# pi-multiprovider

Persistent multi-account switching for Pi 0.87.0. Automatic synchronization with native Pi login/logout and permanent account switching. All interface text is in English.

## Install

```text
pi install git:github.com/hyird/pi-multiprovider
```

Run `/reload` once after installing or updating. Switching accounts never requires a reload.

## Commands

| Command | Interaction |
| --- | --- |
| `/login` (native Pi) | Sign in; the extension automatically saves the account |
| `/logout` (native Pi) | Sign out; the extension removes the just-logged-out saved account |
| `/switch-account` | Provider → saved account/API key → switch, notify, close |

To change a label, run `/switch-account`, choose a provider, highlight an account, and press **Ctrl+E**. Enter the new label and press Enter to save. This updates only the saved label; it does not switch accounts or modify Pi's current credentials. Esc cancels. Labels must be unique within a provider. Pressing Enter on an account still switches immediately.

Login uses Pi’s built-in `/login`. New accounts are saved automatically; no label input is required.

You can specify a provider ID and a label directly:

```text
/switch-account openai-codex work
```

To remove a saved account, select it with `/switch-account`, then use native `/logout` for its provider. While running, the extension detects the removed current login and deletes matching saved aliases. Other accounts remain available. `/switch-account` only switches and renames accounts; it has no delete action.

Switching writes the selected credentials to the global `auth.json`, refreshes Pi's existing runtime, displays a confirmation, and closes the menu. The choice persists across new sessions and restarts until you explicitly change it. No automatic rotation or failover is performed. Account switching does not change your model; choose another provider's model using `/model`.

## Interface

Provider names come directly from Pi. The login/logout provider pickers and login dialog are native Pi components. Account and switch pickers use theme colors, borders, aligned status columns, contextual descriptions, and fuzzy search. Long lists have a bounded viewport with arrows, Page Up/Down, Home/End, and mouse-wheel navigation. Small terminals use a compact layout.

The interaction is inspired by [pi-multiprovider](https://pi.dev/packages/pi-multiprovider). This extension focuses on persistent manual selection.

## Native commands

Pi 0.87 does not allow extensions to replace or hide its built-in `/login` and `/logout` commands. They remain available:

- Native `/login` replaces Pi's current credential. The extension automatically synchronizes it into the account pool: recognized accounts retain their labels and receive updated tokens; new or unrecognizable accounts get an unused `default`, `default-2`, etc. label. Rename them with `/switch-account`. New accounts produce one notification, and account/usage listeners refresh after synchronization.
- Native `/logout` clears the current Pi login. While the extension is running, synchronization removes that account's saved records, including matching aliases, and preserves other accounts. Logouts while the extension is stopped are not cleaned up at startup.

Synchronization runs at session startup and watches the agent directory for atomic replacements of `auth.json` and `accounts.json`. Changes are debounced, with a five-second fallback for missed events or temporary errors. Repeated events and the extension's own writes do not repeat change notifications. A previously observed provider entry disappearing from a valid auth file is treated as logout; startup, missing files and corrupt JSON do not delete saved accounts. Synchronization only updates the account pool; it never restores a logged-out credential. Usage queries do not import accounts. A native login that is overwritten again before synchronization cannot be recovered.

The old `/accounts` command is no longer registered.

## Storage

Default files: `~/.pi/agent/auth.json` (current Pi credentials) and `~/.pi/agent/accounts.json` (saved accounts). Both respect `PI_CODING_AGENT_DIR`. These files contain secrets; do not share or commit them.

The extension uses Pi's auth-file lock and atomic replacement. Before switching it preserves current credentials, including refreshed OAuth tokens when their identity is recognizable. Opaque tokens without stable identity are conservatively backed up separately. Expired credentials that cannot refresh require login again.

Environment-only authentication, CLI runtime overrides, and independent account pools from other extensions are outside this plugin's control. In-flight requests in another process are not interrupted. Account operations are blocked while the current agent is busy.

## Usage integration

With the latest [pi-better-usage](https://github.com/hyird/pi-better-usage), switching accounts immediately clears the old usage and refreshes the footer with the new account's label. `/usage` reports every saved account, including labels, per-account failures, and a `[Current]` marker based on `auth.json`.

The account in `auth.json` is authoritative. If it does not match any saved account, usage shows a separate **Unmanaged [Current]** entry. Reading usage does not import it into the account pool. Switching explicitly still preserves the outgoing credentials before replacing them.

Inactive OAuth tokens are refreshed in the account pool without activating those accounts. Unsupported providers and credential types are listed as unavailable. Inactive command-based API keys cannot be queried in isolation.

The extension publishes `pi-accounts:service` and `pi-accounts:changed` for usage integration. No credential data is included in change notifications.

## Development

```text
git clone https://github.com/hyird/pi-multiprovider.git
cd pi-multiprovider
bun install --frozen-lockfile
bun run check
```

Install a local checkout with `pi install /absolute/path/to/pi-multiprovider`. Tests use temporary directories and synthetic credentials, including a real Pi runtime authentication check. They do not authenticate real accounts or call provider services.
