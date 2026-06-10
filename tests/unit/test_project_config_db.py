"""Project config in the database: round-trip, bootstrap precedence."""

import pytest

import opal.config as config_mod
from opal.config import (
    PROJECT_CONFIG_KEY,
    bootstrap_project_config,
    get_app_setting,
    load_project_from_db,
    save_project_to_db,
)
from opal.project import PartNumberingConfig, ProjectConfig, TierConfig


@pytest.fixture(autouse=True)
def _isolate_active_project(monkeypatch):
    """Module-global _active_project must not leak between tests."""
    monkeypatch.setattr(config_mod, "_active_project", None)


def _config(name: str = "Test Project") -> ProjectConfig:
    return ProjectConfig(
        name=name,
        description="desc",
        tiers=[TierConfig(level=1, name="FLIGHT", code="F", description="")],
        part_numbering=PartNumberingConfig(prefix="TST"),
        categories=["Propulsion"],
    )


def test_save_and_load_round_trip(db_session):
    save_project_to_db(db_session, _config())
    db_session.commit()

    config_mod._active_project = None
    loaded = load_project_from_db(db_session)
    assert loaded is not None
    assert loaded.name == "Test Project"
    assert loaded.part_numbering.prefix == "TST"
    assert loaded.tiers[0].code == "F"
    assert config_mod.get_active_project() is loaded


def test_load_returns_none_when_absent(db_session):
    assert load_project_from_db(db_session) is None


def test_bootstrap_db_blob_wins(db_session, tmp_path, monkeypatch):
    save_project_to_db(db_session, _config("From DB"))
    db_session.commit()

    # Even with a cwd yaml present, the DB blob is authoritative
    monkeypatch.chdir(tmp_path)
    (tmp_path / "opal.project.yaml").write_text("name: From Yaml\n")

    result = bootstrap_project_config(db_session)
    assert result.name == "From DB"


def test_bootstrap_imports_cwd_yaml_once(db_session, tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    (tmp_path / "opal.project.yaml").write_text("name: Yaml Project\n")

    result = bootstrap_project_config(db_session)
    assert result.name == "Yaml Project"
    # Persisted: the blob now exists in the DB
    assert "Yaml Project" in (get_app_setting(db_session, PROJECT_CONFIG_KEY) or "")

    # Second boot with the yaml deleted: config persists from the DB
    (tmp_path / "opal.project.yaml").unlink()
    config_mod._active_project = None
    again = bootstrap_project_config(db_session)
    assert again.name == "Yaml Project"


def test_bootstrap_noop_without_yaml_or_blob(db_session, tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    assert bootstrap_project_config(db_session) is None
    assert get_app_setting(db_session, PROJECT_CONFIG_KEY) is None
