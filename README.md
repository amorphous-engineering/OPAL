# OPAL

**Operations, Procedures, Assets, Logistics**

A local-first system for hardware teams: parts, stock, purchasing, procedures and their execution, issues, risks and requirements. One binary and one SQLite file. It runs on one computer and serves the local network.

## Install

**OPAL 2 is in beta.** Try it and tell us what breaks, but do not keep your only copy of real data in it yet. New here? Start with the [quickstart](QUICKSTART.md).

```bash
# macOS / Linux
curl -LsSf https://raw.githubusercontent.com/amorphous-engineering/OPAL/rewrite/install.sh | sh -s -- --prerelease
```

```powershell
# Windows (PowerShell)
$env:OPAL_PRERELEASE = "1"
irm https://raw.githubusercontent.com/amorphous-engineering/OPAL/rewrite/install.ps1 | iex
```

The prerelease option is needed for now: the release marked Latest is still 1.x, which these installers cannot verify, so they stop. To install one exact release:

```bash
curl -LsSf https://raw.githubusercontent.com/amorphous-engineering/OPAL/rewrite/install.sh | sh -s -- --version v2.0.0-beta.1
```

```powershell
$env:OPAL_VERSION = "v2.0.0-beta.1"
irm https://raw.githubusercontent.com/amorphous-engineering/OPAL/rewrite/install.ps1 | iex
```

Or download a binary from [GitHub Releases](https://github.com/amorphous-engineering/OPAL/releases) and check it against `SHA256SUMS`.

| Platform | File |
|----------|------|
| macOS (Apple Silicon) | `opal-macos-arm64` |
| macOS (Intel) | `opal-macos-x86_64` |
| Linux (x86_64) | `opal-linux-x86_64` |
| Linux (arm64) | `opal-linux-arm64` |
| Windows (x86_64) | `opal-windows-x86_64.exe` |

## Run

| Command | What it does |
|---|---|
| `opal` | Starts the server and opens a control page in the browser: status, log, start, stop, update. |
| `opal serve` | Starts only the server. Use this under systemd or another service manager. |
| `opal update` | Downloads and installs the newest release. A prerelease build also follows later prereleases. It checks the download against the release's checksums, which catches a damaged file but not a tampered release. |

### First run

The first time OPAL starts, it prints a setup code to the terminal, and to the log on the control page if you ran `opal`. Under a service manager it is in the service log, such as `journalctl -u opal`. Open `http://localhost:8080/setup` and enter the code to create the first administrator. The code changes each time OPAL starts.

Setup works at `localhost`, at the server's IP address, or at a host name you list in `OPAL_ALLOWED_HOSTS` or `OPAL_PUBLIC_URL`. A web page can point a name it owns at your server, so OPAL refuses setup under any other name.

### Data

The server listens on port 8080. Data is in `~/Library/Application Support/OPAL` (macOS), `~/.local/share/opal` (Linux) or `%LOCALAPPDATA%\OPAL` (Windows). Set `OPAL_DATA_DIR` to use another folder. On Linux and macOS the server creates a new data folder for its own account only, and restricts the files it keeps there at each start. A folder that already exists keeps its own mode, because it may be shared.

Uploaded files and photos are not limited in total by default. Set `OPAL_STORAGE_QUOTA_BYTES` to cap them together: past the cap, new uploads and photos are refused with a message until files are removed. A file nothing links to or publishes any more is deleted from disk after seven days. A cap of 50 GB (`53687091200`) suits most teams; choose one well below your free disk. OPAL does not refuse writes when the disk runs low, so watch the disk check in `/api/health`.

### Network settings

OPAL serves plain HTTP. Passwords and session cookies cross the network in clear, so put a TLS proxy in front of it for anything beyond a network segment you trust. All of these are optional environment variables; without them nothing changes for a LAN instance.

| Variable | Effect |
|---|---|
| `OPAL_PUBLIC_URL` | The URL people use, for example `https://opal.example.com`. Links, OAuth metadata and the `Secure` cookie flag follow it, and its host joins the allowed hosts. With an `https` URL cookies are `Secure`, so reach OPAL by that URL only. |
| `OPAL_TRUST_PROXY=1` | Believe `X-Forwarded-For`, `-Proto` and `-Host`. Set it only when the proxy overwrites them. `X-Forwarded-Host` has to match what the browser's address bar shows, port included, so on a non-standard port use nginx's `$http_host`, not `$host`. The client address is the last `X-Forwarded-For` entry. |
| `OPAL_TRUST_PROXY_HOPS` | With `OPAL_TRUST_PROXY`, the number of proxies in the chain (default 1). The client address is counted that many entries from the right. |
| `OPAL_ALLOWED_HOSTS` | Comma-separated host names (`opal.lan,192.168.1.20:8080`). When this or `OPAL_PUBLIC_URL` is set, a request for any other `Host` gets 421. `localhost` and the loopback addresses are always allowed. |

### Limits

These environment variables set what the server accepts. The defaults suit a team on a local network.

| Variable | Default | Meaning |
|---|---|---|
| `OPAL_MAX_JSON_BYTES` | 4194304 (4 MiB) | Largest JSON request body, for the API, `/oauth/*` and `/mcp`. Larger requests get 413. |
| `OPAL_MAX_UPLOAD_BYTES` | 10485760 (10 MiB) | Largest uploaded file. |
| `OPAL_IDLE_TIMEOUT_SECONDS` | 60 | A connection silent this long is closed (1 to 255). Bun checks about every 4 seconds, so it can close up to 4 seconds early. The live event stream sends a heartbeat every 5 seconds, so keep this at 10 or more. |
| `OPAL_MAX_STREAMS_PER_USER` | 30 | Live event streams one account may hold open at once. Each open tab uses one or two. |

### Plugins

An admin can install a plugin from a public GitHub repository. **Installing a plugin gives it shell-level access to the server.** Its API token is limited to the permissions in its manifest, but the process runs as the same user as OPAL with no sandbox, so it can read the data folder, including the database and the key to its stored secrets. Install only plugins you would trust with a login on that machine.

Set `OPAL_PLUGINS=0` to turn plugins off on a server. Nothing starts, and OPAL refuses to preview, install, configure, enable or restart one.

### Single sign-on (OIDC)

Run first-run setup before relying on single sign-on: it can't create the first account. Setup makes a password administrator, so keep password sign-in on until that person can also get in through the provider. If you set `OPAL_PASSWORD_LOGIN_ENABLED=0` from the start, link them through a verified provider email or `OPAL_OIDC_ADMIN_GROUP`.

The identity provider can be on a private address. OPAL trusts the issuer host an admin configures. The token, userinfo and key endpoints in its discovery document, and any redirect or `picture` URL, must be on that same host and port or on a public https address. Link-local and cloud metadata addresses are always refused. Failures in **Test** show one message; the server log has the detail.

Private-address issuers are allowed by default, so on-premises providers keep working. On an internet-facing server, or one that must not reach its own network, set `OPAL_OIDC_ALLOW_PRIVATE=0`, so the issuer has to be on a public address too. A firewall is still the real boundary, because a name can resolve differently between OPAL's check and the request.

OPAL links a sign-in to an existing account by email only when the provider sends `email_verified: true`. Some providers leave that claim out. With those, a person whose email already belongs to an OPAL account is refused at sign-in, and OPAL has no action to link the two yet. New people still get a new account. If your provider omits the claim, have people sign in before you create their accounts, or remove the email from the existing account first.

### Coming from 1.x

The first start imports a 1.x database found in the data folder, from any release from 1.2.2 through 1.4.0-beta.3. The original file is not changed and stays beside the new one as `opal.legacy.db`. `import-report.txt` lists every table in the old file, what moved and what did not. `opal import <file>` does the same for a database somewhere else. Stop 1.x first: the installer replaces the `opal` program and keeps the previous one. 1.x extensions and the Onshape integration do not carry over, and the report lists what they held. The [quickstart](QUICKSTART.md#if-you-already-use-opal-1x) covers passwords, `opal.project.yaml` and how to go back.

### Back up and roll back

`opal backup <folder>` writes a backup into a new subfolder of `<folder>`, named by the time. OPAL can keep running and keeps taking writes while it does. `--keep <n>` then removes older finished backups beyond the newest `n`, and removes nothing else.

A backup holds a copy of the database, the attachments and avatars the database names, installed plugins and their data, and the key files in the data folder. It leaves out the demo database, the `opal.pre-migration-*` copies and `opal.legacy.db`. A plugin's data is copied as it stands, not from one moment as the database is. A key or secret set by an environment variable, such as `OPAL_AUTH_SECRET`, is not in the backup, so keep it somewhere else. Neither is a plugin installed from a local folder.

The command checks the copy before it names the backup finished: SQLite's integrity check on the database, and that every attachment file is present and matches its hash. If a check fails it prints what failed, exits non-zero, removes the unfinished copy and leaves older backups alone. A missing attachment file stops the backup every time until the file is put back, because it is damage to the live data. A missing avatar only warns. A backup that was interrupted stays as a folder ending in `.partial`. It is never counted, restored or removed for you, so delete it yourself.

**A backup contains secrets.** It holds password hashes, the key files and everything in your records, so its folder and files are owner-only. Treat it like the data folder itself. If you set `OPAL_SECRETS_KEY`, that key is not in the backup, so keep it separately. **A backup on the same disk is not a backup.** Copy it to another machine, or point `<folder>` at another disk.

`opal restore <backup-folder>` restores into the data folder (`OPAL_DATA_DIR`, or the default). It refuses a folder that already has a database or anything else in it, and there is no flag to override that. It refuses a backup that is incomplete or changed since it was written, one whose manifest names anything but regular files, and one made by a newer version than the program restoring it. While it runs, and if it stops partway, OPAL will not start on that folder. Run the same command again to finish: a different backup is refused. If something else writes to the folder during a restore, it stops without replacing anything. Anything recorded after the backup was taken is not in it.

`contrib/` has systemd user units: `opal.service` runs `opal serve`, and `opal-backup.timer` backs up nightly and keeps 14. The [quickstart](QUICKSTART.md#back-up-your-data) shows how to install them.

Before an update changes the database, OPAL copies it to `opal.pre-migration-<time>.db` in the data folder and keeps the newest three. The [quickstart](QUICKSTART.md#go-back-after-a-bad-update) shows how to go back.

### Stored secrets and their key

OPAL encrypts the single sign-on client secret and plugin secrets in the database. A copy of `opal.db` on its own does not reveal them. Onshape settings and API keys from a 1.x database are not kept: OPAL does not use them, and it removes them at the first start of this version.

The key is `.opal_secrets_key` in the data folder, made the first time a secret is saved. To keep it away from the data, set `OPAL_SECRETS_KEY` to at least 32 characters, for example from `openssl rand -hex 32`, and keep that value in your backups or password manager. A copy of the data folder is otherwise a copy of the database and its key together, so treat it as sensitive. The key does not protect against someone who can read the whole folder on the server, including a plugin. On Windows, file modes do not restrict the key file, so use the folder's own permissions.

- **Restored without the key:** OPAL starts and your records are all there. The secrets cannot be read, so OPAL names them in its log and shows them as unreadable in Settings. Single sign-on and any plugin holding one of them stop working until you enter them again in Settings or restore the key. Restore the key first if you can: a secret entered in the meantime uses a new key, and has to be entered again once the old key is back. If nobody can sign in, set `OPAL_OIDC_CLIENT_SECRET` to the secret from your provider and restart.
- **Changing the key:** stop OPAL and run `opal secrets rotate`, with the same environment OPAL runs with. It changes nothing if it cannot read the stored secrets. Back up again afterward, because an older backup needs its older key. With `OPAL_SECRETS_KEY`, move the old value to `OPAL_SECRETS_KEY_PREVIOUS`, set a new `OPAL_SECRETS_KEY`, start OPAL once, then remove `OPAL_SECRETS_KEY_PREVIOUS`. If you think a key has leaked, change the secrets at the provider or plugin as well.
- **Moving from the file to the variable:** set `OPAL_SECRETS_KEY`, start OPAL once, then delete `.opal_secrets_key`.
- **Moving from the variable to the file:** rename `OPAL_SECRETS_KEY` to `OPAL_SECRETS_KEY_PREVIOUS`, start OPAL once, then remove `OPAL_SECRETS_KEY_PREVIOUS`.
- **Factory reset:** deletes the file with the database and makes a new key for the next secret. `OPAL_SECRETS_KEY` stays as you set it.
- **Secrets set by environment variable:** `OPAL_OIDC_CLIENT_SECRET` stays in the environment and is never written to the database. A secret saved in Settings takes its place.

**Older files in the data folder still hold secrets in plaintext.** The copy taken when you first upgrade to this version keeps them, because an older version cannot read an encrypted value. OPAL names these `opal.pre-migration-*.db` files at each start. Delete them when you no longer need to go back that far. `opal.legacy.db`, left by a 1.x import, holds them too, along with any Onshape API keys, as do any backups made before this version.

## Connect Claude Code (MCP)

```bash
claude mcp add --transport http opal https://<host>/mcp
```

Run `/mcp` in Claude Code and select `opal`. Sign in to OPAL in the browser and approve the client. For claude.ai, add a custom connector with the same URL. Behind a reverse proxy that terminates TLS, set `OPAL_PUBLIC_URL` to the URL people use, for example `https://opal.example.com`.

Scripts can use an API token instead: add `--header "Authorization: Bearer opal_<token>"`.

## Report a problem

[Open an issue](https://github.com/amorphous-engineering/OPAL/issues/new?template=bug.yml). Issues are public, so leave out real company data. Report a security problem privately, under **Report a vulnerability** on the repository's Security tab.

## Develop

Needs Node 22+, pnpm 11 and Bun 1.4.

```bash
pnpm install
pnpm --filter @opal/server dev     # API on :8080
pnpm --filter frontend dev         # web client on :5173
pnpm test
pnpm check
```

`CLAUDE.md` describes the layout and the rules.

## License

MIT
