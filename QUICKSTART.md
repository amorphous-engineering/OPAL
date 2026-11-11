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

Stop 1.x first. The installer replaces the `opal` program, so anything that starts `opal`, including a service, now starts OPAL 2.

The first start imports the database in the data folder, from any release from 1.2.2 through 1.4.0-beta.3. The original file is not changed: it stays next to the new database as `opal.legacy.db`. `import-report.txt`, in the same folder, lists every table in the old file, what moved, and what did not. Read it before you rely on the result. Extensions and the Onshape integration do not carry over, and the report lists what they held.

The import keeps every row or does not happen. If even one row fails, OPAL stops and the old database stays in place. The report names each row. Fix the cause and start again, or go on without those rows:

```bash
opal import /path/to/opal.db --accept-failed-rows
```

If your attachments are not in `attachments` beside the database, name the folder with `--attachments`. Two records with one work order, order or part number both stay: the later one reads as that number with `-DUP2`, and the report lists each change.

Databases from before 1.4 have no passwords. The first start then prints a link in the terminal, and in the log on the control page, where the administrator sets one. Under **Users**, the administrator can make links for everyone else. Skip the first-account step below.

Before 1.4, the project name, tiers and part numbering lived in `opal.project.yaml`. OPAL looks for it next to the database, one folder up, and in the current folder and its parents. If it finds none, the report says so, and new part numbers use the default format.

A database somewhere else, or a project file OPAL cannot find:

```bash
opal import /path/to/opal.db --project /path/to/opal.project.yaml
```

To go back to 1.x, restore both the program and the database. Anything you did in OPAL 2 stays behind in `opal.v2.db`. The installer keeps your previous program the first time.

```bash
mv ~/.local/bin/opal.before-v2 ~/.local/bin/opal
cd ~/.local/share/opal && mv opal.db opal.v2.db && mv opal.legacy.db opal.db
```

```powershell
Move-Item -Force "$env:LOCALAPPDATA\OPAL\opal.before-v2.exe" "$env:LOCALAPPDATA\OPAL\opal.exe"
cd "$env:LOCALAPPDATA\OPAL"; Move-Item opal.db opal.v2.db; Move-Item opal.legacy.db opal.db
```

To try the beta beside your 1.x data without importing it, give it its own empty folder:

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

On macOS and Windows, installing a plugin gives it shell-level access to this computer. On Linux, OPAL keeps a plugin to its own folder where the kernel allows it, and the plugin's page shows whether it did. Install only plugins you trust either way. The README has [the details](README.md#plugins). To turn plugins off, set `OPAL_PLUGINS=0`.

## Back up your data

OPAL keeps its data in one folder:

| System | Data folder |
|---|---|
| macOS | `~/Library/Application Support/OPAL` |
| Linux | `~/.local/share/opal` |
| Windows | `%LOCALAPPDATA%\OPAL` |

`OPAL_DATA_DIR` replaces this folder if you set it.

To back up, while OPAL runs or not:

```bash
opal backup /mnt/other-disk/opal-backups --keep 14
```

This writes a new subfolder and prints its path. It keeps the newest 14 backups in that folder and removes no other files. If it cannot write a complete backup, it says why and exits non-zero.

A backup contains your password hashes, key files and every record, so keep it as private as the data folder. A backup on the same disk is not a backup: if the disk fails you lose both. Copy it to another machine.

To restore, into an empty data folder:

```bash
OPAL_DATA_DIR=~/.local/share/opal-restored opal restore /mnt/other-disk/opal-backups/opal-backup-2026-11-06T02-30-00-000Z
OPAL_DATA_DIR=~/.local/share/opal-restored opal serve
```

Restore refuses a folder that already has anything in it. To go back to a backup in the same place, stop OPAL and move the old folder aside first. Try a restore once before you need one.

### Back up every night on Linux

`contrib/` in the repository has systemd user units. `opal.service` runs OPAL. `opal-backup.timer` backs it up at about 02:30 and keeps 14. Edit `opal-backup.service` first: it writes to `~/opal-backups`, which you should change to another disk everywhere the file names it.

```bash
mkdir -p ~/.config/systemd/user ~/opal-backups
cp contrib/opal.service contrib/opal-backup.service contrib/opal-backup.timer ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now opal.service opal-backup.timer
loginctl enable-linger "$USER"
```

Without `enable-linger`, OPAL and the timer stop when you log out. To check the last backup, run `systemctl --user status opal-backup.service`. A failed backup shows as failed there, and `journalctl --user -u opal-backup.service` says why. A backup that had to leave out a missing or damaged attachment still finishes, and shows only as a `Warning:` line in that log, so look now and then.

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

A version from before secrets were encrypted cannot read an encrypted secret. Use the copy taken when you first upgraded, which still holds them readable. With any later copy, enter the single sign-on and plugin secrets again after going back.

## Report a problem

[Open an issue](https://github.com/amorphous-engineering/OPAL/issues/new?template=bug.yml), or use **Report a problem** in **Settings**, under **System**, which fills in your version. Issues are public, so leave out real company data.
