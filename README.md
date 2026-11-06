# OPAL

**Operations, Procedures, Assets, Logistics**

A local-first system for hardware teams: parts, stock, purchasing, procedures and their execution, issues, risks and requirements. One binary and one SQLite file. It runs on one computer and serves the local network.

## Install

```bash
# macOS / Linux
curl -LsSf https://raw.githubusercontent.com/amorphous-engineering/OPAL/master/install.sh | sh
```

```powershell
# Windows (PowerShell)
irm https://raw.githubusercontent.com/amorphous-engineering/OPAL/master/install.ps1 | iex
```

The installers take the release marked Latest. To install a prerelease or one exact release:

```bash
curl -LsSf https://raw.githubusercontent.com/amorphous-engineering/OPAL/master/install.sh | sh -s -- --prerelease
curl -LsSf https://raw.githubusercontent.com/amorphous-engineering/OPAL/master/install.sh | sh -s -- --version v2.0.0-rc.21
```

```powershell
$env:OPAL_PRERELEASE = "1"            # or: $env:OPAL_VERSION = "v2.0.0-rc.21"
irm https://raw.githubusercontent.com/amorphous-engineering/OPAL/master/install.ps1 | iex
```

Or download a binary from [GitHub Releases](https://github.com/amorphous-engineering/OPAL/releases/latest) and check it against `SHA256SUMS`.

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
| `opal update` | Downloads, verifies and installs the latest release. |
| `opal import <file>` | Imports a database from a 1.x release into a new file. |

### First run

The first time OPAL starts, it prints a setup code to the terminal, and to the log on the control page if you ran `opal`. Under a service manager it is in the service log, such as `journalctl -u opal`. Open `http://localhost:8080/setup` and enter the code to create the first administrator. The code changes each time OPAL starts.

Setup works at `localhost`, at the server's IP address, or at a host name you list in `OPAL_ALLOWED_HOSTS` or `OPAL_PUBLIC_URL`. A web page can point a name it owns at your server, so OPAL refuses setup under any other name.

### Data

The server listens on port 8080. Data is in `~/Library/Application Support/OPAL` (macOS), `~/.local/share/opal` (Linux) or `%LOCALAPPDATA%\OPAL` (Windows). Set `OPAL_DATA_DIR` to use another folder. On Linux and macOS the server makes the folder and everything it writes there readable by the account that runs OPAL only (mode `0700` and `0600`), and tightens an older folder at start.

Uploaded files and photos are not limited in total by default. Set `OPAL_STORAGE_QUOTA_BYTES` to cap them together: past the cap, new uploads and photos are refused with a message until files are removed. A file nothing links to or publishes any more is deleted from disk after seven days. A cap of 50 GB (`53687091200`) suits most teams; choose one well below your free disk. OPAL does not refuse writes when the disk runs low, so watch the disk check in `/api/health`.

### Network settings

OPAL serves plain HTTP. Passwords and session cookies cross the network in clear, so put a TLS proxy in front of it for anything beyond a network segment you trust. All of these are optional environment variables; without them nothing changes for a LAN instance.

| Variable | Effect |
|---|---|
| `OPAL_PUBLIC_URL` | The URL people use, for example `https://opal.example.com`. Links, OAuth metadata and the `Secure` cookie flag follow it, and its host joins the allowed hosts. With an `https` URL cookies are `Secure`, so reach OPAL by that URL only. |
| `OPAL_TRUST_PROXY=1` | Believe `X-Forwarded-For`, `-Proto` and `-Host`. Set it only when the proxy overwrites them. The client address is the last `X-Forwarded-For` entry. |
| `OPAL_TRUST_PROXY_HOPS` | With `OPAL_TRUST_PROXY`, the number of proxies in the chain (default 1). The client address is counted that many entries from the right. |
| `OPAL_ALLOWED_HOSTS` | Comma-separated host names (`opal.lan,192.168.1.20:8080`). When this or `OPAL_PUBLIC_URL` is set, a request for any other `Host` gets 421. `localhost` and the loopback addresses are always allowed. |

### Limits

These environment variables set what the server accepts. The defaults suit a team on a local network.

| Variable | Default | Meaning |
|---|---|---|
| `OPAL_MAX_JSON_BYTES` | 4194304 (4 MiB) | Largest JSON request body, for the API, `/oauth/*` and `/mcp`. Larger requests get 413. |
| `OPAL_MAX_UPLOAD_BYTES` | 10485760 (10 MiB) | Largest uploaded file. |
| `OPAL_IDLE_TIMEOUT_SECONDS` | 60 | A connection silent this long is closed (1 to 255). The live event stream sends a heartbeat every 5 seconds and stays open. |
| `OPAL_MAX_STREAMS_PER_USER` | 30 | Live event streams one account may hold open at once. Each open tab uses one or two. |

### Plugins

An admin can install a plugin from a public GitHub repository. **Installing a plugin gives it shell-level access to the server.** Its API token is limited to the permissions in its manifest, but the process runs as the same user as OPAL with no sandbox, so it can read the data folder, including the database. Install only plugins you would trust with a login on that machine.

Set `OPAL_PLUGINS=0` to turn plugins off on a server. Nothing starts, and OPAL refuses to preview, install, configure, enable or restart one.

### Single sign-on (OIDC)

The identity provider can be on a private address. OPAL trusts the issuer host an admin configures. The token, userinfo and key endpoints in its discovery document, and any redirect or `picture` URL, must be on that same host and port or on a public https address. Link-local and cloud metadata addresses are always refused. Failures in **Test** show one message; the server log has the detail.

Private-address issuers are allowed by default, so on-premises providers keep working. On an internet-facing server, or one that must not reach its own network, set `OPAL_OIDC_ALLOW_PRIVATE=0`, so the issuer has to be on a public address too. A firewall is still the real boundary, because a name can resolve differently between OPAL's check and the request.

OPAL links a sign-in to an existing account by email only when the provider sends `email_verified: true`. Some providers leave that claim out. With those, a person whose email already belongs to an OPAL account is refused at sign-in, and OPAL has no action to link the two yet. New people still get a new account. If your provider omits the claim, have people sign in before you create their accounts, or remove the email from the existing account first.

### Upgrade from 1.x

1. Install the last 1.x release and start it once. This upgrades the database.
2. Install this version and start it.

On the first start, OPAL imports the old database into a new file. It keeps the old file as `opal.legacy.db` and writes `import-report.txt` next to it.

## Connect Claude Code (MCP)

```bash
claude mcp add --transport http opal https://<host>/mcp
```

Run `/mcp` in Claude Code and select `opal`. Sign in to OPAL in the browser and approve the client. For claude.ai, add a custom connector with the same URL. Behind a reverse proxy that terminates TLS, set `OPAL_PUBLIC_URL` to the URL people use, for example `https://opal.example.com`.

Scripts can use an API token instead: add `--header "Authorization: Bearer opal_<token>"`.

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
