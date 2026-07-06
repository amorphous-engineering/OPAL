# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller spec for OPAL standalone binary.

Build with:
    pyinstaller opal.spec

Output: dist/opal (or dist/opal.exe on Windows)
"""

import os
from pathlib import Path

from PyInstaller.utils.hooks import collect_data_files

block_cipher = None

# Paths
src_dir = Path("src/opal")
migrations_dir = Path("migrations")

# Collect all data files that need to be bundled
datas = []

# Web templates and static files
datas.append((str(src_dir / "web" / "templates"), "opal/web/templates"))
datas.append((str(src_dir / "web" / "static"), "opal/web/static"))

# SE requirement lint rules (loaded as data by opal.se.lint)
datas.append((str(src_dir / "se" / "lint_rules.yaml"), "opal/se"))

# Risk scenario lint rules (loaded as data by opal.risks.lint; the demo seed's
# risk-accept path reads them)
datas.append((str(src_dir / "risks" / "lint_rules.yaml"), "opal/risks"))

# Mojave Sphinx demo seed data (loaded by opal.seed)
datas.append((str(src_dir / "seed_data" / "sphinx"), "opal/seed_data/sphinx"))

# TUI styles
datas.append((str(src_dir / "tui" / "styles.tcss"), "opal/tui"))

# Launcher styles
datas.append((str(src_dir / "launcher.tcss"), "opal"))

# Third-party package data: fido2 (WebAuthn) reads public_suffix_list.dat at
# import time — the frozen server dies without it.
datas.extend(collect_data_files("fido2"))

# Alembic migrations (for programmatic upgrades)
datas.append((str(migrations_dir), "migrations"))

# Alembic config
datas.append(("alembic.ini", "."))

a = Analysis(
    [str(src_dir / "launcher.py")],
    pathex=["src"],
    binaries=[],
    datas=datas,
    hiddenimports=[
        "opal",
        "opal.api",
        "opal.api.app",
        "opal.core",
        "opal.db",
        "opal.db.models",
        "opal.db.base",
        "opal.web",
        "opal.tui",
        "opal.mcp",
        "uvicorn",
        "uvicorn.logging",
        "uvicorn.loops",
        "uvicorn.loops.auto",
        "uvicorn.protocols",
        "uvicorn.protocols.http",
        "uvicorn.protocols.http.auto",
        "uvicorn.protocols.websockets",
        "uvicorn.protocols.websockets.auto",
        "uvicorn.lifespan",
        "uvicorn.lifespan.on",
        "textual",
        "textual.app",
        "textual.css",
        "sqlalchemy",
        "sqlalchemy.dialects.sqlite",
        "alembic",
        "jinja2",
        "httpx",
        "pydantic",
        "pydantic_settings",
        "aiofiles",
        "segno",
        "packaging",
        "packaging.version",
        "yaml",
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.zipfiles,
    a.datas,
    [],
    name="opal",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
