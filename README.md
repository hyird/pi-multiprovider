# pi-multiprovider

Persistent multi-account switching for Pi 0.87.0. Native Pi login and logout provider pickers, an extra account-selection step, and permanent switching. All interface text is in English.

## Install

```text
pi install git:github.com/hyird/pi-multiprovider
```

Run `/reload` once after installing or updating. Switching accounts never requires a reload.

## Commands

| Command | Interaction |
| --- | --- |
| `/multilogin` | Native Pi provider/authentication picker → account slot or Add account → native Pi login dialog |
| `/multilogout` | Native Pi logout provider picker → saved account → confirm sign-out |
| `/switch-account` | Provider → saved account/API key → switch, notify, close |

To change a label, run `/switch-account`, choose a provider, highlight an account, and press **Ctrl+E**. Enter the new label and press Enter to save. This updates only the saved label; it does not switch accounts or modify Pi's current credentials. Esc cancels. Labels must be unique within a provider. Pressing Enter on an account still switches immediately.

Login reuses Pi's `OAuthSelectorComponent` and `LoginDialogComponent`, including browser launch, device codes, manual callback input, and provider-specific login prompts. There is no separate login settings screen. Selecting a saved slot signs in again to that slot. New slots receive `default`, `default-2`, and so on.

You can specify a provider ID and a label directly:

```text
/multilogin openai-codex work
/multilogout openai-codex work
/switch-account openai-codex work
```

Successful login saves and activates the selected account. Cancelling authentication leaves current credentials unchanged. Logout removes the selected saved login (including aliases with identical credentials); if it is active, it also clears that provider's current Pi login. Other saved accounts remain available.

Switching writes the selected credentials to the global `auth.json`, refreshes Pi's existing runtime, displays a confirmation, and closes the menu. The choice persists across new sessions and restarts until you explicitly change it. No automatic rotation or failover is performed. Account switching does not change your model; choose another provider's model using `/model`.

## Interface

Provider names come directly from Pi. The login/logout provider pickers and login dialog are native Pi components. Account and switch pickers use theme colors, borders, aligned status columns, contextual descriptions, and fuzzy search. Long lists have a bounded viewport with arrows, Page Up/Down, Home/End, and mouse-wheel navigation. Small terminals use a compact layout.

The interaction is inspired by [pi-multiprovider](https://pi.dev/packages/pi-multiprovider). This extension focuses on persistent manual selection.

## Native commands

Pi 0.87 does not allow extensions to replace or hide its built-in `/login` and `/logout` commands. They remain available:

- Native `/login` replaces Pi's current credential. It does not immediately register that login in this extension. On the next account operation, the current stored login is preserved under a default label if it has not already been saved. Previously unsaved credentials cannot be recovered after native login overwrites them.
- Native `/logout` clears the current Pi login but leaves this extension's saved accounts intact. A saved account can be selected again using `/switch-account`.
- `/multilogout` removes the selected saved login and clears the current Pi credential if it matches.

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
