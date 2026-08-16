"""Extension system: manifest validation, archive install, registry, imports."""

import io
import json
import zipfile
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from opal.db.models import Dataset, MasterProcedure, User
from opal.db.models.audit import AuditLog
from opal.db.models.extension import ORIGIN_BUNDLED, ORIGIN_INSTALLED, Extension
from opal.db.models.procedure import ProcedureStatus
from opal.extensions import registry
from opal.extensions.content import (
    IMPORTERS,
    ContentError,
    import_dataset,
    import_procedure,
    load_content,
)
from opal.extensions.install import InstallError, install_archive, uninstall
from opal.extensions.manifest import CAPABILITIES, ManifestError, parse_manifest
from tests.conftest import login

ONSHAPE_ID = "opal.onshape"


@pytest.fixture
def ext_dir(tmp_path: Path, monkeypatch) -> Path:
    """Point the installed-extension root at a per-test directory."""
    from opal.config import get_active_settings

    root = tmp_path / "extensions"
    root.mkdir()
    monkeypatch.setattr(get_active_settings(), "extension_dir", root)
    return root


def make_manifest(**overrides: object) -> str:
    fields = {
        "id": "acme.qms",
        "name": "ACME QMS Pack",
        "version": "1.0.0",
        "opal": ">=1.4",
        "summary": "Templates for the ACME quality system.",
    }
    fields.update(overrides)
    lines = [f"{key}: {json.dumps(value)}" for key, value in fields.items()]
    return "\n".join(lines) + "\n"


PROCEDURE_DOC = {
    "procedures": [
        {
            "key": "incoming-inspection",
            "name": "Incoming Inspection",
            "description": "Check received goods against the PO.",
            "type": "op",
            "steps": [
                {
                    "title": "Verify quantity",
                    "instructions": "Count against the packing slip.",
                    "sub_steps": [{"title": "Record discrepancies"}],
                },
                {"title": "Inspect for damage", "requires_signoff": True},
            ],
        }
    ]
}

DATASET_DOC = {
    "datasets": [
        {
            "key": "torque-log",
            "name": "Torque Log",
            "schema": {
                "fields": [{"name": "fastener", "type": "text"}, {"name": "nm", "type": "number"}]
            },
        }
    ]
}


def build_archive(
    manifest: str | None = None,
    *,
    files: dict[str, str] | None = None,
    prefix: str = "",
    extra_members: list[tuple[str, str]] | None = None,
) -> bytes:
    """Build an in-memory extension ZIP."""
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        if manifest is not None:
            archive.writestr(f"{prefix}opal-ext.yaml", manifest)
        for name, content in (files or {}).items():
            archive.writestr(f"{prefix}{name}", content)
        for name, content in extra_members or []:
            archive.writestr(name, content)
    return buffer.getvalue()


def content_archive(**manifest_overrides: object) -> bytes:
    manifest = make_manifest(
        provides={"procedures": ["procedures/*.json"], "datasets": ["datasets/*.json"]},
        **manifest_overrides,
    )
    return build_archive(
        manifest,
        files={
            "procedures/qms.json": json.dumps(PROCEDURE_DOC),
            "datasets/qms.json": json.dumps(DATASET_DOC),
        },
    )


# ============ Manifest ============


def test_manifest_parses_a_full_document() -> None:
    manifest = parse_manifest(
        make_manifest(
            author="ACME",
            license="MIT",
            homepage="https://example.com",
            provides={"procedures": ["procedures/*.json"]},
        )
    )
    assert manifest.id == "acme.qms"
    assert manifest.provides.procedures == ["procedures/*.json"]
    assert manifest.code is None


@pytest.mark.parametrize(
    "overrides",
    [
        {"id": "ACME.QMS"},
        {"id": "acme qms"},
        {"version": "one"},
        {"opal": "not-a-specifier"},
        {"homepage": "javascript:alert(1)"},
    ],
)
def test_manifest_rejects_bad_fields(overrides: dict) -> None:
    with pytest.raises(ManifestError):
        parse_manifest(make_manifest(**overrides))


def test_manifest_rejects_unknown_keys() -> None:
    with pytest.raises(ManifestError):
        parse_manifest(make_manifest(surprise="yes"))


def test_manifest_rejects_escaping_content_patterns() -> None:
    with pytest.raises(ManifestError):
        parse_manifest(make_manifest(provides={"procedures": ["../../etc/passwd"]}))
    with pytest.raises(ManifestError):
        parse_manifest(make_manifest(provides={"procedures": ["/etc/passwd"]}))


def test_prerelease_satisfies_its_own_feature_release() -> None:
    manifest = parse_manifest(make_manifest(opal=">=1.4"))
    assert manifest.compatible_with("1.4.0b2") is True
    assert manifest.compatible_with("1.5.0") is True
    assert manifest.compatible_with("1.3.9") is False


def test_every_declared_capability_has_an_importer() -> None:
    assert set(IMPORTERS) == set(CAPABILITIES)


# ============ Install ============


def test_install_unpacks_and_registers(db_session: Session, ext_dir: Path) -> None:
    row = install_archive(db_session, content_archive())
    db_session.commit()

    assert row.id == "acme.qms"
    assert row.origin == ORIGIN_INSTALLED
    assert row.enabled is True
    assert row.checksum and len(row.checksum) == 64
    assert (ext_dir / "acme.qms" / "opal-ext.yaml").is_file()
    assert (ext_dir / "acme.qms" / "procedures" / "qms.json").is_file()


def test_install_accepts_a_single_top_level_folder(db_session: Session, ext_dir: Path) -> None:
    archive = build_archive(
        make_manifest(provides={"datasets": ["datasets/*.json"]}),
        files={"datasets/qms.json": json.dumps(DATASET_DOC)},
        prefix="acme-qms-main/",
    )
    install_archive(db_session, archive)
    db_session.commit()
    assert (ext_dir / "acme.qms" / "datasets" / "qms.json").is_file()


def test_install_refuses_a_code_entry_point(db_session: Session, ext_dir: Path) -> None:
    archive = build_archive(
        make_manifest(
            provides={"datasets": ["datasets/*.json"]},
            code={"entry_point": "evil.module:register"},
        ),
        files={"datasets/qms.json": json.dumps(DATASET_DOC)},
    )
    with pytest.raises(InstallError, match="declarative-only"):
        install_archive(db_session, archive)
    assert not (ext_dir / "acme.qms").exists()


def test_install_refuses_path_traversal(db_session: Session, ext_dir: Path) -> None:
    archive = build_archive(
        make_manifest(provides={"datasets": ["datasets/*.json"]}),
        files={"datasets/qms.json": json.dumps(DATASET_DOC)},
        extra_members=[("../escaped.txt", "owned")],
    )
    with pytest.raises(InstallError, match="escapes"):
        install_archive(db_session, archive)
    assert not (ext_dir.parent / "escaped.txt").exists()
    assert not (ext_dir / "acme.qms").exists()


def test_install_refuses_absolute_member(db_session: Session, ext_dir: Path) -> None:
    archive = build_archive(
        make_manifest(provides={"datasets": ["datasets/*.json"]}),
        files={"datasets/qms.json": json.dumps(DATASET_DOC)},
        extra_members=[("/tmp/opal-owned.txt", "owned")],
    )
    with pytest.raises(InstallError, match="escapes|unsafe"):
        install_archive(db_session, archive)
    assert not Path("/tmp/opal-owned.txt").exists()


def test_install_refuses_a_symlink_member(db_session: Session, ext_dir: Path) -> None:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("opal-ext.yaml", make_manifest(provides={"datasets": ["d/*.json"]}))
        info = zipfile.ZipInfo("link")
        # 0xA1FF = S_IFLNK | 0777, the mode Info-ZIP writes for a symlink.
        info.external_attr = 0xA1FF << 16
        archive.writestr(info, "/etc/passwd")
    with pytest.raises(InstallError, match="symbolic link"):
        install_archive(db_session, buffer.getvalue())


def test_install_refuses_an_oversized_archive(
    db_session: Session, ext_dir: Path, monkeypatch
) -> None:
    from opal.config import get_active_settings

    monkeypatch.setattr(get_active_settings(), "max_extension_size", 128)
    with pytest.raises(InstallError, match="larger than"):
        install_archive(db_session, content_archive())


def test_install_refuses_a_manifestless_archive(db_session: Session, ext_dir: Path) -> None:
    with pytest.raises(InstallError, match="opal-ext.yaml"):
        install_archive(db_session, build_archive(None, files={"readme.txt": "hi"}))


def test_install_refuses_content_free_manifest(db_session: Session, ext_dir: Path) -> None:
    with pytest.raises(InstallError, match="no content"):
        install_archive(db_session, build_archive(make_manifest()))


def test_install_refuses_an_incompatible_extension(db_session: Session, ext_dir: Path) -> None:
    archive = build_archive(
        make_manifest(opal=">=99.0", provides={"datasets": ["datasets/*.json"]}),
        files={"datasets/qms.json": json.dumps(DATASET_DOC)},
    )
    with pytest.raises(InstallError, match="requires OPAL"):
        install_archive(db_session, archive)


def test_install_refuses_shadowing_a_bundled_id(db_session: Session, ext_dir: Path) -> None:
    archive = build_archive(
        make_manifest(id=ONSHAPE_ID, provides={"datasets": ["datasets/*.json"]}),
        files={"datasets/qms.json": json.dumps(DATASET_DOC)},
    )
    with pytest.raises(InstallError, match="bundled"):
        install_archive(db_session, archive)


def test_reinstall_upgrades_in_place(db_session: Session, ext_dir: Path) -> None:
    install_archive(db_session, content_archive())
    db_session.commit()
    install_archive(db_session, content_archive(version="2.0.0"))
    db_session.commit()

    rows = db_session.query(Extension).filter(Extension.id == "acme.qms").all()
    assert len(rows) == 1
    assert rows[0].version == "2.0.0"


def test_install_writes_an_audit_row(db_session: Session, ext_dir: Path, test_user: User) -> None:
    install_archive(db_session, content_archive(), user_id=test_user.id)
    db_session.commit()
    entries = db_session.query(AuditLog).filter(AuditLog.table_name == "extension").all()
    assert len(entries) == 1
    assert entries[0].new_values["id"] == "acme.qms"
    assert entries[0].user_id == test_user.id


# ============ Registry ============


def test_bundled_onshape_is_discovered() -> None:
    found, broken = registry.discover()
    onshape = next(ext for ext in found if ext.id == ONSHAPE_ID)
    assert onshape.origin == ORIGIN_BUNDLED
    assert onshape.manifest.code is not None
    assert broken == []


def test_sync_creates_rows_and_reaps_removed_directories(
    db_session: Session, ext_dir: Path
) -> None:
    install_archive(db_session, content_archive())
    db_session.commit()

    rows = {row.id: row for row in registry.sync(db_session)}
    db_session.commit()
    assert ONSHAPE_ID in rows and "acme.qms" in rows

    import shutil

    shutil.rmtree(ext_dir / "acme.qms")
    rows = {row.id: row for row in registry.sync(db_session)}
    db_session.commit()
    assert "acme.qms" not in rows


def test_disabled_extension_reads_as_disabled(db_session: Session, ext_dir: Path) -> None:
    registry.sync(db_session)
    assert registry.is_enabled(db_session, ONSHAPE_ID) is True

    registry.set_enabled(db_session, ONSHAPE_ID, False)
    db_session.commit()
    assert registry.is_enabled(db_session, ONSHAPE_ID) is False


def test_unknown_extension_is_never_enabled(db_session: Session, ext_dir: Path) -> None:
    assert registry.is_enabled(db_session, "no.such.extension") is False


def test_broken_directory_is_reported_not_swallowed(db_session: Session, ext_dir: Path) -> None:
    broken_dir = ext_dir / "acme.broken"
    broken_dir.mkdir()
    (broken_dir / "opal-ext.yaml").write_text("id: [not, a, string]\n", encoding="utf-8")

    found, broken = registry.discover()
    assert "acme.broken" not in {ext.id for ext in found}
    assert any(item.directory == "acme.broken" for item in broken)


def test_directory_name_must_match_the_manifest_id(db_session: Session, ext_dir: Path) -> None:
    mismatched = ext_dir / "wrong-name"
    mismatched.mkdir()
    (mismatched / "opal-ext.yaml").write_text(make_manifest(), encoding="utf-8")

    _, broken = registry.discover()
    assert any("does not match its directory name" in item.error for item in broken)


# ============ Uninstall ============


def test_uninstall_removes_files_and_row(db_session: Session, ext_dir: Path) -> None:
    install_archive(db_session, content_archive())
    db_session.commit()

    uninstall(db_session, "acme.qms")
    db_session.commit()

    assert not (ext_dir / "acme.qms").exists()
    assert registry.get_row(db_session, "acme.qms") is None


def test_uninstall_refuses_a_bundled_extension(db_session: Session, ext_dir: Path) -> None:
    registry.sync(db_session)
    db_session.commit()
    with pytest.raises(InstallError, match="bundled"):
        uninstall(db_session, ONSHAPE_ID)
    assert registry.get_row(db_session, ONSHAPE_ID) is not None


def test_uninstall_of_an_unknown_id_raises(db_session: Session, ext_dir: Path) -> None:
    with pytest.raises(LookupError):
        uninstall(db_session, "../../etc")


# ============ Content and import ============


def test_content_loads_declared_templates(db_session: Session, ext_dir: Path) -> None:
    install_archive(db_session, content_archive())
    db_session.commit()

    content = load_content(registry.find("acme.qms"))
    assert content.errors == []
    assert [item.key for item in content.procedures] == ["incoming-inspection"]
    assert [item.key for item in content.datasets] == ["torque-log"]


def test_malformed_content_is_reported_without_losing_the_rest(
    db_session: Session, ext_dir: Path
) -> None:
    install_archive(db_session, content_archive())
    db_session.commit()
    (ext_dir / "acme.qms" / "procedures" / "broken.json").write_text("{oops", encoding="utf-8")

    content = load_content(registry.find("acme.qms"))
    assert len(content.errors) == 1
    assert len(content.procedures) == 1


def test_import_procedure_creates_a_draft_with_steps(db_session: Session, ext_dir: Path) -> None:
    install_archive(db_session, content_archive())
    db_session.commit()

    procedure = import_procedure(db_session, registry.find("acme.qms"), "incoming-inspection")
    db_session.commit()

    assert procedure.name == "Incoming Inspection"
    assert procedure.status == ProcedureStatus.DRAFT
    steps = sorted(procedure.steps, key=lambda step: step.order)
    assert [step.step_number for step in steps] == ["1", "1.1", "2"]
    assert [step.level for step in steps] == [0, 1, 0]
    assert steps[2].requires_signoff is True
    assert db_session.query(MasterProcedure).filter_by(name="Incoming Inspection").count() == 1


def test_import_dataset_creates_a_dataset(db_session: Session, ext_dir: Path) -> None:
    install_archive(db_session, content_archive())
    db_session.commit()

    dataset = import_dataset(db_session, registry.find("acme.qms"), "torque-log")
    db_session.commit()

    assert dataset.name == "Torque Log"
    assert [field["name"] for field in dataset.schema["fields"]] == ["fastener", "nm"]
    assert db_session.query(Dataset).filter_by(name="Torque Log").count() == 1


def test_import_of_an_unknown_key_raises(db_session: Session, ext_dir: Path) -> None:
    install_archive(db_session, content_archive())
    db_session.commit()
    with pytest.raises(ContentError):
        import_procedure(db_session, registry.find("acme.qms"), "nope")


# ============ Web ============


def test_settings_page_lists_extensions(
    client: TestClient, db_session: Session, admin_user: User, ext_dir: Path
) -> None:
    login(client, admin_user)
    response = client.get("/settings")
    assert response.status_code == 200
    assert "EXTENSIONS" in response.text
    assert ONSHAPE_ID in response.text


def test_extensions_page_renders(
    client: TestClient, db_session: Session, admin_user: User, ext_dir: Path
) -> None:
    login(client, admin_user)
    response = client.get("/settings/extensions")
    assert response.status_code == 200
    assert "INSTALL" in response.text


def test_extension_detail_renders_the_onshape_panel(
    client: TestClient, db_session: Session, admin_user: User, ext_dir: Path
) -> None:
    login(client, admin_user)
    response = client.get(f"/settings/extensions/{ONSHAPE_ID}")
    assert response.status_code == 200
    assert "ONSHAPE INTEGRATION" in response.text


def test_unknown_extension_detail_redirects(
    client: TestClient, db_session: Session, admin_user: User, ext_dir: Path
) -> None:
    login(client, admin_user)
    response = client.get("/settings/extensions/no.such.ext", follow_redirects=False)
    assert response.status_code == 302


def test_web_install_and_uninstall_roundtrip(
    client: TestClient, db_session: Session, admin_user: User, ext_dir: Path
) -> None:
    login(client, admin_user)

    response = client.post(
        "/settings/extensions/install",
        files={"archive": ("acme.zip", content_archive(), "application/zip")},
    )
    assert response.status_code == 200
    assert "Installed acme.qms" in response.text
    assert (ext_dir / "acme.qms").is_dir()

    response = client.post("/settings/extensions/acme.qms/uninstall")
    assert response.status_code == 200
    assert "Uninstalled acme.qms" in response.text
    assert not (ext_dir / "acme.qms").exists()


def test_web_install_reports_a_rejected_archive(
    client: TestClient, db_session: Session, admin_user: User, ext_dir: Path
) -> None:
    login(client, admin_user)
    response = client.post(
        "/settings/extensions/install",
        files={"archive": ("bad.zip", b"not a zip at all", "application/zip")},
    )
    assert response.status_code == 200
    assert "not a readable ZIP archive" in response.text


def test_non_admin_cannot_install(
    client: TestClient, db_session: Session, test_user: User, ext_dir: Path
) -> None:
    login(client, test_user)
    response = client.post(
        "/settings/extensions/install",
        files={"archive": ("acme.zip", content_archive(), "application/zip")},
        follow_redirects=False,
    )
    assert response.status_code == 302
    assert not (ext_dir / "acme.qms").exists()


def test_non_admin_cannot_toggle(
    client: TestClient, db_session: Session, test_user: User, ext_dir: Path
) -> None:
    registry.sync(db_session)
    db_session.commit()
    login(client, test_user)
    response = client.post(f"/settings/extensions/{ONSHAPE_ID}/disable", follow_redirects=False)
    assert response.status_code == 302
    assert registry.is_enabled(db_session, ONSHAPE_ID) is True


def test_web_toggle_disables_and_reenables(
    client: TestClient, db_session: Session, admin_user: User, ext_dir: Path
) -> None:
    login(client, admin_user)

    response = client.post(f"/settings/extensions/{ONSHAPE_ID}/disable")
    assert response.status_code == 200
    assert registry.is_enabled(db_session, ONSHAPE_ID) is False

    response = client.post(f"/settings/extensions/{ONSHAPE_ID}/enable")
    assert response.status_code == 200
    assert registry.is_enabled(db_session, ONSHAPE_ID) is True


def test_import_requires_the_extension_to_be_enabled(
    client: TestClient, db_session: Session, admin_user: User, ext_dir: Path
) -> None:
    install_archive(db_session, content_archive())
    registry.sync(db_session)
    registry.set_enabled(db_session, "acme.qms", False)
    db_session.commit()

    login(client, admin_user)
    response = client.post("/settings/extensions/acme.qms/import/procedures/incoming-inspection")
    assert response.status_code == 200
    assert "Enable this extension" in response.text
    assert db_session.query(MasterProcedure).filter_by(name="Incoming Inspection").count() == 0


def test_web_import_creates_the_procedure(
    client: TestClient, db_session: Session, admin_user: User, ext_dir: Path
) -> None:
    install_archive(db_session, content_archive())
    db_session.commit()

    login(client, admin_user)
    response = client.post("/settings/extensions/acme.qms/import/procedures/incoming-inspection")
    assert response.status_code == 200
    assert "Imported Incoming Inspection" in response.text
    assert db_session.query(MasterProcedure).filter_by(name="Incoming Inspection").count() == 1
