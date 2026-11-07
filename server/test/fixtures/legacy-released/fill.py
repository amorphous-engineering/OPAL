"""Puts rows in what `opal seed` leaves empty, through the released code's own table definitions.

Run by build.sh inside the virtualenv of one 1.x tag, after `opal init` and `opal seed`. The seed
of each release is real but sparse: it has no attachments, Onshape links or datasets, and it never
reaches some states a real database reaches. Every value here goes through the SQLAlchemy types of
that tag, so it is stored the way that release stores it. Tables and columns a tag does not have
are skipped.
"""

import os
from datetime import UTC, datetime
from decimal import Decimal
from pathlib import Path

import sqlalchemy as sa

import opal.db.models  # noqa: F401
from opal.db.base import Base, get_engine
from opal.db.models.execution import InstanceStatus

T0 = datetime(2026, 3, 1, 10, 0, 0, 123456, tzinfo=UTC)
T1 = datetime(2026, 3, 2, 11, 30, 0, 500000, tzinfo=UTC)

tables = Base.metadata.tables
engine = get_engine()
upload = Path(os.environ["OPAL_UPLOAD_DIR"])
upload.mkdir(parents=True, exist_ok=True)


def has(table: str, column: str | None = None) -> bool:
    return table in tables and (column is None or column in tables[table].c)


def enum_value(column: sa.Column, value):
    """A string for an Enum column, in the spelling that column's enum wants."""
    enums = getattr(column.type, "enum_class", None)
    if enums is None or not isinstance(value, str):
        return value
    return enums(value)


def clean(table: str, values: dict) -> dict:
    t = tables[table]
    return {k: enum_value(t.c[k], v) for k, v in values.items() if k in t.c}


def add(conn, table: str, **values) -> int | None:
    if not has(table):
        return None
    t = tables[table]
    for stamp, at in (("created_at", T0), ("updated_at", T1)):
        if stamp in t.c:
            values.setdefault(stamp, at)
    return conn.execute(t.insert().values(**clean(table, values))).inserted_primary_key[0]


def change(conn, table: str, row_id: int, **values) -> None:
    t = tables[table]
    conn.execute(t.update().where(t.c.id == row_id).values(**clean(table, values)))


def ids(conn, table: str, *where) -> list[int]:
    t = tables[table]
    return [r[0] for r in conn.execute(sa.select(t.c.id).where(*where).order_by(t.c.id))]


def fill() -> None:
    with engine.begin() as conn:
        # Some seeds create no people: 1.2 and early 1.3 add them on first sign-in.
        if not ids(conn, "user"):
            add(conn, "user", name="Build Lead", email="build@x.test", is_active=True, is_admin=True, needs_profile_setup=False, needs_onboarding=False)
            add(conn, "user", name="Test Engineer", email="test@x.test", is_active=True, is_admin=False, needs_profile_setup=False, needs_onboarding=False)
        users = ids(conn, "user")
        parts = ids(conn, "part")
        stock = ids(conn, "inventory_record")
        issues = ids(conn, "issue")
        risks = ids(conn, "risk")
        procedures = ids(conn, "master_procedure")
        steps = ids(conn, "procedure_step")
        instances = ids(conn, "procedure_instance")
        step_rows = ids(conn, "step_execution")
        version = conn.execute(sa.select(tables["procedure_instance"].c.version_id).limit(1)).scalar_one()

        # ---- settings: secrets that must not move, and one setting that must.
        for key, value in (
            ("onshape_access_key", "access-key"),
            ("onshape_secret_key", "secret-key"),
            ("onshape_webhook_secret", "webhook-secret"),
            ("auth_mode", "local"),
            ("exe_proxy_secret", "proxy-secret"),
            ("x_site_note", "kept"),
        ):
            add(conn, "app_setting", key=key, value=value)

        # ---- people: a former colleague, and an account from the old proxy sign-in.
        add(conn, "user", name="Former Colleague", email="former@x.test", username="former", is_active=False, is_admin=False, needs_profile_setup=False, needs_onboarding=False)
        if has("user", "exe_user_id"):
            change(conn, "user", users[-1], exe_user_id="exe-user-1")

        # ---- parts: one deleted, one with no number, one with an external number.
        change(conn, "part", parts[-1], deleted_at=T1)
        change(conn, "part", parts[-2], internal_pn=None)
        change(conn, "part", parts[-3], external_pn="VENDOR-123")

        # ---- files: one owned by an issue, one by a template. Real bytes on disk.
        for name, body, owner in (
            ("issue-photo.png", b"\x89PNG\r\n\x1a\nfixture", {"issue_id": issues[0]}),
            ("template-drawing.pdf", b"%PDF-1.4 fixture", {"procedure_id": procedures[0]}),
        ):
            (upload / name).write_bytes(body)
            add(conn, "attachment", original_filename=name, stored_filename=name, mime_type="application/octet-stream", size_bytes=len(body), kind="reference", **owner)

        # ---- not carried over: must be listed, with their row counts.
        add(conn, "onshape_link", part_id=parts[0], document_id="doc", element_id="el", part_id_onshape="p1", stale=False)
        add(conn, "onshape_sync_log", started_at=T0, direction="pull", trigger="manual", status="success", parts_created=1, parts_updated=0, bom_lines_created=0, bom_lines_updated=0, bom_lines_removed=0)
        add(conn, "extension", id="fixture.ext", name="Fixture", version="1.0.0", origin="installed", enabled=True, installed_at=T0, manifest={"id": "fixture.ext"})
        add(conn, "webauthn_challenge", nonce="n1", kind="login", rp_id="localhost", state_json="{}", expires_at=T1)
        add(conn, "auth_session", user_id=users[0], token_hash="s1", auth_method="password", expires_at=T1)

        # ---- what the seed leaves empty.
        dataset = add(conn, "dataset", name="Chamber pressure", schema={"fields": [{"name": "p", "type": "number"}]}, procedure_id=procedures[0])
        add(conn, "data_point", dataset_id=dataset, recorded_at=T0, values={"p": 12.5})
        add(conn, "issue_reference", issue_id=issues[0], reference_type="url", reference_value="https://x.test/1")
        add(conn, "risk_reference", risk_id=risks[0], reference_type="url", reference_value="https://x.test/2")
        add(conn, "stock_test_result", inventory_record_id=stock[0], test_name="Proof", result="pass", tested_at=T0, tested_by_id=users[0])
        add(conn, "stock_transfer", source_inventory_id=stock[0], target_inventory_id=stock[1], part_id=parts[0], quantity=Decimal("1"), source_location="A", target_location="B", status="completed", transferred_at=T0)
        add(conn, "step_dependency", step_id=steps[1], depends_on_step_id=steps[0])
        add(conn, "step_kit", step_id=steps[0], part_id=parts[0], quantity_required=Decimal("2"), usage_type="consume")
        consumed = add(conn, "inventory_consumption", inventory_record_id=stock[0], quantity=Decimal("0.5"), consumption_type="manual", usage_type="consume", notes="fixture")
        produced = add(conn, "inventory_production", inventory_record_id=stock[0], quantity=Decimal("1"), serial_number="SN-FIXTURE", status="in_process")
        add(conn, "assembly_component", production_id=produced, consumption_id=consumed, component_opal_number="OPAL-00001", quantity_used=Decimal("0.5"))
        audit = tables["audit_log"]
        conn.execute(audit.insert().values(**clean("audit_log", {"timestamp": T0, "table_name": "part", "record_id": parts[0], "action": "create", "user_id": users[0], "new_values": {"name": "x"}})))
        add(conn, "api_token", user_id=users[0], name="fixture", token_hash="t1")
        add(conn, "passkey_credential", user_id=users[0], credential_id=b"cred", public_key=b"key", sign_count=0, name="Fixture")
        add(conn, "purchase_expense", purchase_id=ids(conn, "purchase")[0], quantity=Decimal("1"), received_at=T0, unit_cost=Decimal("2.5"), total_cost=Decimal("2.5"))
        step_note_owner = step_rows[0]
        add(conn, "step_note", step_execution_id=step_note_owner, author_id=users[0], body="fixture note")

        # ---- states a real database reaches: each is rewritten by some migration.
        issue = tables["issue"]
        raised = "step_execution_id" if "step_execution_id" in issue.c else "raised_step_id"
        change(conn, "issue", issues[0], status="open", issue_type="non_conformance", **{raised: step_rows[0]})
        if has("issue", "disposition_notes"):  # before the disposition signature
            change(conn, "issue", issues[1], status="disposition_approved", disposition_type="return_to_vendor", disposition_notes="Send it back", disposition_approved_by_id=users[0])
            change(conn, "issue", issues[2], status="investigating")
            change(conn, "issue", issues[3], status="closed")
        else:
            change(conn, "issue", issues[3], status="closed")

        if has("risk", "status"):  # before dispositions
            change(conn, "risk", risks[0], status="closed", linked_issue_id=issues[0], mitigation_plan="Replace the seal")
            change(conn, "risk", risks[1], description=None, mitigation_plan="Add a second vent")
            change(conn, "risk", risks[2], mitigation_plan="   ")

        step = tables["step_execution"]
        waiting = ids(conn, "step_execution", step.c.status == "pending")
        if "notes" in step.c:
            change(conn, "step_execution", waiting[0], notes="Torque checked twice.")
            change(conn, "step_execution", waiting[1], notes="   ")
        change(conn, "step_execution", waiting[2], status="awaiting_signoff", completed_by_id=users[0], completed_at=T0)
        if has("step_execution", "notes"):  # before step holds were derived
            change(conn, "step_execution", waiting[3], status="on_hold")

        pstep = tables["procedure_step"]
        if "required_role" in pstep.c:
            change(conn, "procedure_step", steps[0], required_role="Quality")
            change(conn, "procedure_step", steps[1], required_role="quality")
        if "caution" in pstep.c:
            change(conn, "procedure_step", steps[2], caution="  Pressurised line.  ")
            change(conn, "procedure_step", steps[3], caution="   ")

        # A work order nobody started: 'pending' before 1.4, 'cut' after.
        unstarted = "pending" if "pending" in {e.value for e in InstanceStatus} else "cut"
        add(conn, "procedure_instance", procedure_id=procedures[0], version_id=version, work_order_number="WO-FIXTURE", status=unstarted, priority=0)


if __name__ == "__main__":
    fill()
