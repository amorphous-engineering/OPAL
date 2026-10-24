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

The server listens on port 8080. Data is in `~/Library/Application Support/OPAL` (macOS), `~/.local/share/opal` (Linux) or `%LOCALAPPDATA%\OPAL` (Windows). Set `OPAL_DATA_DIR` to use another folder.

### Upgrade from 1.x

1. Install the last 1.x release and start it once. This upgrades the database.
2. Install this version and start it.

On the first start, OPAL imports the old database into a new file. It keeps the old file as `opal.legacy.db` and writes `import-report.txt` next to it.

## Connect Claude Code (MCP)

Create an API token in OPAL, then run:

```bash
claude mcp add --transport http opal http://<host>:8080/mcp --header "Authorization: Bearer opal_<token>"
```

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
