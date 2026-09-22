# pi-multiprovider

Persistent multi-account switching for Pi 0.87.0. Manage provider accounts, sign in, and edit labels from `/accounts`. All interface text is in English.

Switching writes the selected credentials to Pi's global `auth.json` and refreshes the current runtime. The next request uses that account, and the selection survives restarts and new sessions. Switching does not reload extensions or replace your conversation.

## Install

```text
pi install git:github.com/hyird/pi-multiprovider
```

Run `/reload` once to load a newly installed or updated extension. Account switches do not require `/reload`.

## Account manager

Run `/accounts`. The first screen lists only providers with saved accounts or existing Pi credentials. **Add provider** is always the last row.

```text
Accounts · Providers
  openai-codex
  xai
  Add provider

openai-codex
Active: work
  ● work
  ○ personal
  Add account / API key
  Edit label
  Save current login
  Remove account
  Back
```

- Choose a provider, then select an account or API key to switch immediately and permanently. There is no account action submenu.
- **Edit label** lets you select and rename a saved account or API key from the provider screen.
- **Add account / API key** asks for a label and runs that provider's OAuth or API-key login. Successful login saves and activates the account. Failed or cancelled login leaves the current credentials unchanged.
- **Save current login** labels and saves the provider's existing Pi credentials.
- **Add provider** shows available providers that have not been added yet, then guides you through adding their first account. Custom providers must first be registered with Pi.
- **Remove account** removes an inactive saved record after confirmation. It does not log out Pi.
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
