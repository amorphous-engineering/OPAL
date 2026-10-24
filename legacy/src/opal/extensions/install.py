"""Install and uninstall extensions from uploaded ZIP archives.

An uploaded archive is untrusted input that becomes files on the operator's
machine, so extraction is deliberately paranoid:

- the archive is size-capped before it is opened, and again on its declared
  uncompressed total and member count (zip bombs);
- member names are rejected outright if absolute, drive-qualified, or
  containing ``..`` (zip slip), and every resolved path is re-checked against
  the staging root after joining;
- symlinks and every other non-regular member are refused — a symlink is how
  an archive reaches outside the directory it was allowed to write;
- a ``code:`` key is refused, because nothing in the declarative path executes
  extension-supplied Python and an operator must not believe otherwise.

Extraction happens into a staging directory next to the destination and is
moved into place only once the manifest has validated, so a failed install
leaves no half-extracted extension behind.
"""

from __future__ import annotations

import hashlib
import io
import logging
import os
import shutil
import stat
import tempfile
import zipfile
from datetime import UTC, datetime
from pathlib import Path, PurePosixPath

from sqlalchemy.orm import Session

from opal.db.models.extension import ORIGIN_INSTALLED, Extension
from opal.extensions import audit, registry
from opal.extensions.manifest import (
    MANIFEST_FILENAME,
    ExtensionManifest,
    ManifestError,
    parse_manifest,
)

logger = logging.getLogger("opal.extensions")

#: Hard ceilings on what an archive may expand to, independent of the upload
#: size cap: a small archive can still declare an enormous payload.
MAX_MEMBERS = 2_000
MAX_UNCOMPRESSED_BYTES = 64 * 1024 * 1024


class InstallError(ValueError):
    """The archive was rejected. The message is shown to the operator."""


def _read_manifest_member(archive: zipfile.ZipFile) -> tuple[str, ExtensionManifest]:
    """Locate the manifest and return (prefix, manifest).

    Accepts both archive layouts operators actually produce: the manifest at
    the archive root, or inside a single top-level directory (what "Download
    ZIP" and ``git archive`` both make).
    """
    candidates = [
        name
        for name in archive.namelist()
        if PurePosixPath(name).name == MANIFEST_FILENAME
        and len(PurePosixPath(name).parts) <= 2
        and not name.startswith("/")
    ]
    if not candidates:
        raise InstallError(
            f"archive has no {MANIFEST_FILENAME} at its root or in a single top-level folder"
        )
    if len(candidates) > 1:
        raise InstallError(f"archive contains more than one {MANIFEST_FILENAME}")

    member = candidates[0]
    prefix = str(PurePosixPath(member).parent)
    prefix = "" if prefix == "." else prefix

    try:
        raw = archive.read(member).decode("utf-8")
    except (KeyError, UnicodeDecodeError, zipfile.BadZipFile) as err:
        raise InstallError(f"cannot read {MANIFEST_FILENAME}: {err}") from err

    try:
        return prefix, parse_manifest(raw)
    except ManifestError as err:
        raise InstallError(str(err)) from err


def _safe_relative_path(name: str, prefix: str) -> PurePosixPath | None:
    """Return the destination-relative path for an archive member, or None to skip.

    Raises :class:`InstallError` when the member name is hostile.
    """
    path = PurePosixPath(name)
    if not path.parts:
        return None
    if path.is_absolute() or name.startswith("/") or name.startswith("\\"):
        raise InstallError(f"archive member escapes the extension directory: {name}")
    if ".." in path.parts:
        raise InstallError(f"archive member escapes the extension directory: {name}")
    # A Windows drive letter or UNC prefix survives PurePosixPath intact.
    if ":" in path.parts[0] or name.startswith("\\\\"):
        raise InstallError(f"archive member has an unsafe name: {name}")

    if prefix:
        if path.parts[:1] != (prefix,):
            # Content outside the single top-level directory is not ours.
            return None
        path = PurePosixPath(*path.parts[1:])
    if not path.parts:
        return None
    return path


def _extract(archive: zipfile.ZipFile, prefix: str, dest: Path) -> None:
    """Extract members under ``prefix`` into ``dest``, refusing anything unsafe."""
    infos = archive.infolist()
    if len(infos) > MAX_MEMBERS:
        raise InstallError(f"archive has more than {MAX_MEMBERS} entries")
    total = sum(info.file_size for info in infos)
    if total > MAX_UNCOMPRESSED_BYTES:
        raise InstallError(
            f"archive expands to more than {MAX_UNCOMPRESSED_BYTES // (1024 * 1024)} MB"
        )

    dest_root = dest.resolve()
    written = 0
    for info in infos:
        relative = _safe_relative_path(info.filename, prefix)
        if relative is None:
            continue

        mode = info.external_attr >> 16
        if stat.S_ISLNK(mode):
            raise InstallError(f"archive contains a symbolic link: {info.filename}")

        target = (dest_root / Path(*relative.parts)).resolve()
        if target != dest_root and dest_root not in target.parents:
            raise InstallError(f"archive member escapes the extension directory: {info.filename}")

        if info.is_dir():
            target.mkdir(parents=True, exist_ok=True)
            continue
        # Many writers (including zipfile.writestr) record permission bits
        # only, leaving the file-type bits zero. Judge a member unsafe when it
        # states a type and that type is not "regular file".
        file_type = mode & 0o170000
        if file_type and file_type != stat.S_IFREG:
            raise InstallError(f"archive contains a non-regular file: {info.filename}")

        target.parent.mkdir(parents=True, exist_ok=True)
        with archive.open(info) as source, open(target, "wb") as handle:
            written += _copy_capped(source, handle, MAX_UNCOMPRESSED_BYTES - written)


def _copy_capped(source: io.BufferedIOBase, handle: io.BufferedWriter, budget: int) -> int:
    """Stream one member, stopping if it exceeds the remaining budget.

    ``file_size`` in the central directory is a claim, not a guarantee; this
    enforces the real total against the same ceiling.
    """
    copied = 0
    while True:
        chunk = source.read(64 * 1024)
        if not chunk:
            return copied
        copied += len(chunk)
        if copied > budget:
            raise InstallError("archive expands past its declared size")
        handle.write(chunk)


def install_archive(db: Session, data: bytes, user_id: int | None = None) -> Extension:
    """Install (or upgrade in place) an extension from ZIP bytes. Caller commits."""
    from opal.config import get_active_settings

    settings = get_active_settings()
    if not data:
        raise InstallError("no file was uploaded")
    if len(data) > settings.max_extension_size:
        limit_mb = settings.max_extension_size / (1024 * 1024)
        raise InstallError(f"archive is larger than the {limit_mb:.0f} MB limit")

    try:
        archive = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile as err:
        raise InstallError(f"not a readable ZIP archive: {err}") from err

    with archive:
        prefix, manifest = _read_manifest_member(archive)

        if manifest.code is not None:
            raise InstallError(
                "this archive declares a code: entry point. Installed extensions are "
                "declarative-only in this release — only extensions bundled with OPAL "
                "may run Python."
            )
        if manifest.provides.is_empty():
            raise InstallError("manifest declares no content under provides:")
        if not manifest.compatible_with():
            from opal import __version__

            raise InstallError(
                f"{manifest.name} requires OPAL {manifest.opal}; this instance is {__version__}"
            )

        bundled = registry.bundled_root() / manifest.id
        if bundled.is_dir():
            raise InstallError(f"{manifest.id} is a bundled extension and cannot be replaced")

        root = registry.installed_root()
        root.mkdir(parents=True, exist_ok=True)
        destination = root / manifest.id

        staging = Path(tempfile.mkdtemp(prefix=f".{manifest.id}.", dir=root))
        try:
            _extract(archive, prefix, staging)
            if not (staging / MANIFEST_FILENAME).is_file():
                raise InstallError(f"archive did not yield a {MANIFEST_FILENAME}")
            _swap_into_place(staging, destination)
        except Exception:
            shutil.rmtree(staging, ignore_errors=True)
            raise

    checksum = hashlib.sha256(data).hexdigest()
    row = _upsert_row(db, manifest, checksum, user_id)
    logger.info("Installed extension %s %s", manifest.id, manifest.version)
    return row


def _swap_into_place(staging: Path, destination: Path) -> None:
    """Move ``staging`` onto ``destination``, keeping the old copy until it lands."""
    previous: Path | None = None
    if destination.exists():
        previous = destination.with_name(f".{destination.name}.previous")
        shutil.rmtree(previous, ignore_errors=True)
        os.replace(destination, previous)
    try:
        os.replace(staging, destination)
    except OSError:
        if previous is not None and not destination.exists():
            os.replace(previous, destination)
        raise
    if previous is not None:
        shutil.rmtree(previous, ignore_errors=True)


def _upsert_row(
    db: Session, manifest: ExtensionManifest, checksum: str, user_id: int | None
) -> Extension:
    row = registry.get_row(db, manifest.id)
    manifest_data = manifest.model_dump(mode="json")
    if row is None:
        row = Extension(
            id=manifest.id,
            name=manifest.name,
            version=manifest.version,
            summary=manifest.summary,
            origin=ORIGIN_INSTALLED,
            enabled=True,
            installed_at=datetime.now(UTC),
            checksum=checksum,
            manifest=manifest_data,
        )
        db.add(row)
        db.flush()
        audit.log_install(db, row, user_id=user_id)
        return row

    old_values = audit.snapshot(row)
    row.name = manifest.name
    row.version = manifest.version
    row.summary = manifest.summary
    row.origin = ORIGIN_INSTALLED
    row.checksum = checksum
    row.manifest = manifest_data
    db.flush()
    audit.log_change(db, row, old_values, user_id=user_id)
    return row


def uninstall(db: Session, ext_id: str, user_id: int | None = None) -> None:
    """Remove an installed extension's files and registry row. Caller commits.

    Content already imported into the project — procedures, datasets — stays.
    It became project data at import; an uninstall is not a retraction.
    """
    row = registry.get_row(db, ext_id)
    discovered = registry.find(ext_id)

    if row is None and discovered is None:
        raise LookupError(f"unknown extension: {ext_id}")
    if (row is not None and row.is_bundled) or (discovered is not None and discovered.is_bundled):
        raise InstallError(f"{ext_id} is bundled with OPAL and cannot be uninstalled")

    root = registry.installed_root().resolve()
    target = (root / ext_id).resolve()
    # ext_id passed the manifest id pattern, so it cannot traverse; re-check
    # anyway because this call deletes a directory tree.
    if target != root and root in target.parents and target.is_dir():
        shutil.rmtree(target, ignore_errors=True)

    if row is not None:
        audit.log_uninstall(db, row, user_id=user_id)
        db.delete(row)
    logger.info("Uninstalled extension %s", ext_id)
