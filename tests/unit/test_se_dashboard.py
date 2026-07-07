"""UX-2: part-page requirements embedding + red-only traceability widget."""

from datetime import UTC, datetime, timedelta

from opal.core.designators import generate_requirement_number
from opal.db.models import Requirement
from opal.se.dashboard import old_block_lint_drafts, overdue_tbrs
from tests.conftest import login, user_headers

GOOD = "The engine shall sustain a chamber pressure of 20 bar ± 1 bar."


def _make_req(db, **overrides) -> Requirement:
    values = {
        "req_number": generate_requirement_number(db),
        "title": "Chamber pressure",
        "statement": GOOD,
        "rationale": "Sized from the mission delta-v budget.",
        "verification_method": "test",
    }
    values.update(overrides)
    req = Requirement(**values)
    db.add(req)
    db.flush()
    return req


# ============ Dashboard queries ============


def test_overdue_tbrs_only_past_due_live_rows(db_session, test_user):
    overdue = _make_req(
        db_session,
        tbr=True,
        tbr_owner_id=test_user.id,
        tbr_due=datetime.now(UTC) - timedelta(days=5),
    )
    _make_req(db_session, tbr=True, tbr_due=datetime.now(UTC) + timedelta(days=5))  # future
    _make_req(db_session)  # no TBR

    result = overdue_tbrs(db_session)
    assert [item["req"].id for item in result] == [overdue.id]
    assert result[0]["owner_name"] == test_user.name
    assert result[0]["days_over"] == 5


def test_overdue_tbr_without_owner_is_named(db_session):
    _make_req(db_session, tbr=True, tbr_due=datetime.now(UTC) - timedelta(days=2))
    (item,) = overdue_tbrs(db_session)
    assert item["owner_name"] == "(no owner)"


def test_old_block_lint_drafts_window_and_severity(db_session, test_user):
    old = datetime.now(UTC) - timedelta(days=10)
    stuck = _make_req(db_session, statement="The tank shall be sufficient.")
    stuck.created_at = old
    fresh_dirty = _make_req(db_session, statement="The pump shall be adequate.")  # too new
    clean_old = _make_req(db_session)
    clean_old.created_at = old
    baselined_old = _make_req(db_session, statement="The line shall be easy.")
    baselined_old.created_at = old
    baselined_old.lifecycle_state = "cancelled"
    db_session.flush()

    result = old_block_lint_drafts(db_session)
    assert [r.id for r in result] == [stuck.id]
    assert fresh_dirty.id not in [r.id for r in result]


# ============ Web surfaces ============


def test_dashboard_has_no_traceability_widget(client, db_session, test_user):
    """The traceability panel was removed from the dashboard (rehearsal
    feedback 2026-07-06); the helpers remain for a future requirements-page
    home."""
    test_user.needs_onboarding = False
    db_session.commit()
    login(client, test_user)
    page = client.get("/")
    assert page.status_code == 200
    assert "TRACEABILITY" not in page.text


def test_part_page_shows_allocated_requirement_with_state(client, db_session, test_user):
    login(client, test_user)
    part = client.post("/api/parts", json={"name": "Feed Manifold"}).json()
    req = _make_req(db_session, title="Feed pressure")
    db_session.commit()

    assign = client.post(
        f"/api/requirements/parts/{part['id']}",
        json={"requirement_id": req.req_number},
        headers=user_headers(test_user),
    )
    assert assign.status_code == 201, assign.text

    page = client.get(f"/parts/{part['id']}")
    assert page.status_code == 200
    assert ">REQUIREMENTS<" in page.text  # section header label
    assert req.req_number in page.text
    assert "DRAFT" in page.text
    assert f"/requirements/{req.id}" in page.text  # table row links to the dossier
