"""Notification system: fan-out, recipients, blocked/unblocked diffing, inbox."""

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from opal.core import notifications
from opal.db.models.execution import ProcedureInstance
from opal.db.models.notification import (
    Notification,
    NotificationCategory,
    NotificationKind,
    NotificationPriority,
    category_for,
)
from opal.db.models.user import User
from tests.conftest import TEST_PASSWORD_HASH, login


def make_user(db: Session, name: str, username: str, is_active: bool = True) -> User:
    user = User(
        name=name,
        username=username,
        password_hash=TEST_PASSWORD_HASH,
        is_active=is_active,
        is_admin=False,
    )
    db.add(user)
    db.flush()
    return user


def rows_for(db: Session, user_id: int) -> list[Notification]:
    return (
        db.query(Notification)
        .filter(Notification.user_id == user_id)
        .order_by(Notification.id)
        .all()
    )


# ============ Fan-out rules ============


def test_notify_writes_one_row_per_recipient(db_session: Session) -> None:
    a = make_user(db_session, "A", "user.a")
    b = make_user(db_session, "B", "user.b")

    created = notifications.notify(
        db_session,
        recipients={a.id, b.id},
        kind=NotificationKind.ISSUE_ASSIGNED,
        title="T",
        href="/issues/1",
        subject_type="issue",
        subject_id=1,
    )
    db_session.commit()

    assert len(created) == 2
    assert {row.user_id for row in created} == {a.id, b.id}


def test_actor_is_never_notified_of_their_own_action(db_session: Session) -> None:
    actor = make_user(db_session, "Actor", "user.actor")
    other = make_user(db_session, "Other", "user.other")

    created = notifications.notify(
        db_session,
        recipients={actor.id, other.id},
        kind=NotificationKind.ISSUE_COMMENTED,
        title="T",
        href="/issues/1",
        subject_type="issue",
        subject_id=1,
        actor_id=actor.id,
    )
    db_session.commit()

    assert [row.user_id for row in created] == [other.id]


def test_inactive_users_are_dropped(db_session: Session) -> None:
    gone = make_user(db_session, "Gone", "user.gone", is_active=False)

    created = notifications.notify(
        db_session,
        recipients={gone.id},
        kind=NotificationKind.ISSUE_ASSIGNED,
        title="T",
        href="/issues/1",
        subject_type="issue",
        subject_id=1,
    )
    db_session.commit()
    assert created == []


def test_category_is_derived_from_kind() -> None:
    assert category_for(NotificationKind.ISSUE_ASSIGNED) == NotificationCategory.ISSUES
    assert category_for(NotificationKind.EXECUTION_BLOCKED) == NotificationCategory.EXECUTIONS
    assert category_for("something_unknown") == NotificationCategory.ISSUES


# ============ Issue triggers, through the API ============


def _create_issue(client: TestClient, **kwargs) -> dict:
    payload = {"title": "Bad weld", "issue_type": "non_conformance", "priority": "high"}
    payload.update(kwargs)
    response = client.post("/api/issues", json=payload)
    assert response.status_code == 201, response.text
    return response.json()


def test_assigning_an_issue_notifies_the_assignee(client: TestClient, db_session: Session) -> None:
    assignee = make_user(db_session, "Assignee", "user.assignee")
    db_session.commit()

    _create_issue(client, assigned_to_id=assignee.id)

    rows = rows_for(db_session, assignee.id)
    assert len(rows) == 1
    assert rows[0].kind == NotificationKind.ISSUE_ASSIGNED.value
    assert rows[0].priority == NotificationPriority.HIGH.value
    assert rows[0].href.startswith("/issues/")


def test_reassignment_notifies_only_the_new_assignee(
    client: TestClient, db_session: Session
) -> None:
    first = make_user(db_session, "First", "user.first")
    second = make_user(db_session, "Second", "user.second")
    db_session.commit()

    issue = _create_issue(client, assigned_to_id=first.id)
    client.patch(f"/api/issues/{issue['id']}", json={"assigned_to_id": second.id})

    assert len(rows_for(db_session, first.id)) == 1
    assert len(rows_for(db_session, second.id)) == 1


def test_reassigning_to_the_same_person_does_not_notify_twice(
    client: TestClient, db_session: Session
) -> None:
    assignee = make_user(db_session, "Assignee", "user.same")
    db_session.commit()

    issue = _create_issue(client, assigned_to_id=assignee.id)
    client.patch(f"/api/issues/{issue['id']}", json={"assigned_to_id": assignee.id})

    assert len(rows_for(db_session, assignee.id)) == 1


def test_comment_notifies_the_audience_not_the_commenter(
    client: TestClient, db_session: Session
) -> None:
    assignee = make_user(db_session, "Assignee", "user.commented")
    db_session.commit()

    issue = _create_issue(client, assigned_to_id=assignee.id)
    response = client.post(f"/api/issues/{issue['id']}/comments", json={"body": "Looking at it"})
    assert response.status_code == 201

    kinds = [row.kind for row in rows_for(db_session, assignee.id)]
    assert NotificationKind.ISSUE_COMMENTED.value in kinds


def test_closing_an_issue_notifies_the_audience(client: TestClient, db_session: Session) -> None:
    assignee = make_user(db_session, "Assignee", "user.closed")
    db_session.commit()

    issue = _create_issue(client, assigned_to_id=assignee.id)
    response = client.patch(
        f"/api/issues/{issue['id']}",
        json={"status": "closed", "corrective_action": "Reworked"},
    )
    assert response.status_code == 200, response.text

    kinds = [row.kind for row in rows_for(db_session, assignee.id)]
    assert NotificationKind.ISSUE_CLOSED.value in kinds


def test_advisory_issue_raises_no_execution_notification(
    client: TestClient, db_session: Session
) -> None:
    """Advisory containment blocks nothing, so nothing is announced."""
    _create_issue(client, containment="advisory")
    blocked = (
        db_session.query(Notification)
        .filter(Notification.kind == NotificationKind.EXECUTION_BLOCKED.value)
        .all()
    )
    assert blocked == []


# ============ Blocked / unblocked diffing ============


def test_has_blocker_matches_holds_predicate(db_session: Session) -> None:
    """The notification predicate and core.holds must agree, always."""
    from opal.core.holds import blocking_issues_for_instance

    for instance_id in (1, 2, 999):
        expected = bool(blocking_issues_for_instance(db_session, instance_id))
        assert notifications.has_blocker(db_session, instance_id) is expected


def test_has_blocker_is_false_without_an_instance(db_session: Session) -> None:
    assert notifications.has_blocker(db_session, None) is False


def test_blocking_transition_is_silent_when_the_answer_did_not_change(
    db_session: Session,
) -> None:
    operator = make_user(db_session, "Op", "user.op")
    db_session.commit()

    before = notifications.has_blocker(db_session, 424242)
    notifications.blocking_transition(db_session, 424242, before, actor_id=None)
    db_session.commit()

    assert rows_for(db_session, operator.id) == []


def test_blocking_transition_is_a_noop_without_an_instance(db_session: Session) -> None:
    notifications.blocking_transition(db_session, None, False)
    db_session.commit()
    assert db_session.query(Notification).count() == 0


def test_instance_operators_is_empty_for_an_unknown_run(db_session: Session) -> None:
    assert notifications.instance_operators(db_session, 987654) == set()


# ============ Reading ============


def test_unread_count_and_mark_read(db_session: Session) -> None:
    user = make_user(db_session, "Reader", "user.reader")
    notifications.notify(
        db_session,
        recipients={user.id},
        kind=NotificationKind.ISSUE_ASSIGNED,
        title="T",
        href="/issues/1",
        subject_type="issue",
        subject_id=1,
    )
    db_session.commit()

    assert notifications.unread_count(db_session, user.id) == 1

    row = rows_for(db_session, user.id)[0]
    notifications.mark_read(db_session, user.id, row.id)
    db_session.commit()

    assert notifications.unread_count(db_session, user.id) == 0
    assert row.is_read is True


def test_mark_read_refuses_someone_elses_notification(db_session: Session) -> None:
    owner = make_user(db_session, "Owner", "user.owner")
    intruder = make_user(db_session, "Intruder", "user.intruder")
    notifications.notify(
        db_session,
        recipients={owner.id},
        kind=NotificationKind.ISSUE_ASSIGNED,
        title="T",
        href="/issues/1",
        subject_type="issue",
        subject_id=1,
    )
    db_session.commit()

    row = rows_for(db_session, owner.id)[0]
    assert notifications.mark_read(db_session, intruder.id, row.id) is None
    assert row.read_at is None


def test_dismiss_hides_from_bell_and_counts_as_read(db_session: Session) -> None:
    user = make_user(db_session, "Reader", "user.dismiss")
    notifications.notify(
        db_session,
        recipients={user.id},
        kind=NotificationKind.ISSUE_ASSIGNED,
        title="T",
        href="/issues/1",
        subject_type="issue",
        subject_id=1,
    )
    db_session.commit()

    row = rows_for(db_session, user.id)[0]
    notifications.dismiss(db_session, user.id, row.id)
    db_session.commit()

    assert notifications.recent(db_session, user.id) == []
    assert notifications.unread_count(db_session, user.id) == 0


def test_recent_returns_newest_first_capped_at_the_limit(db_session: Session) -> None:
    user = make_user(db_session, "Reader", "user.recent")
    for index in range(12):
        notifications.notify(
            db_session,
            recipients={user.id},
            kind=NotificationKind.ISSUE_ASSIGNED,
            title=f"N{index}",
            href="/issues/1",
            subject_type="issue",
            subject_id=1,
        )
    db_session.commit()

    recent = notifications.recent(db_session, user.id, limit=8)
    assert len(recent) == 8
    assert recent[0].title == "N11"


def test_mark_all_read_clears_the_count(db_session: Session) -> None:
    user = make_user(db_session, "Reader", "user.allread")
    for index in range(3):
        notifications.notify(
            db_session,
            recipients={user.id},
            kind=NotificationKind.ISSUE_ASSIGNED,
            title=f"N{index}",
            href="/issues/1",
            subject_type="issue",
            subject_id=1,
        )
    db_session.commit()

    assert notifications.mark_all_read(db_session, user.id) == 3
    db_session.commit()
    assert notifications.unread_count(db_session, user.id) == 0


# ============ API ============


def test_api_lists_only_the_callers_notifications(
    client: TestClient, db_session: Session, test_user: User, auth_headers: dict
) -> None:
    other = make_user(db_session, "Other", "user.apiother")
    notifications.notify(
        db_session,
        recipients={test_user.id},
        kind=NotificationKind.ISSUE_ASSIGNED,
        title="Mine",
        href="/issues/1",
        subject_type="issue",
        subject_id=1,
    )
    notifications.notify(
        db_session,
        recipients={other.id},
        kind=NotificationKind.ISSUE_ASSIGNED,
        title="Theirs",
        href="/issues/2",
        subject_type="issue",
        subject_id=2,
    )
    db_session.commit()

    response = client.get("/api/notifications", headers=auth_headers)
    assert response.status_code == 200
    titles = [item["title"] for item in response.json()["items"]]
    assert titles == ["Mine"]
    assert response.json()["unread_count"] == 1


def test_api_unread_count(
    client: TestClient, db_session: Session, test_user: User, auth_headers: dict
) -> None:
    notifications.notify(
        db_session,
        recipients={test_user.id},
        kind=NotificationKind.ISSUE_ASSIGNED,
        title="Mine",
        href="/issues/1",
        subject_type="issue",
        subject_id=1,
    )
    db_session.commit()

    response = client.get("/api/notifications/unread-count", headers=auth_headers)
    assert response.status_code == 200
    assert response.json()["unread_count"] == 1


def test_api_cannot_mark_another_users_notification_read(
    client: TestClient, db_session: Session, auth_headers: dict
) -> None:
    other = make_user(db_session, "Other", "user.apiforbidden")
    notifications.notify(
        db_session,
        recipients={other.id},
        kind=NotificationKind.ISSUE_ASSIGNED,
        title="Theirs",
        href="/issues/1",
        subject_type="issue",
        subject_id=1,
    )
    db_session.commit()
    row = rows_for(db_session, other.id)[0]

    response = client.post(f"/api/notifications/{row.id}/read", headers=auth_headers)
    assert response.status_code == 404


def test_api_rejects_an_unknown_category(
    client: TestClient, db_session: Session, auth_headers: dict
) -> None:
    response = client.get("/api/notifications?category=nonsense", headers=auth_headers)
    assert response.status_code == 400


# ============ Web ============


def test_bell_partial_renders(client: TestClient, db_session: Session, test_user: User) -> None:
    notifications.notify(
        db_session,
        recipients={test_user.id},
        kind=NotificationKind.ISSUE_ASSIGNED,
        title="ISS-0001 assigned to you",
        href="/issues/1",
        subject_type="issue",
        subject_id=1,
    )
    db_session.commit()

    login(client, test_user)
    response = client.get("/notifications/bell")
    assert response.status_code == 200
    assert "ISS-0001 assigned to you" in response.text
    assert "ALL NOTIFICATIONS" in response.text


def test_inbox_page_renders_and_filters(
    client: TestClient, db_session: Session, test_user: User
) -> None:
    notifications.notify(
        db_session,
        recipients={test_user.id},
        kind=NotificationKind.EXECUTION_BLOCKED,
        title="WO-0001 is blocked",
        href="/executions/1",
        subject_type="procedure_instance",
        subject_id=1,
        priority=NotificationPriority.HIGH.value,
    )
    db_session.commit()

    login(client, test_user)

    response = client.get("/notifications")
    assert response.status_code == 200
    assert "WO-0001 is blocked" in response.text

    response = client.get("/notifications?category=executions")
    assert "WO-0001 is blocked" in response.text

    response = client.get("/notifications?category=issues")
    assert "WO-0001 is blocked" not in response.text


@pytest.mark.parametrize("sort", ["recent", "priority", "unread", "bogus"])
def test_inbox_sorting_never_500s(
    client: TestClient, db_session: Session, test_user: User, sort: str
) -> None:
    notifications.notify(
        db_session,
        recipients={test_user.id},
        kind=NotificationKind.ISSUE_ASSIGNED,
        title="T",
        href="/issues/1",
        subject_type="issue",
        subject_id=1,
    )
    db_session.commit()

    login(client, test_user)
    response = client.get(f"/notifications?sort={sort}")
    assert response.status_code == 200


def test_web_read_redirects_to_the_subject(
    client: TestClient, db_session: Session, test_user: User
) -> None:
    notifications.notify(
        db_session,
        recipients={test_user.id},
        kind=NotificationKind.ISSUE_ASSIGNED,
        title="T",
        href="/issues/42",
        subject_type="issue",
        subject_id=42,
    )
    db_session.commit()
    row = rows_for(db_session, test_user.id)[0]

    login(client, test_user)
    response = client.post(f"/notifications/{row.id}/read", follow_redirects=False)
    assert response.status_code == 302
    assert response.headers["location"] == "/issues/42"
    assert notifications.unread_count(db_session, test_user.id) == 0


def test_bell_appears_in_the_header(
    client: TestClient, db_session: Session, test_user: User
) -> None:
    login(client, test_user)
    response = client.get("/")
    assert response.status_code == 200
    assert "/notifications/bell" in response.text


# ============ Blocked / unblocked, end to end ============


def _procedure_instance(client: TestClient) -> tuple[int, int]:
    """Publish a 2-step procedure and start an instance. Returns (proc, instance)."""
    proc_id = client.post("/api/procedures", json={"name": "Notify Test Procedure"}).json()["id"]
    client.post(f"/api/procedures/{proc_id}/steps", json={"title": "Step 1"})
    client.post(f"/api/procedures/{proc_id}/steps", json={"title": "Step 2"})
    client.post(f"/api/procedures/{proc_id}/publish")
    response = client.post("/api/procedure-instances", json={"procedure_id": proc_id})
    assert response.status_code == 201, response.text
    return proc_id, response.json()["id"]


def _raise_nc(client: TestClient, instance_id: int, order: int = 1, **overrides) -> dict:
    body = {"title": "Torque out of range", "containment": "step", **overrides}
    response = client.post(f"/api/procedure-instances/{instance_id}/steps/{order}/nc", json=body)
    assert response.status_code == 201, response.text
    return response.json()


def _blocked_rows(db: Session, kind: NotificationKind) -> list[Notification]:
    return db.query(Notification).filter(Notification.kind == kind.value).all()


def test_raising_a_blocker_notifies_the_runs_operators(
    client: TestClient, db_session: Session
) -> None:
    operator = make_user(db_session, "Operator", "user.e2e.op")
    db_session.commit()

    _, instance_id = _procedure_instance(client)
    # Put the operator on the run so they count as someone it affects.
    instance = db_session.query(ProcedureInstance).filter_by(id=instance_id).first()
    instance.started_by_id = operator.id
    db_session.commit()

    assert notifications.has_blocker(db_session, instance_id) is False
    _raise_nc(client, instance_id)
    assert notifications.has_blocker(db_session, instance_id) is True

    blocked = [
        n
        for n in rows_for(db_session, operator.id)
        if n.kind == NotificationKind.EXECUTION_BLOCKED.value
    ]
    assert len(blocked) == 1
    assert blocked[0].priority == NotificationPriority.HIGH.value
    assert blocked[0].href == f"/executions/{instance_id}"


def test_second_blocker_on_an_already_blocked_run_is_silent(
    client: TestClient, db_session: Session
) -> None:
    operator = make_user(db_session, "Operator", "user.e2e.second")
    db_session.commit()

    _, instance_id = _procedure_instance(client)
    instance = db_session.query(ProcedureInstance).filter_by(id=instance_id).first()
    instance.started_by_id = operator.id
    db_session.commit()

    _raise_nc(client, instance_id, order=1)
    _raise_nc(client, instance_id, order=2)

    blocked = [
        n
        for n in rows_for(db_session, operator.id)
        if n.kind == NotificationKind.EXECUTION_BLOCKED.value
    ]
    assert len(blocked) == 1, "a run already blocked must not announce it again"


def test_run_reports_unblocked_only_when_the_last_blocker_clears(
    client: TestClient, db_session: Session
) -> None:
    operator = make_user(db_session, "Operator", "user.e2e.unblock")
    db_session.commit()

    _, instance_id = _procedure_instance(client)
    instance = db_session.query(ProcedureInstance).filter_by(id=instance_id).first()
    instance.started_by_id = operator.id
    db_session.commit()

    first = _raise_nc(client, instance_id, order=1)
    second = _raise_nc(client, instance_id, order=2)

    def unblocked() -> list[Notification]:
        return [
            n
            for n in rows_for(db_session, operator.id)
            if n.kind == NotificationKind.EXECUTION_UNBLOCKED.value
        ]

    client.post(
        f"/api/issues/{first['id']}/disposition",
        json={"disposition_type": "use_as_is", "disposition_rationale": "ok"},
    )
    assert unblocked() == [], "still blocked by the second NC"

    client.post(
        f"/api/issues/{second['id']}/disposition",
        json={"disposition_type": "use_as_is", "disposition_rationale": "ok"},
    )
    assert len(unblocked()) == 1
    assert notifications.has_blocker(db_session, instance_id) is False
