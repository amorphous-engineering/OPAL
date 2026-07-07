"""The demo seeder must never write files to disk."""

import json

import pytest

import opal.config as config_mod
from opal.config import PROJECT_CONFIG_KEY, get_app_setting
from opal.seed import seed_database


@pytest.fixture(autouse=True)
def _isolate_active_project(monkeypatch):
    monkeypatch.setattr(config_mod, "_active_project", None)


def test_seed_writes_no_yaml_and_stores_config(db_session, tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)

    seed_database(db_session)

    assert not (tmp_path / "opal.project.yaml").exists()
    raw = get_app_setting(db_session, PROJECT_CONFIG_KEY)
    assert raw is not None
    config = json.loads(raw)
    assert config["name"] == "Mojave Sphinx"
    assert config["part_numbering"]["prefix"] == "SPX"
