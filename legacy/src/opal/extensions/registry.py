"""Extension discovery and the enabled/disabled decision.

Two roots are scanned, in this order:

1. ``opal/extensions/bundled/`` — ships with the release.
2. ``<data_dir>/extensions/``   — installed from an uploaded archive.

A bundled id always wins: :func:`install_archive` refuses to shadow one, and
discovery ignores an installed directory that somehow shares an id anyway.

The filesystem is the source of truth for *what exists*; the ``extension``
table is the source of truth for *what the operator decided*. :func:`sync`
reconciles the two and is cheap enough to call on every settings read.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

from sqlalchemy.orm import Session

from opal.db.models.extension import ORIGIN_BUNDLED, ORIGIN_INSTALLED, Extension
from opal.extensions.manifest import (
    MANIFEST_FILENAME,
    ExtensionManifest,
    ManifestError,
    load_manifest,
)

logger = logging.getLogger("opal.extensions")


@dataclass(frozen=True)
class DiscoveredExtension:
    """An extension directory that parsed cleanly."""

    manifest: ExtensionManifest
    root: Path
    origin: str

    @property
    def id(self) -> str:
        return self.manifest.id

    @property
    def is_bundled(self) -> bool:
        return self.origin == ORIGIN_BUNDLED


@dataclass(frozen=True)
class BrokenExtension:
    """A directory that looks like an extension but did not parse.

    Surfaced rather than swallowed: a silently ignored extension is the
    hardest kind of failure for an operator to diagnose.
    """

    directory: str
    error: str


def bundled_root() -> Path:
    """Directory holding extensions that ship inside the package."""
    return Path(__file__).parent / "bundled"


def installed_root() -> Path:
    """Directory holding operator-installed extensions."""
    from opal.config import get_active_settings

    return Path(get_active_settings().extension_dir)


def _scan(root: Path, origin: str) -> tuple[list[DiscoveredExtension], list[BrokenExtension]]:
    found: list[DiscoveredExtension] = []
    broken: list[BrokenExtension] = []
    if not root.is_dir():
        return found, broken

    for child in sorted(root.iterdir()):
        if not child.is_dir() or child.name.startswith((".", "_")):
            continue
        if not (child / MANIFEST_FILENAME).is_file():
            continue
        try:
            manifest = load_manifest(child)
        except ManifestError as err:
            broken.append(BrokenExtension(directory=child.name, error=str(err)))
            continue
        if manifest.id != child.name:
            broken.append(
                BrokenExtension(
                    directory=child.name,
                    error=f"manifest id {manifest.id!r} does not match its directory name",
                )
            )
            continue
        found.append(DiscoveredExtension(manifest=manifest, root=child, origin=origin))
    return found, broken


def discover() -> tuple[list[DiscoveredExtension], list[BrokenExtension]]:
    """Scan both roots. Returns (usable extensions, unparseable directories)."""
    bundled, bundled_broken = _scan(bundled_root(), ORIGIN_BUNDLED)
    installed, installed_broken = _scan(installed_root(), ORIGIN_INSTALLED)

    bundled_ids = {ext.id for ext in bundled}
    kept: list[DiscoveredExtension] = list(bundled)
    broken = bundled_broken + installed_broken
    for ext in installed:
        if ext.id in bundled_ids:
            broken.append(
                BrokenExtension(
                    directory=ext.root.name,
                    error=f"{ext.id} is a bundled extension — the installed copy is ignored",
                )
            )
            continue
        kept.append(ext)
    return kept, broken


def find(ext_id: str) -> DiscoveredExtension | None:
    """Look up one discovered extension by id."""
    found, _ = discover()
    for ext in found:
        if ext.id == ext_id:
            return ext
    return None


def sync(db: Session) -> list[Extension]:
    """Reconcile the ``extension`` table with what is on disk.

    New directories get a row (enabled by default — an operator who put an
    extension there meant to use it). Version and metadata changes are picked
    up in place, preserving the enabled flag. Rows whose directory is gone are
    deleted; the operator removed the files, so the decision is moot.

    Caller commits.
    """
    found, _ = discover()
    by_id = {ext.id: ext for ext in found}

    rows = {row.id: row for row in db.query(Extension).all()}
    now = datetime.now(UTC)

    for ext_id, ext in by_id.items():
        manifest_data = ext.manifest.model_dump(mode="json")
        row = rows.get(ext_id)
        if row is None:
            db.add(
                Extension(
                    id=ext_id,
                    name=ext.manifest.name,
                    version=ext.manifest.version,
                    summary=ext.manifest.summary,
                    origin=ext.origin,
                    enabled=True,
                    installed_at=now,
                    manifest=manifest_data,
                )
            )
            continue
        row.name = ext.manifest.name
        row.version = ext.manifest.version
        row.summary = ext.manifest.summary
        row.origin = ext.origin
        row.manifest = manifest_data

    for ext_id, row in rows.items():
        if ext_id not in by_id:
            db.delete(row)

    db.flush()
    return db.query(Extension).order_by(Extension.id).all()


def get_row(db: Session, ext_id: str) -> Extension | None:
    return db.query(Extension).filter(Extension.id == ext_id).first()


def is_enabled(db: Session, ext_id: str) -> bool:
    """True when the extension exists on disk and is not switched off.

    An id with no directory is never enabled. An extension present on disk but
    with no row yet is enabled: :func:`sync` will create its row that way, and
    reading the flag must not depend on whether a sync has happened to run
    first.
    """
    if find(ext_id) is None:
        return False
    row = get_row(db, ext_id)
    return True if row is None else row.enabled


def set_enabled(db: Session, ext_id: str, enabled: bool, user_id: int | None = None) -> Extension:
    """Enable or disable an extension. Caller commits."""
    from opal.extensions import audit

    row = get_row(db, ext_id)
    if row is None:
        raise LookupError(f"unknown extension: {ext_id}")
    if row.enabled == enabled:
        return row

    old_values = audit.snapshot(row)
    row.enabled = enabled
    db.flush()
    audit.log_change(db, row, old_values, user_id=user_id)
    return row


__all__ = [
    "ORIGIN_BUNDLED",
    "ORIGIN_INSTALLED",
    "BrokenExtension",
    "DiscoveredExtension",
    "bundled_root",
    "discover",
    "find",
    "get_row",
    "installed_root",
    "is_enabled",
    "set_enabled",
    "sync",
]
