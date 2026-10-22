"""Extension registry API.

The filesystem says what exists; the ``extension`` table says what the operator
decided. Every read reconciles the two (``registry.sync``) so a directory added
or removed by hand shows up without a restart. Reads are open to any signed-in
user; every mutation is admin-only.
"""

import logging
from typing import Any

from fastapi import APIRouter, HTTPException, Request, UploadFile, status
from pydantic import BaseModel
from sqlalchemy.orm import Session

from opal.api.deps import DbSession, RequiredAdmin, RequiredUser
from opal.config import get_active_settings

logger = logging.getLogger("opal.extensions")

router = APIRouter(prefix="/extensions", tags=["extensions"])


class ExtensionSummary(BaseModel):
    id: str
    name: str
    version: str
    origin: str
    enabled: bool
    compatible: bool
    #: Capability name -> how many items the manifest declares (content packs).
    provides: dict[str, int]
    has_code: bool


class BrokenExtensionInfo(BaseModel):
    directory: str
    error: str


class ExtensionList(BaseModel):
    items: list[ExtensionSummary]
    broken: list[BrokenExtensionInfo]
    extension_dir: str
    max_archive_bytes: int


class ProcedureItem(BaseModel):
    key: str
    name: str
    type: str
    steps: int


class DatasetItem(BaseModel):
    key: str
    name: str
    fields: int


class ExtensionDetail(ExtensionSummary):
    summary: str | None
    author: str | None
    license: str | None
    homepage: str | None
    requires: str
    is_bundled: bool
    checksum: str | None
    installed_at: str | None
    path: str
    declares: dict[str, bool]
    procedures: list[ProcedureItem]
    datasets: list[DatasetItem]
    content_errors: list[str]


def _row_map(db: Session) -> dict[str, Any]:
    from opal.db.models.extension import Extension as ExtensionModel
    from opal.extensions import registry

    try:
        rows = {row.id: row for row in registry.sync(db)}
        db.commit()
    except Exception:
        logger.warning("Extension registry sync failed", exc_info=True)
        db.rollback()
        rows = {row.id: row for row in db.query(ExtensionModel).all()}
    return rows


def _summary(ext: Any, row: Any) -> dict[str, Any]:
    from opal.extensions.manifest import CAPABILITIES

    provides = ext.manifest.provides
    return {
        "id": ext.id,
        "name": ext.manifest.name,
        "version": ext.manifest.version,
        "origin": ext.origin,
        "enabled": row.enabled if row is not None else True,
        "compatible": ext.manifest.compatible_with(),
        "provides": {
            name: len(getattr(provides, name)) for name in CAPABILITIES if getattr(provides, name)
        },
        "has_code": ext.manifest.code is not None,
    }


def _detail(db: Session, ext_id: str) -> ExtensionDetail | None:
    from opal.extensions import registry
    from opal.extensions.content import load_content
    from opal.extensions.manifest import CAPABILITIES

    ext = registry.find(ext_id)
    if ext is None:
        return None
    rows = _row_map(db)
    row = rows.get(ext_id) or registry.get_row(db, ext_id)
    manifest = ext.manifest
    content = load_content(ext)
    return ExtensionDetail(
        **_summary(ext, row),
        summary=manifest.summary,
        author=manifest.author,
        license=manifest.license,
        homepage=manifest.homepage,
        requires=manifest.opal,
        is_bundled=ext.is_bundled,
        checksum=row.checksum if row is not None else None,
        installed_at=row.installed_at.isoformat() if row is not None else None,
        path=str(ext.root),
        declares={name: bool(getattr(manifest.provides, name)) for name in CAPABILITIES},
        procedures=[
            ProcedureItem(key=p.key, name=p.name, type=p.type, steps=len(p.steps))
            for p in content.procedures
        ],
        datasets=[
            DatasetItem(key=d.key, name=d.name, fields=len(d.schema_.get("fields", [])))
            for d in content.datasets
        ],
        content_errors=content.errors,
    )


def _detail_or_404(db: Session, ext_id: str) -> ExtensionDetail:
    detail = _detail(db, ext_id)
    if detail is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail=f"Extension {ext_id} not found")
    return detail


@router.get("", response_model=ExtensionList)
def list_extensions(db: DbSession, user: RequiredUser) -> ExtensionList:
    """Installed extensions with their state, plus directories that failed to load."""
    from opal.extensions import registry

    rows = _row_map(db)
    found, broken = registry.discover()
    return ExtensionList(
        items=[ExtensionSummary(**_summary(ext, rows.get(ext.id))) for ext in found],
        broken=[BrokenExtensionInfo(directory=b.directory, error=b.error) for b in broken],
        extension_dir=str(registry.installed_root()),
        max_archive_bytes=get_active_settings().max_extension_size,
    )


@router.post("/install", response_model=ExtensionDetail, status_code=status.HTTP_201_CREATED)
async def install_extension(
    archive: UploadFile, db: DbSession, admin: RequiredAdmin
) -> ExtensionDetail:
    """Install an extension from an uploaded ZIP archive. Content packs only."""
    from opal.extensions.install import InstallError, install_archive

    limit = get_active_settings().max_extension_size
    data = await archive.read(limit + 1)
    try:
        row = install_archive(db, data, user_id=admin.id)
        db.commit()
    except InstallError as err:
        db.rollback()
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail=str(err)) from err
    except Exception as err:
        db.rollback()
        logger.warning("Extension install failed", exc_info=True)
        raise HTTPException(
            status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Install failed; see the server log"
        ) from err
    return _detail_or_404(db, row.id)


@router.get("/{ext_id}", response_model=ExtensionDetail)
def get_extension(ext_id: str, db: DbSession, user: RequiredUser) -> ExtensionDetail:
    """One extension: manifest, state and the content it offers."""
    return _detail_or_404(db, ext_id)


def _set_state(
    request: Request, db: Session, ext_id: str, admin: Any, *, enabled: bool
) -> ExtensionDetail:
    from opal.extensions import registry
    from opal.extensions.loader import activate as activate_extensions

    try:
        registry.sync(db)
        registry.set_enabled(db, ext_id, enabled, user_id=admin.id)
        db.commit()
    except LookupError as err:
        db.rollback()
        raise HTTPException(
            status.HTTP_404_NOT_FOUND, detail=f"Extension {ext_id} not found"
        ) from err
    # Background work owned by a code extension follows its state immediately.
    activate_extensions(request.app)
    return _detail_or_404(db, ext_id)


@router.post("/{ext_id}/enable", response_model=ExtensionDetail)
def enable_extension(
    ext_id: str, request: Request, db: DbSession, admin: RequiredAdmin
) -> ExtensionDetail:
    return _set_state(request, db, ext_id, admin, enabled=True)


@router.post("/{ext_id}/disable", response_model=ExtensionDetail)
def disable_extension(
    ext_id: str, request: Request, db: DbSession, admin: RequiredAdmin
) -> ExtensionDetail:
    return _set_state(request, db, ext_id, admin, enabled=False)


@router.delete("/{ext_id}", status_code=status.HTTP_204_NO_CONTENT)
def uninstall_extension(ext_id: str, db: DbSession, admin: RequiredAdmin) -> None:
    """Delete an installed extension's files and registry row. Bundled ones refuse."""
    from opal.extensions.install import InstallError, uninstall

    try:
        uninstall(db, ext_id, user_id=admin.id)
        db.commit()
    except LookupError as err:
        db.rollback()
        raise HTTPException(
            status.HTTP_404_NOT_FOUND, detail=f"Extension {ext_id} not found"
        ) from err
    except InstallError as err:
        db.rollback()
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail=str(err)) from err


class ImportResult(BaseModel):
    kind: str
    name: str
    href: str


_IMPORT_HREFS = {"procedures": "/procedures/{id}", "datasets": "/datasets/{id}"}


@router.post("/{ext_id}/import/{kind}/{key}", response_model=ImportResult)
def import_template(
    ext_id: str, kind: str, key: str, db: DbSession, admin: RequiredAdmin
) -> ImportResult:
    """Import one template into the project as ordinary project data."""
    from opal.extensions import registry
    from opal.extensions.content import IMPORTERS, ContentError

    ext = registry.find(ext_id)
    importer = IMPORTERS.get(kind)
    if ext is None or importer is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="No such extension or template kind")
    if not registry.is_enabled(db, ext_id):
        raise HTTPException(
            status.HTTP_409_CONFLICT, detail="Enable this extension before importing"
        )
    try:
        created = importer(db, ext, key, user_id=admin.id)
        db.commit()
    except ContentError as err:
        db.rollback()
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail=str(err)) from err
    except Exception as err:
        db.rollback()
        logger.warning("Extension import failed", exc_info=True)
        raise HTTPException(
            status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Import failed; see the server log"
        ) from err
    return ImportResult(
        kind=kind, name=created.name, href=_IMPORT_HREFS[kind].format(id=created.id)
    )
