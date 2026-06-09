"""Tests for FTS5-backed global search (opal.db.fts + /api/search)."""

from collections.abc import Generator

import pytest
from sqlalchemy import create_engine, inspect
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from opal.db.base import Base
from opal.db.fts import ENTITY_SPECS, create_fts_schema, drop_fts_schema, fts_ready
from opal.db.models import Part, Supplier
from opal.db.models.issue import Issue


@pytest.fixture
def fts_engine():
    """Engine with full schema plus FTS index tables and triggers."""
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(bind=engine)
    with engine.begin() as conn:
        assert create_fts_schema(conn) is True
    return engine


@pytest.fixture
def fts_session(fts_engine) -> Generator[Session, None, None]:
    SessionLocal = sessionmaker(bind=fts_engine)
    session = SessionLocal()
    yield session
    session.close()


def test_fts_schema_creates_all_index_tables(fts_engine) -> None:
    inspector = inspect(fts_engine)
    for spec in ENTITY_SPECS:
        assert inspector.has_table(spec.fts_table), spec.fts_table
    assert fts_ready(fts_engine)


def test_fts_index_tracks_insert_update_delete(fts_engine, fts_session) -> None:
    part = Part(name="Flux Capacitor", internal_pn="PN-0001", tier=1)
    fts_session.add(part)
    fts_session.commit()

    def match_count(term: str) -> int:
        with fts_engine.connect() as conn:
            return conn.exec_driver_sql(
                "SELECT count(*) FROM part_fts WHERE part_fts MATCH ?", (f'"{term}"',)
            ).scalar_one()

    assert match_count("capacitor") == 1

    part.name = "Warp Coil"
    fts_session.commit()
    assert match_count("capacitor") == 0
    assert match_count("warp") == 1

    fts_session.delete(part)
    fts_session.commit()
    assert match_count("warp") == 0


def test_search_endpoint_uses_fts(fts_engine, fts_session) -> None:
    from fastapi.testclient import TestClient

    from opal.api.app import create_app
    from opal.api.deps import get_db

    fts_session.add(Part(name="Oscillator Crystal", internal_pn="PN-OSC-1", tier=1))
    fts_session.add(Supplier(name="Oscillator Supply Co", code="OSC"))
    fts_session.add(Issue(title="Oscillator drift over temperature", issue_number="IT-00001"))
    # Soft-deleted entities must not appear
    deleted = Part(name="Oscillator Mk1", internal_pn="PN-OSC-0", tier=1)
    fts_session.add(deleted)
    fts_session.commit()
    deleted.soft_delete()
    fts_session.commit()

    app = create_app()

    def _get_db():
        yield fts_session

    app.dependency_overrides[get_db] = _get_db
    client = TestClient(app)

    r = client.get("/api/search", params={"q": "oscillator"})
    assert r.status_code == 200
    results = r.json()
    types = {item["entity_type"] for item in results}
    assert {"part", "supplier", "issue"} <= types
    part_labels = [item["label"] for item in results if item["entity_type"] == "part"]
    assert "Oscillator Crystal" in part_labels
    assert "Oscillator Mk1" not in part_labels

    # Short queries fall back to ILIKE and still return results
    r = client.get("/api/search", params={"q": "os"})
    assert r.status_code == 200
    assert any(item["entity_type"] == "part" for item in r.json())


def test_search_falls_back_without_fts_tables(fts_engine, fts_session) -> None:
    from fastapi.testclient import TestClient

    from opal.api.app import create_app
    from opal.api.deps import get_db

    fts_session.add(Part(name="Gyroscope Mount", internal_pn="PN-GYRO-1", tier=1))
    fts_session.commit()

    with fts_engine.begin() as conn:
        drop_fts_schema(conn)
    assert not fts_ready(fts_engine)

    app = create_app()

    def _get_db():
        yield fts_session

    app.dependency_overrides[get_db] = _get_db
    client = TestClient(app)

    r = client.get("/api/search", params={"q": "gyroscope"})
    assert r.status_code == 200
    assert any(item["label"] == "Gyroscope Mount" for item in r.json())
