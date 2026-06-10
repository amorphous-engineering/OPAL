"""The CLI always reports which database it resolved, and on stderr.

Regression for the MCP/web split-brain: `opal mcp` and `opal serve` launched
from different shells silently resolved different SQLite files, so agents and
humans each "verified" against their own database. The resolved URL (and its
provenance) must be printed for every launch path, and never on stdout —
stdout is the MCP stdio protocol channel.
"""

import argparse

import pytest

import opal.config as config
from opal.__main__ import _setup_project


@pytest.fixture(autouse=True)
def _reset_runtime_settings(monkeypatch):
    """Isolate the global runtime-settings/project state mutated by _setup_project."""
    monkeypatch.setattr(config, "_runtime_settings", None)
    monkeypatch.setattr(config, "_active_project", None)
    config.get_settings.cache_clear()
    yield
    config.get_settings.cache_clear()


def _namespace(**kwargs) -> argparse.Namespace:
    return argparse.Namespace(**kwargs)


def test_reports_platform_default_database(capsys, monkeypatch, tmp_path):
    monkeypatch.delenv("OPAL_DATABASE_URL", raising=False)
    monkeypatch.chdir(tmp_path)  # no opal.project.yaml here

    _setup_project(_namespace())

    out, err = capsys.readouterr()
    assert out == ""
    assert "Database: sqlite:///" in err
    assert "(platform default)" in err


def test_reports_env_override(capsys, monkeypatch, tmp_path):
    monkeypatch.setenv("OPAL_DATABASE_URL", f"sqlite:///{tmp_path / 'elsewhere.db'}")
    monkeypatch.chdir(tmp_path)

    _setup_project(_namespace())

    out, err = capsys.readouterr()
    assert out == ""
    assert f"Database: sqlite:///{tmp_path / 'elsewhere.db'}" in err
    assert "(OPAL_DATABASE_URL environment override)" in err


def test_reports_explicit_database_flag(capsys, monkeypatch, tmp_path):
    monkeypatch.delenv("OPAL_DATABASE_URL", raising=False)
    db_file = tmp_path / "explicit.db"

    _setup_project(_namespace(database=str(db_file)))

    out, err = capsys.readouterr()
    assert out == ""
    assert f"Database: sqlite:///{db_file.resolve()}" in err
    assert "(--database)" in err


def test_reports_autodetected_project(capsys, monkeypatch, tmp_path):
    monkeypatch.delenv("OPAL_DATABASE_URL", raising=False)
    (tmp_path / "opal.project.yaml").write_text("name: Probe\n", encoding="utf-8")
    monkeypatch.chdir(tmp_path)

    _setup_project(_namespace())

    out, err = capsys.readouterr()
    assert out == ""
    assert "Using project: Probe" in err
    assert f"Database: sqlite:///{tmp_path / 'data' / 'opal.db'}" in err
    assert "(opal.project.yaml auto-detected)" in err
