# pi-multiprovider

Persistent multi-account switching for Pi 0.87.0. Manage provider accounts, sign in, and edit labels from `/accounts`. All interface text is in English.

Switching writes the selected credentials to Pi's global `auth.json` and refreshes the current runtime. The next request uses that account, and the selection survives restarts and new sessions. Switching does not reload extensions or replace your conversation.

## Install

```text
pi install git:github.com/hyird/pi-multiprovider
```

Run `/reload` once to load a newly installed or updated extension. Account switches do not require `/reload`.

## Account manager

Run `/accounts`. The first screen lists providers with saved accounts or existing Pi credentials, using Pi's own display names. **Add provider** and **Remove provider** appear at the bottom, in that order.

```text
Accounts · Providers
  OpenAI
  xAI
  Add provider
  Remove provider

OpenAI
  Label    default
  Switch   default
  Back
```

- **Label** displays the current account label. Press Enter to edit it directly. Existing unnamed Pi credentials are saved as `default` (or a numbered variant if that label already exists).
- **Switch** displays the current account label. Press Enter to choose a saved account or API key; the selection takes effect permanently.
- **Add provider** is the only interactive entry point for adding credentials. Choose a provider, enter a label, then complete its native OAuth or API-key login. Existing providers are also available here to add another account. Failed or cancelled login leaves current credentials unchanged.
- **Remove provider** asks which provider to remove, then confirms removal of all its saved accounts and its current Pi login. It does not remove the provider's model definitions or environment variables.
- Provider screens contain only **Label**, **Switch**, and **Back**.
- Lists show at most ten rows, shrink with the terminal, and keep the selected item visible. Type to search by name or provider ID; use arrows, Page Up/Down, Home/End, or the mouse wheel to navigate.
- Esc returns to the previous screen; Esc on the provider list closes the manager.

The provider/account drill-down and native provider login flow are inspired by [pi-multiprovider](https://github.com/monotykamary/pi-multiprovider). Account selection here remains persistent until you explicitly change it. There is no automatic rotation or failover.

## Optional commands

```text
/accounts list openai-codex
/accounts save openai-codex work
/accounts use openai-codex work
/accounts remove openai-codex personal
```

Switching accounts does not change the selected model or provider. Use `/model` to choose a model from another provider. Account operations are blocked while the current agent is busy.

## Storage

The default files are `~/.pi/agent/auth.json` for active credentials and `~/.pi/agent/accounts.json` for saved accounts. Both respect `PI_CODING_AGENT_DIR`. These files contain credentials; do not share or commit them.

The extension uses Pi's auth-file lock and atomic file replacement. Before switching, it saves current credentials, including refreshed OAuth tokens when their identity can be matched. Unsaved accounts are preserved as `backup-...`. Opaque credentials with no recognizable stable identity are backed up separately. Credentials that cannot be refreshed require another login.

Only stored credentials are managed. Environment-only authentication, runtime overrides, and other extensions' independent account pools are outside this plugin's control. Command-based API keys retain their original configuration. Requests already running in another Pi process are not interrupted.

The `pi-accounts:changed` event carries `{ provider, name }` after activation or an active label change, allowing other extensions to invalidate account-specific caches.

## Development

```text
git clone https://github.com/hyird/pi-multiprovider.git
cd pi-multiprovider
bun install --frozen-lockfile
bun run check
```

Install a local checkout with `pi install /absolute/path/to/pi-multiprovider`.

Tests use temporary directories and synthetic credentials, including a real Pi runtime authentication check. They do not sign in to real accounts or call provider services.
