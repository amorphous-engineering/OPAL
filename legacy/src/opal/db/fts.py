"""SQLite FTS5 full-text search schema (index tables plus sync triggers).

One external-content FTS5 table per searchable entity, kept in sync with
AFTER INSERT/UPDATE/DELETE triggers so global search runs against an index
instead of LIKE full-table scans. The schema is generated from ENTITY_SPECS
so the Alembic migration, init_database() and tests all build the identical
schema.

The trigram tokenizer gives substring matching equivalent to the previous
ILIKE '%term%' behavior for terms of three or more characters; shorter
queries fall back to ILIKE in the search endpoint.
"""

import logging
from collections.abc import Iterator
from dataclasses import dataclass

from sqlalchemy import Column, Integer, MetaData, Table, Text, inspect
from sqlalchemy.engine import Connection

logger = logging.getLogger("opal.db.fts")

FTS_COLUMNS = ("title", "subtitle", "body")
TRIGGER_SUFFIXES = ("ai", "au", "ad")


@dataclass(frozen=True)
class FtsEntity:
    """Mapping from a source table to its FTS index table.

    Column expressions use a ``{row}`` placeholder that is substituted with
    ``new``/``old`` inside triggers and the table name in backfills.
    """

    entity_type: str
    table: str
    fts_table: str
    title: str
    subtitle: str = "''"
    body: str = "''"

    def values_sql(self, row: str) -> str:
        return ", ".join(expr.format(row=row) for expr in (self.title, self.subtitle, self.body))


ENTITY_SPECS: tuple[FtsEntity, ...] = (
    FtsEntity(
        "part",
        "part",
        "part_fts",
        "{row}.name",
        "coalesce({row}.internal_pn,'') || ' ' || coalesce({row}.external_pn,'')",
        "coalesce({row}.description,'')",
    ),
    FtsEntity("issue", "issue", "issue_fts", "{row}.title", body="coalesce({row}.description,'')"),
    FtsEntity("procedure", "master_procedure", "master_procedure_fts", "{row}.name"),
    FtsEntity(
        "execution",
        "procedure_instance",
        "procedure_instance_fts",
        "coalesce({row}.work_order_number,'')",
    ),
    FtsEntity("risk", "risk", "risk_fts", "{row}.title", body="coalesce({row}.description,'')"),
    FtsEntity("supplier", "supplier", "supplier_fts", "{row}.name", "coalesce({row}.code,'')"),
    FtsEntity(
        "purchase",
        "purchase",
        "purchase_fts",
        "coalesce({row}.reference,'')",
        body="coalesce({row}.notes,'')",
    ),
    FtsEntity(
        "requirement",
        "requirement",
        "requirement_fts",
        "{row}.title",
        "coalesce({row}.req_number,'')",
        "coalesce({row}.statement,'')",
    ),
    FtsEntity("dataset", "dataset", "dataset_fts", "{row}.name"),
    FtsEntity(
        "workcenter", "workcenter", "workcenter_fts", "{row}.name", "coalesce({row}.code,'')"
    ),
)

# Core Table objects for querying the FTS tables from the application
_metadata = MetaData()
_fts_tables: dict[str, Table] = {}


def fts_table(spec: FtsEntity) -> Table:
    """Get the SQLAlchemy Table for an entity's FTS index."""
    if spec.fts_table not in _fts_tables:
        _fts_tables[spec.fts_table] = Table(
            spec.fts_table,
            _metadata,
            Column("rowid", Integer),
            *(Column(name, Text) for name in FTS_COLUMNS),
            keep_existing=True,
        )
    return _fts_tables[spec.fts_table]


def expected_triggers(spec: FtsEntity) -> tuple[str, ...]:
    """Names of the sync triggers that keep an entity's FTS index current."""
    return tuple(f"{spec.fts_table}_{suffix}" for suffix in TRIGGER_SUFFIXES)


def _schema_statements(spec: FtsEntity) -> Iterator[str]:
    cols = ", ".join(FTS_COLUMNS)
    t, fts = spec.table, spec.fts_table

    for trigger in expected_triggers(spec):
        yield f"DROP TRIGGER IF EXISTS {trigger}"
    yield f"DROP TABLE IF EXISTS {fts}"

    yield (
        f"CREATE VIRTUAL TABLE {fts} USING fts5("
        f"{cols}, content='{t}', content_rowid='id', tokenize='trigram')"
    )
    yield (
        f"CREATE TRIGGER {fts}_ai AFTER INSERT ON {t} BEGIN "
        f"INSERT INTO {fts}(rowid, {cols}) VALUES (new.id, {spec.values_sql('new')}); "
        f"END"
    )
    yield (
        f"CREATE TRIGGER {fts}_au AFTER UPDATE ON {t} BEGIN "
        f"INSERT INTO {fts}({fts}, rowid, {cols}) "
        f"VALUES ('delete', old.id, {spec.values_sql('old')}); "
        f"INSERT INTO {fts}(rowid, {cols}) VALUES (new.id, {spec.values_sql('new')}); "
        f"END"
    )
    yield (
        f"CREATE TRIGGER {fts}_ad AFTER DELETE ON {t} BEGIN "
        f"INSERT INTO {fts}({fts}, rowid, {cols}) "
        f"VALUES ('delete', old.id, {spec.values_sql('old')}); "
        f"END"
    )
    # Backfill existing rows
    yield f"INSERT INTO {fts}(rowid, {cols}) SELECT id, {spec.values_sql(t)} FROM {t}"


def fts5_available(conn: Connection) -> bool:
    """Check whether this SQLite build supports FTS5 with the trigram tokenizer."""
    try:
        conn.exec_driver_sql(
            "CREATE VIRTUAL TABLE temp.__fts5_probe USING fts5(x, tokenize='trigram')"
        )
        conn.exec_driver_sql("DROP TABLE temp.__fts5_probe")
        return True
    except Exception:  # noqa: BLE001 - any failure means unsupported
        return False


def fts_ready(bind) -> bool:
    """Check whether the FTS index tables exist in the database."""
    return inspect(bind).has_table(ENTITY_SPECS[0].fts_table)


def create_fts_schema(conn: Connection) -> bool:
    """Create (or rebuild) the FTS tables, triggers and backfill.

    Returns False without changes when the SQLite build lacks FTS5 support;
    search then falls back to ILIKE scans.
    """
    if not fts5_available(conn):
        logger.warning("SQLite build lacks FTS5/trigram support; search will use LIKE scans")
        return False
    for spec in ENTITY_SPECS:
        for stmt in _schema_statements(spec):
            conn.exec_driver_sql(stmt)
    return True


def drop_fts_schema(conn: Connection) -> None:
    """Drop all FTS tables and triggers."""
    for spec in ENTITY_SPECS:
        for trigger in expected_triggers(spec):
            conn.exec_driver_sql(f"DROP TRIGGER IF EXISTS {trigger}")
        conn.exec_driver_sql(f"DROP TABLE IF EXISTS {spec.fts_table}")


def missing_fts_objects(conn: Connection) -> list[str]:
    """FTS tables and sync triggers expected from ENTITY_SPECS but absent.

    Compares sqlite_master against the expected schema. Alembic batch-mode
    table recreates silently drop a table's triggers; a missing sync trigger
    means the search index for that entity goes stale from that point on.
    Returns the missing object names (empty when the schema is intact).
    """
    rows = conn.exec_driver_sql(
        "SELECT name FROM sqlite_master WHERE type IN ('table', 'trigger')"
    ).fetchall()
    present = {row[0] for row in rows}
    missing: list[str] = []
    for spec in ENTITY_SPECS:
        if spec.fts_table not in present:
            missing.append(spec.fts_table)
        missing.extend(t for t in expected_triggers(spec) if t not in present)
    return missing


def check_fts_integrity(conn: Connection) -> list[str]:
    """Verify the FTS schema is complete; rebuild it if anything is missing.

    Called at startup after migrations. A batch migration that recreated a
    source table drops its FTS sync triggers (SQLite drops triggers with the
    table); the index then silently misses every subsequent change. This
    detects that state, warns naming the missing objects, and heals by
    rebuilding the full FTS schema with backfill (create_fts_schema is a
    drop-and-rebuild, so it is safe to run on a partially intact schema).

    No-op when the SQLite build lacks FTS5 (search falls back to LIKE).
    Returns the missing object names for callers/tests; never raises.
    """
    try:
        if not fts5_available(conn):
            return []
        missing = missing_fts_objects(conn)
        if missing:
            logger.warning(
                "FTS schema incomplete (stale search index): missing %s. "
                "Likely cause: a batch migration recreated a source table, dropping "
                "its sync triggers. Rebuilding FTS index tables and triggers now.",
                ", ".join(missing),
            )
            create_fts_schema(conn)
            logger.warning("FTS schema rebuilt and backfilled.")
        return missing
    except Exception:
        # Search degradation must never block startup.
        logger.exception("FTS integrity check failed; search index may be stale")
        return []
