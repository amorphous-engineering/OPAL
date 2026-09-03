"""Execution flow: presence, hold gating, completion, document state.

The single home for the commitment-moment rules of the execution document.
COMPLETE is the commitment moment — it checks its dependencies' states here,
and both the JSON API routes and the MCP tools call these functions rather
than carrying their own copies. Presence is focus: a user's cursor position
is broadcast state, never an event — moving it records nothing.

Hold doctrine (Issues R2 §2/§9): the blocking predicate is *undispositioned*,
never "open". A hold is derived state — it lifts the moment its issue reaches
a terminal disposition, with no status choreography. Two gate kinds exist
today, both gating COMPLETE (a hold cannot physically prevent starting work,
so it does not pretend to):
- containment scope (step/op/wo): an undispositioned issue holds its scope's
  COMPLETE — the raised step and its OP, the whole OP, or WO close-out.
- boundary ("resolve by", ``containment_step_id``): a step-contained issue
  bound to a later step holds that step's COMPLETE.
The blocking computation has one home: core/holds.
"""

from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import func
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.orm import Session

from opal.core.audit import log_create
from opal.core.holds import HoldState, blocking_issues_for_instance, get_hold_state
from opal.core.holds import enum_value as _status_value  # enum-unwrap, one home in core/holds
from opal.db.models.attachment import Attachment
from opal.db.models.execution import (
    InstanceStatus,
    ProcedureInstance,
    StepExecution,
    StepFocus,
    StepNote,
    StepStatus,
)
from opal.db.models.inventory import InventoryProduction, ProductionStatus
from opal.db.models.issue import Issue
from opal.db.models.procedure import ProcedureVersion
from opal.db.models.user import User

TERMINAL_STEP_STATUSES = {
    StepStatus.COMPLETED.value,
    StepStatus.SIGNED_OFF.value,
    StepStatus.SKIPPED.value,
}

# Roster chips gray out when a participant's heartbeat goes quiet (tablets
# sleep; the cursor persists).
PRESENCE_STALE_SECONDS = 60


class FlowError(Exception):
    """A commitment-moment rule refused the action."""

    status_code = 400

    def __init__(self, message: str):
        super().__init__(message)
        self.message = message


def user_initials(name: str | None) -> str:
    if not name:
        return "?"
    parts = [p for p in name.split() if p]
    if not parts:
        return "?"
    if len(parts) == 1:
        return parts[0][:2].upper()
    return (parts[0][0] + parts[-1][0]).upper()


def version_step_map(version: ProcedureVersion | None) -> dict[int, dict]:
    if version is None:
        return {}
    return {s["order"]: s for s in version.content.get("steps", [])}


def step_display(step_exec: StepExecution) -> str:
    return step_exec.step_number_str or str(step_exec.step_number)


# ============ Hold lookups ============


def holding_ncs_by_step(db: Session, instance_id: int) -> dict[int, list[Issue]]:
    """Issues holding each row's COMPLETE (step/op containment), keyed by
    step_execution_id. Derived from containment — the one home for the
    blocking computation is core/holds."""
    state = get_hold_state(db, instance_id)
    merged: dict[int, list[Issue]] = {}
    for se_id, issues in state.complete_blocked.items():
        merged.setdefault(se_id, []).extend(issues)
    for se_id, issues in state.op_complete_blocked.items():
        bucket = merged.setdefault(se_id, [])
        bucket.extend(i for i in issues if all(x.id != i.id for x in bucket))
    return merged


def bound_blocks_by_step(db: Session, instance_id: int) -> dict[int, list[Issue]]:
    """Boundary holds ("resolve by"): issues holding a future step's COMPLETE,
    keyed by that step's execution id."""
    return dict(get_hold_state(db, instance_id).start_blocked)


# ============ Gating ============


@dataclass
class Blocker:
    """One reason a commitment moment refuses."""

    kind: str  # hold | nc | sequence | dependency | redline | parent_hold
    message: str
    issue_id: int | None = None
    issue_number: str | None = None


def _exec_lookup(instance: ProcedureInstance) -> dict[int, StepExecution]:
    return {se.step_number: se for se in instance.step_executions}


def sequence_blockers(
    db: Session,
    instance: ProcedureInstance,
    step_exec: StepExecution,
) -> list[Blocker]:
    """Structural gates on this step's COMPLETE: strict_sequence order,
    declared OP dependencies, open redlines. Containment holds live in
    held_scope_blockers."""
    blockers: list[Blocker] = []
    exec_lookup = _exec_lookup(instance)
    version = db.get(ProcedureVersion, instance.version_id)
    vs_map = version_step_map(version)

    # Gate against the op-level entry — for sub-steps that's the parent op.
    gate_op_order: int | None = None
    if step_exec.level == 0:
        gate_op_order = step_exec.step_number
        # A parent OP commits only after its sub-steps: manual COMPLETE of an
        # OP row with open children is refused (the auto-complete path already
        # requires all children terminal — the manual path must agree).
        open_children = sorted(
            (
                se
                for se in instance.step_executions
                if se.parent_step_order == step_exec.step_number
                and _status_value(se.status) not in TERMINAL_STEP_STATUSES
            ),
            key=lambda se: se.step_number,
        )
        if open_children:
            # Display numbers (step_display), never the document-global order —
            # a child stored at global order 6 renders as 5.1.
            labels = ", ".join(step_display(se) for se in open_children)
            blockers.append(Blocker(kind="children", message=f"Waiting on sub-steps {labels}"))
    elif step_exec.parent_step_order is not None:
        gate_op_order = step_exec.parent_step_order

        # strict_sequence: sub-step N requires N-1 terminal.
        parent_vs = vs_map.get(gate_op_order) or {}
        if parent_vs.get("strict_sequence"):
            prior = [
                se
                for se in instance.step_executions
                if se.parent_step_order == gate_op_order
                and se.ad_hoc_issue_id is None
                and se.step_number < step_exec.step_number
            ]
            unmet = [
                step_display(se)
                for se in sorted(prior, key=lambda se: se.step_number)
                if _status_value(se.status) not in TERMINAL_STEP_STATUSES
            ]
            if unmet:
                blockers.append(Blocker(kind="sequence", message="Waiting on " + ", ".join(unmet)))

    if gate_op_order is not None:
        # Declared OP dependencies from the version snapshot.
        version_step = vs_map.get(gate_op_order)
        dep_orders = (version_step or {}).get("depends_on") or []
        dep_blockers: list[str] = []
        for dep_order in dep_orders:
            prereq = exec_lookup.get(dep_order)
            if prereq is None:
                continue
            if _status_value(prereq.status) not in TERMINAL_STEP_STATUSES:
                dep_blockers.append(step_display(prereq))
        if dep_blockers:
            blockers.append(
                Blocker(kind="dependency", message="Waiting on OP " + ", ".join(dep_blockers))
            )

        # Incomplete redline ops attached to the gate op must finish first.
        redline_rows = (
            db.query(StepExecution)
            .join(Issue, Issue.id == StepExecution.ad_hoc_issue_id)
            .filter(
                StepExecution.instance_id == instance.id,
                StepExecution.ad_hoc_host_order == gate_op_order,
                StepExecution.level == 0,
                Issue.deleted_at.is_(None),
            )
            .all()
        )
        redline_blockers = [
            step_display(r)
            for r in redline_rows
            if _status_value(r.status) not in TERMINAL_STEP_STATUSES
        ]
        if redline_blockers:
            blockers.append(
                Blocker(
                    kind="redline",
                    message="Waiting on redline op " + ", ".join(redline_blockers),
                )
            )

    return blockers


def held_scope_blockers(
    db: Session,
    instance: ProcedureInstance,
    step_exec: StepExecution,
    hold_state: HoldState | None = None,
) -> list[Blocker]:
    """Undispositioned issues holding this row's scope.

    Containment-derived (core/holds): step/op containment in the row's
    scope, plus a boundary hold bound to this row ("resolve by") — held
    work cannot be completed or skipped around.

    Pass ``hold_state`` when gating many rows of one work order: the state
    is a full query pass, and it is the same for every row.
    """
    state = hold_state if hold_state is not None else get_hold_state(db, instance.id)
    issues = state.blockers_for_complete(step_exec) + state.blockers_for_start(step_exec)
    blockers: list[Blocker] = []
    seen: set[int] = set()
    for issue in issues:
        if issue.id in seen:
            continue
        seen.add(issue.id)
        blockers.append(
            Blocker(
                kind="nc",
                message=f"Undispositioned {issue.issue_number}",
                issue_id=issue.id,
                issue_number=issue.issue_number,
            )
        )
    return blockers


def complete_blockers(
    db: Session,
    instance: ProcedureInstance,
    step_exec: StepExecution,
    hold_state: HoldState | None = None,
) -> list[Blocker]:
    """Everything holding this step's (or OP's) COMPLETE: the held scope
    plus the structural sequence gates."""
    return held_scope_blockers(db, instance, step_exec, hold_state) + sequence_blockers(
        db, instance, step_exec
    )


def skip_blockers(
    db: Session,
    instance: ProcedureInstance,
    step_exec: StepExecution,
    hold_state: HoldState | None = None,
) -> list[Blocker]:
    """Everything holding this step's SKIP: the held scope, any open
    redline-rework op on the gate, and — for a parent OP row — its open
    children.

    SKIP is a terminal commitment, so it inherits the held scope (a hold
    cannot be skipped around), the redline gate — skipping the host step
    must not strand an authorized rework op — and the children gate: a
    terminal parent over live children strands them, exactly the state
    COMPLETE refuses. It deliberately omits strict_sequence and
    OP-dependency ordering: skipping legitimately does not require
    predecessors to be done."""
    scope = held_scope_blockers(db, instance, step_exec, hold_state)
    structural = [
        b for b in sequence_blockers(db, instance, step_exec) if b.kind in ("redline", "children")
    ]
    return scope + structural


# ============ Presence (focus) ============


def instance_cursors(db: Session, instance_id: int) -> list[StepFocus]:
    return db.query(StepFocus).filter(StepFocus.instance_id == instance_id).all()


def focus_step(
    db: Session,
    instance: ProcedureInstance,
    step_exec: StepExecution,
    user: User,
) -> StepFocus:
    """Move a user's cursor to a step. Presence only: no gate checks, no
    audit event — the only durable side effect is first-focus telemetry."""
    now = datetime.now(UTC)
    # Atomic upsert: two tabs posting the same user's first focus must not
    # race the unique (instance, user) row into an IntegrityError.
    stmt = (
        sqlite_insert(StepFocus)
        .values(
            instance_id=instance.id,
            user_id=user.id,
            step_execution_id=step_exec.id,
            focused_at=now,
            created_at=now,
            updated_at=now,
        )
        .on_conflict_do_update(
            index_elements=[StepFocus.instance_id, StepFocus.user_id],
            set_={"step_execution_id": step_exec.id, "focused_at": now, "updated_at": now},
        )
    )
    db.execute(stmt)
    if step_exec.first_focused_at is None:
        step_exec.first_focused_at = now
    db.flush()
    return (
        db.query(StepFocus)
        .filter(StepFocus.instance_id == instance.id, StepFocus.user_id == user.id)
        .one()
    )


def clear_focus(db: Session, instance_id: int, user_id: int) -> None:
    """Drop a user's cursor (leaving the document)."""
    db.query(StepFocus).filter(
        StepFocus.instance_id == instance_id, StepFocus.user_id == user_id
    ).delete()


PRESENCE_TOUCH_SECONDS = 30


def touch_user_presence(db: Session, user_id: int | None) -> None:
    """The 5s state poll doubles as the presence heartbeat; writes are
    throttled so polling stays read-mostly.

    Commits the request session: callers must invoke this only at a point
    where the transaction holds no unrelated pending writes (the state GET
    calls it before building the payload)."""
    if user_id is None:
        return
    user = db.get(User, user_id)
    if user is None:
        return
    now = datetime.now(UTC)
    last = user.last_seen_at
    if last is not None and last.tzinfo is None:
        last = last.replace(tzinfo=UTC)
    if last is None or (now - last).total_seconds() > PRESENCE_TOUCH_SECONDS:
        user.last_seen_at = now
        db.commit()


def mark_instance_in_work(db: Session, instance: ProcedureInstance) -> bool:
    """First completed/skipped work moves the WO out of CUT. Derived from
    the event — there is no separate start moment."""
    if _status_value(instance.status) != InstanceStatus.CUT.value:
        return False
    instance.status = InstanceStatus.IN_WORK
    instance.started_at = datetime.now(UTC)
    db.query(InventoryProduction).filter(
        InventoryProduction.procedure_instance_id == instance.id,
        InventoryProduction.status == ProductionStatus.PLANNED,
    ).update({InventoryProduction.status: ProductionStatus.WIP})
    return True


# ============ Step notes ============


def add_step_note(
    db: Session,
    step_exec: StepExecution,
    body: str | None,
    author_id: int | None,
) -> StepNote:
    """Append a timestamped, authored note to a step. The ONE creation path —
    JSON API, MCP, and the complete flow all land here.

    Notes are a record, not a control: no status gate, no instance gate — a
    pending, held, or terminal step on a completed or aborted work order can
    still take a note (post-mortem debugging is the point).
    """
    text = (body or "").strip()
    if not text:
        raise FlowError("Note body is empty")
    note = StepNote(step_execution_id=step_exec.id, author_id=author_id, body=text)
    db.add(note)
    db.flush()
    log_create(db, note, author_id)
    return note


def notes_by_step(db: Session, step_exec_ids: list[int]) -> dict[int, list[StepNote]]:
    """Chronological notes keyed by step_execution_id."""
    grouped: dict[int, list[StepNote]] = {}
    if not step_exec_ids:
        return grouped
    for note in (
        db.query(StepNote)
        .filter(StepNote.step_execution_id.in_(step_exec_ids))
        .order_by(StepNote.created_at.asc(), StepNote.id.asc())
        .all()
    ):
        grouped.setdefault(note.step_execution_id, []).append(note)
    return grouped


# ============ Completion ============


def validate_data_captured(
    version: ProcedureVersion | None,
    step_exec: StepExecution,
    data_captured: dict[str, Any] | None,
) -> list[str]:
    """Required/min/max validation against the step's data schema.

    Validates whenever the step declares a schema — absent data fails
    required fields rather than skipping validation.
    """
    schema = step_exec.required_data_schema
    if schema is None and version is not None:
        step_data = version_step_map(version).get(step_exec.step_number) or {}
        schema = step_data.get("required_data_schema")
    fields = (schema or {}).get("fields", [])
    if not fields:
        return []

    data = data_captured or {}
    errors: list[str] = []
    for field_def in fields:
        name = field_def.get("name")
        label = field_def.get("label", name)
        val = data.get(name)
        if field_def.get("required") and (
            val is None or val == "" or (isinstance(val, list) and not val)
        ):
            errors.append(f"{label} is required")
        if field_def.get("type") == "number" and val is not None and val != "":
            try:
                num_val = float(val)
            except (TypeError, ValueError):
                errors.append(f"{label}: invalid number")
                continue
            if field_def.get("min") is not None and num_val < field_def["min"]:
                errors.append(f"{label}: {num_val} below minimum {field_def['min']}")
            if field_def.get("max") is not None and num_val > field_def["max"]:
                errors.append(f"{label}: {num_val} above maximum {field_def['max']}")
    return errors


@dataclass
class CompleteResult:
    step_exec: StepExecution
    instance_completed: bool = False
    instance_started: bool = False  # this event moved the WO out of CUT
    validation_errors: list[str] = field(default_factory=list)


def complete_step_flow(
    db: Session,
    instance: ProcedureInstance,
    step_exec: StepExecution,
    user_id: int,
    data_captured: dict[str, Any] | None = None,
    notes: str | None = None,
) -> CompleteResult:
    """COMPLETE is the commitment moment: it checks the undispositioned-issue
    and sequence state of its scope, validates required data, and cascades
    instance completion."""
    inst_status = _status_value(instance.status)
    if inst_status not in (InstanceStatus.CUT.value, InstanceStatus.IN_WORK.value):
        raise FlowError("Instance is not active")

    step_status = _status_value(step_exec.status)
    if step_status in (StepStatus.COMPLETED.value, StepStatus.SIGNED_OFF.value):
        raise FlowError("Step already completed")
    if step_status not in (
        StepStatus.PENDING.value,
        StepStatus.IN_PROGRESS.value,
        StepStatus.AWAITING_SIGNOFF.value,
    ):
        raise FlowError(f"Cannot complete step in {step_status} status")

    holds = complete_blockers(db, instance, step_exec)
    if holds:
        raise FlowError("Cannot complete: " + "; ".join(b.message for b in holds))

    version = db.get(ProcedureVersion, instance.version_id)
    errors = validate_data_captured(version, step_exec, data_captured)
    if errors:
        return CompleteResult(step_exec=step_exec, validation_errors=errors)

    instance_started = mark_instance_in_work(db, instance)

    # Re-assert the precondition as a guarded UPDATE: two users completing
    # the same step inside one poll window serialize at the write, and the
    # loser gets a clean refusal instead of double-writing completed_by.
    now = datetime.now(UTC)
    flipped = (
        db.query(StepExecution)
        .filter(
            StepExecution.id == step_exec.id,
            StepExecution.status.in_(
                [StepStatus.PENDING, StepStatus.IN_PROGRESS, StepStatus.AWAITING_SIGNOFF]
            ),
        )
        .update(
            {
                StepExecution.status: StepStatus.COMPLETED,
                StepExecution.completed_at: now,
                StepExecution.completed_by_id: user_id,
            },
            synchronize_session=False,
        )
    )
    if not flipped:
        db.rollback()
        raise FlowError("Step already completed")
    db.expire(step_exec)

    if step_status == StepStatus.PENDING.value and step_exec.started_at is None:
        step_exec.started_at = now
    if data_captured:
        step_exec.data_captured = data_captured
    if notes and notes.strip():
        add_step_note(db, step_exec, notes, user_id)

    old_instance_status = _status_value(instance.status)
    check_instance_completion(db, instance)

    instance_completed = (
        old_instance_status != InstanceStatus.COMPLETED.value
        and _status_value(instance.status) == InstanceStatus.COMPLETED.value
    )
    return CompleteResult(
        step_exec=step_exec,
        instance_completed=instance_completed,
        instance_started=instance_started,
    )


def recheck_instance_completion(db: Session, issue: Issue) -> None:
    """Re-evaluate a work order's completion after an issue's hold changed.

    Releasing a hold may have been the last thing standing between a work
    order and completion (e.g. wo/op containment signed after every step
    finished). One home for the API, the web and the MCP server."""
    if issue.procedure_instance_id is None:
        return
    instance = db.get(ProcedureInstance, issue.procedure_instance_id)
    if instance is not None:
        check_instance_completion(db, instance)


def check_instance_completion(db: Session, instance: ProcedureInstance) -> None:
    """Auto-complete parent OPs whose children are done, then the instance.

    An OP holding undispositioned NCs anywhere in its scope never
    auto-completes — OP COMPLETE is gated by disposition (Issues R2 §2).
    """
    version = db.get(ProcedureVersion, instance.version_id)
    if not version:
        return

    version_steps = {s["order"]: s for s in version.content.get("steps", [])}
    all_steps = db.query(StepExecution).filter(StepExecution.instance_id == instance.id).all()
    hold_state = get_hold_state(db, instance.id)

    def _row_held(se: StepExecution) -> bool:
        # A bound "resolve by" hold (start_blocked) gates a row's COMPLETE just
        # as a raised/op hold does — fold both so an OP never auto-completes,
        # and the WO never closes, over an open hold anchored on a terminal row.
        return bool(hold_state.blockers_for_complete(se) or hold_state.blockers_for_start(se))

    for step_exec in all_steps:
        if step_exec.level == 0:
            children = [s for s in all_steps if s.parent_step_order == step_exec.step_number]
            if children:
                step_status = _status_value(step_exec.status)
                if step_status in (StepStatus.PENDING.value, StepStatus.IN_PROGRESS.value):
                    all_children_done = all(
                        _status_value(c.status)
                        in (StepStatus.COMPLETED.value, StepStatus.SKIPPED.value)
                        for c in children
                    )
                    scope_held = _row_held(step_exec) or any(_row_held(c) for c in children)
                    if all_children_done and not scope_held:
                        step_exec.status = StepStatus.COMPLETED
                        step_exec.completed_at = datetime.now(UTC)

                        def _to_aware(dt: datetime) -> datetime:
                            return dt.replace(tzinfo=UTC) if dt.tzinfo is None else dt

                        last_child = max(
                            (c for c in children if c.completed_at),
                            key=lambda c: _to_aware(c.completed_at),
                            default=None,
                        )
                        if last_child and last_child.completed_by_id:
                            step_exec.completed_by_id = last_child.completed_by_id

    for step_exec in all_steps:
        step_data = version_steps.get(step_exec.step_number, {})
        is_contingency = step_data.get("is_contingency", False)
        step_status = _status_value(step_exec.status)

        if not is_contingency and step_status not in TERMINAL_STEP_STATUSES:
            return
        # A touched contingency step (worked or held) blocks completion;
        # an untouched one does not.
        if is_contingency and step_status in (
            StepStatus.IN_PROGRESS.value,
            StepStatus.ON_HOLD.value,
        ):
            return

    # Close-out is authoritative on the issue set, not on per-row hold buckets:
    # ANY non-advisory, containment-bearing, undispositioned issue open on this
    # work order keeps it open — a wo-scoped hold, an op/step hold whose anchor
    # already went terminal, or a "resolve by" boundary bound to a terminal or
    # OP row. Inferring close-out from wo_blocked alone let those slip through
    # (a WO closing COMPLETED over an open NC). Dispositioned/advisory issues
    # are excluded here, so legitimate completion is never deadlocked.
    if blocking_issues_for_instance(db, instance.id):
        return

    instance.status = InstanceStatus.COMPLETED
    instance.completed_at = datetime.now(UTC)


# ============ Document state ============


def build_execution_state(db: Session, instance: ProcedureInstance) -> dict[str, Any]:
    """The controller's view as JSON: steps, states, presence, holds.

    One builder serves the web presence poll and the MCP
    get_execution_state tool — same facts, same home.
    """
    version = db.get(ProcedureVersion, instance.version_id)
    vs_map = version_step_map(version)
    now = datetime.now(UTC)

    # Legacy rows may lack parent_step_order — derive from the snapshot.
    id_to_order = {vs.get("id"): vs["order"] for vs in vs_map.values()}
    snapshot_parent = {
        vs["order"]: id_to_order.get(vs.get("parent_step_id")) for vs in vs_map.values()
    }

    def parent_order_of(se: StepExecution) -> int | None:
        if se.parent_step_order is not None:
            return se.parent_step_order
        return snapshot_parent.get(se.step_number)

    cursors = instance_cursors(db, instance.id)
    cursors_by_step: dict[int, list[StepFocus]] = {}
    for cursor in sorted(cursors, key=lambda c: c.focused_at):
        cursors_by_step.setdefault(cursor.step_execution_id, []).append(cursor)
    hold_state = get_hold_state(db, instance.id)
    raised: dict[int, list[Issue]] = {}
    for se_id, issues in hold_state.complete_blocked.items():
        raised.setdefault(se_id, []).extend(issues)
    for se_id, issues in hold_state.op_complete_blocked.items():
        bucket = raised.setdefault(se_id, [])
        bucket.extend(i for i in issues if all(x.id != i.id for x in bucket))
    bound = hold_state.start_blocked

    step_exec_ids = [se.id for se in instance.step_executions]
    step_notes = notes_by_step(db, step_exec_ids)

    user_ids = {c.user_id for c in cursors}
    for p in instance.participants or []:
        if p.get("user_id"):
            user_ids.add(p["user_id"])
    completer_ids = {se.completed_by_id for se in instance.step_executions if se.completed_by_id}
    author_ids = {n.author_id for notes in step_notes.values() for n in notes if n.author_id}
    lookup_ids = user_ids | completer_ids | author_ids
    users = db.query(User).filter(User.id.in_(lookup_ids)).all() if lookup_ids else []
    user_lookup = {u.id: u for u in users}

    def _iso(dt: datetime | None) -> str | None:
        return dt.isoformat() if dt else None

    def _stale(user: User | None) -> bool:
        if user is None or user.last_seen_at is None:
            return True
        last_seen = user.last_seen_at
        if last_seen.tzinfo is None:
            last_seen = last_seen.replace(tzinfo=UTC)
        return (now - last_seen).total_seconds() > PRESENCE_STALE_SECONDS

    def _cursor_entry(cursor: StepFocus) -> dict[str, Any]:
        user = user_lookup.get(cursor.user_id)
        return {
            "user_id": cursor.user_id,
            "name": user.name if user else None,
            "initials": user_initials(user.name if user else None),
            "focused_at": _iso(cursor.focused_at),
            "stale": _stale(user),
        }

    # Attachment counts per step (evidence indicator "n ATT").
    attach_counts: dict[int, int] = {}
    if step_exec_ids:
        for att_step_id, count in (
            db.query(Attachment.step_execution_id, func.count())
            .filter(Attachment.step_execution_id.in_(step_exec_ids))
            .group_by(Attachment.step_execution_id)
            .all()
        ):
            attach_counts[att_step_id] = count

    steps: list[dict[str, Any]] = []
    done = 0
    total = 0
    for se in sorted(instance.step_executions, key=lambda s: s.step_number):
        vs = vs_map.get(se.step_number) or {}
        status = _status_value(se.status)
        step_cursors = cursors_by_step.get(se.id, [])
        completer = user_lookup.get(se.completed_by_id) if se.completed_by_id else None

        is_leaf = se.level > 0 or not any(
            parent_order_of(other) == se.step_number
            for other in instance.step_executions
            if other.level > 0
        )
        if is_leaf and not vs.get("is_contingency", False):
            total += 1
            if status in TERMINAL_STEP_STATUSES:
                done += 1

        steps.append(
            {
                "order": se.step_number,
                "number": step_display(se),
                "level": se.level,
                "parent_order": parent_order_of(se),
                "title": se.title or vs.get("title"),
                "status": status,
                "role": vs.get("required_role"),
                "is_ad_hoc": se.ad_hoc_issue_id is not None,
                "cursors": [_cursor_entry(c) for c in step_cursors],
                "completed": {
                    "by": completer.name if completer else None,
                    "initials": user_initials(completer.name if completer else None),
                    "at": _iso(se.completed_at),
                }
                if status in (StepStatus.COMPLETED.value, StepStatus.SIGNED_OFF.value)
                else None,
                "holds": [
                    {
                        "issue_id": i.id,
                        "issue_number": i.issue_number,
                        "kind": "bound",
                        "disposition_state": i.disp_state,
                    }
                    for i in bound.get(se.id, [])
                ]
                + [
                    {
                        "issue_id": i.id,
                        "issue_number": i.issue_number,
                        "kind": "raised",
                        "disposition_state": i.disp_state,
                    }
                    for i in raised.get(se.id, [])
                ],
                "attachments": attach_counts.get(se.id, 0),
                "notes": [
                    {
                        "id": n.id,
                        "author": (
                            user_lookup[n.author_id].name
                            if n.author_id and n.author_id in user_lookup
                            else None
                        ),
                        "created_at": _iso(n.created_at),
                        "body": n.body,
                    }
                    for n in step_notes.get(se.id, [])
                ],
            }
        )

    # Roster: cursor holders first ("name @step"), then joined users whose
    # cursor isn't placed yet.
    roster: list[dict[str, Any]] = []
    step_by_id = {se.id: se for se in instance.step_executions}
    for cursor in sorted(cursors, key=lambda c: c.focused_at):
        user = user_lookup.get(cursor.user_id)
        se = step_by_id.get(cursor.step_execution_id)
        roster.append(
            {
                "user_id": cursor.user_id,
                "name": user.name if user else None,
                "initials": user_initials(user.name if user else None),
                "step_order": se.step_number if se else None,
                "step_number": step_display(se) if se else None,
                "focused_at": _iso(cursor.focused_at),
                "stale": _stale(user),
            }
        )
    cursor_user_ids = {c.user_id for c in cursors}
    for p in instance.participants or []:
        uid = p.get("user_id")
        if uid is None or uid in cursor_user_ids:
            continue
        user = user_lookup.get(uid)
        roster.append(
            {
                "user_id": uid,
                "name": user.name if user else p.get("user_name"),
                "initials": user_initials(user.name if user else p.get("user_name")),
                "step_order": None,
                "step_number": None,
                "focused_at": None,
                "stale": _stale(user),
            }
        )

    # Rail holds: undispositioned first, one entry per issue.
    holds_by_issue: dict[int, dict[str, Any]] = {}
    for se_id, issues in list(bound.items()) + list(raised.items()):
        se = step_by_id.get(se_id)
        for issue in issues:
            entry = holds_by_issue.setdefault(
                issue.id,
                {
                    "issue_id": issue.id,
                    "issue_number": issue.issue_number,
                    "title": issue.title,
                    "disposition_state": issue.disp_state,
                    "blocks": [],
                },
            )
            if se is not None:
                num = step_display(se)
                if num not in entry["blocks"]:
                    entry["blocks"].append(num)

    return {
        "instance": {
            "id": instance.id,
            "work_order": instance.work_order_number,
            "status": _status_value(instance.status),
            "procedure_name": instance.procedure.name if instance.procedure else None,
            "version_number": version.version_number if version else None,
            "progress": {"done": done, "total": total},
        },
        "steps": steps,
        "roster": roster,
        "holds": sorted(
            holds_by_issue.values(),
            key=lambda h: (h["disposition_state"] != "undispositioned", h["issue_number"] or ""),
        ),
        "generated_at": now.isoformat(),
    }
