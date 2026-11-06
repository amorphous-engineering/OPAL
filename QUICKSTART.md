# OPAL quickstart

OPAL 2 is in beta. It is ready to try, and not yet ready to hold your only copy of real data.

## Install

```bash
# macOS / Linux
curl -LsSf https://raw.githubusercontent.com/amorphous-engineering/OPAL/rewrite/install.sh | sh -s -- --prerelease
```

```powershell
# Windows (PowerShell)
$env:OPAL_PRERELEASE = "1"
irm https://raw.githubusercontent.com/amorphous-engineering/OPAL/rewrite/install.ps1 | iex
```

Or download the binary for your computer from [GitHub Releases](https://github.com/amorphous-engineering/OPAL/releases) and check it against `SHA256SUMS`.

## Start it

```bash
opal
```

This starts the server and opens a control page with its status and log. To run only the server, without the control page, use `opal serve`.

## If you already use OPAL 1.x

This beta cannot read a 1.x database yet. If it finds one, it stops and leaves the file alone. The installer also replaces the `opal` program, so anything that starts `opal`, including a service, now starts the beta.

The installer keeps your previous program the first time. To go back to 1.x:

```bash
mv ~/.local/bin/opal.before-v2 ~/.local/bin/opal
```

```powershell
Move-Item -Force "$env:LOCALAPPDATA\OPAL\opal.before-v2.exe" "$env:LOCALAPPDATA\OPAL\opal.exe"
```

To try the beta beside your 1.x data, give it its own empty folder:

```bash
OPAL_DATA_DIR=~/opal-beta opal
```

## Create the first account

The first start prints a setup code in the terminal, and in the log on the control page. Open <http://localhost:8080/setup>, enter the code, and create the admin account.

## Look around with demo data

In **Settings**, under **Demo data**, press **ENTER DEMO**. This opens a separate database holding a sample rocket project: parts, stock, purchase orders, procedures, work orders, issues, risks and requirements. Your own database is not touched, and changes made in the demo are deleted when you exit it. The switch applies to everyone using this OPAL, and anyone else has to sign in again, so try it before others join.

Good places to start: open a work order under **Executions** and complete a step, raise an issue from it, or place a purchase order and receive against it.

## Let other people in

OPAL listens on every network interface, on port 8080. People on your network can reach it at `http://<this-computer>:8080`, and an admin adds them under **Users**.

OPAL serves plain HTTP, so passwords cross the network unencrypted. Keep it on a network you trust, or put a TLS proxy in front of it and set `OPAL_PUBLIC_URL`. The README lists the [network settings](README.md#network-settings). This beta has not been tested on the open internet, so do not expose it there.

Installing a plugin gives it shell-level access to this computer. To turn plugins off, set `OPAL_PLUGINS=0`.

## Back up your data

OPAL has no scheduled backups. Stop OPAL and copy the whole data folder:

| System | Data folder |
|---|---|
| macOS | `~/Library/Application Support/OPAL` |
| Linux | `~/.local/share/opal` |
| Windows | `%LOCALAPPDATA%\OPAL` |

`OPAL_DATA_DIR` replaces this folder if you set it.

## Update

```bash
opal update
```

The control page has the same button. Restart OPAL afterward. A beta follows later betas and the final release.

## Go back after a bad update

Before an update changes the database, OPAL copies it to `opal.pre-migration-<time>.db` in the data folder and keeps the newest three. To go back:

1. Stop OPAL.
2. Install the version you came from, using `--version <tag>` as in the [README](README.md#install).
3. Move `opal.db`, `opal.db-wal` and `opal.db-shm` out of the data folder.
4. Rename the copy you want to `opal.db`, then start OPAL.

Anything recorded after the update is not in that copy.

## Report a problem

[Open an issue](https://github.com/amorphous-engineering/OPAL/issues/new?template=bug.yml), or use **Report a problem** in **Settings**, under **System**, which fills in your version. Issues are public, so leave out real company data.
