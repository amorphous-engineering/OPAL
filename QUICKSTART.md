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

Without `enable-linger`, OPAL and the timer stop when you log out. To check the last backup, run `systemctl --user status opal-backup.service`. A failed backup shows as failed there, and `journalctl --user -u opal-backup.service` says why. Nothing else tells you, so look now and then.

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
