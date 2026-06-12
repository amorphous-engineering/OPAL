"""Execution flow: claims, hold gating, completion, document state.

The single home for the commitment-moment rules of the execution document.
START/claim and COMPLETE are commitment moments — each checks its
dependencies' states here, and both the JSON API routes and the MCP tools
call these functions rather than carrying their own copies.

Hold doctrine (Issues R2 §2/§9): the blocking predicate is *undispositioned*,
never "open". A hold is derived state — it lifts the moment its issue reaches
a terminal disposition, with no status choreography. Two gate kinds exist
today:
- raised-on-step (containment "step"): undispositioned NCs raised on a step
  block that step's COMPLETE, and the containing OP's COMPLETE.
- bound-step (``issue_step_block``): an issue bound to a future step blocks
  that step's START.
"""

from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import func
from sqlalchemy.orm import Session

from opal.core.audit import get_model_dict, log_create, log_update
from opal.db.models.attachment import Attachment
from opal.db.models.execution import (
    ClaimReleaseReason,
    InstanceStatus,
    ProcedureInstance,
    StepClaim,
    StepExecution,
    StepStatus,
)
from opal.db.models.inventory import InventoryProduction, ProductionStatus
from opal.db.models.issue import Issue, IssueStatus, IssueStepBlock, IssueType
from opal.db.models.procedure import ProcedureVersion
from opal.db.models.user import User

TERMINAL_STEP_STATUSES = {
    StepStatus.COMPLETED.value,
    StepStatus.SIGNED_OFF.value,
    StepStatus.SKIPPED.value,
}

# Roster chips gray out when a participant's heartbeat goes quiet (tablets
# sleep; the claim persists).
PRESENCE_STALE_SECONDS = 60


class FlowError(Exception):
    """A commitment-moment rule refused the action."""

    status_code = 400

    def __init__(self, message: str):
        super().__init__(message)
        self.message = message


class ClaimConflict(FlowError):
    """The step is actively claimed by someone else."""

    status_code = 409


def _status_value(obj: Any) -> str:
    return obj.value if hasattr(obj, "value") else obj


def undispositioned(issue: Issue) -> bool:
    """The blocking predicate (Issues R2): a hold lifts at disposition, not
    closure. On the current schema a terminal disposition is the
    disposition_approved or closed status."""
    return _status_value(issue.status) not in (
        IssueStatus.DISPOSITION_APPROVED.value,
        IssueStatus.CLOSED.value,
    )


def disposition_state(issue: Issue) -> str:
    """undispositioned | dispositioned | closed — the issue's gate position."""
    status = _status_value(issue.status)
    if status == IssueStatus.CLOSED.value:
        return "closed"
    if status == IssueStatus.DISPOSITION_APPROVED.value:
        return "dispositioned"
    return "undispositioned"


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
    """Undispositioned NCs raised on a step, keyed by step_execution_id.
    These block COMPLETE of their step and of the containing OP."""
    issues = (
        db.query(Issue)
        .filter(
            Issue.procedure_instance_id == instance_id,
            Issue.step_execution_id.isnot(None),
            Issue.issue_type == IssueType.NON_CONFORMANCE,
            Issue.status.notin_([IssueStatus.DISPOSITION_APPROVED, IssueStatus.CLOSED]),
            Issue.deleted_at.is_(None),
        )
        .all()
    )
    result: dict[int, list[Issue]] = {}
    for issue in issues:
        result.setdefault(issue.step_execution_id, []).append(issue)
    return result


def bound_blocks_by_step(db: Session, instance_id: int) -> dict[int, list[Issue]]:
    """Undispositioned issues bound to steps via issue_step_block, keyed by
    step_execution_id. These block START of the bound step."""
    rows = (
        db.query(IssueStepBlock, Issue)
        .join(Issue, Issue.id == IssueStepBlock.issue_id)
        .join(StepExecution, StepExecution.id == IssueStepBlock.step_execution_id)
        .filter(
            StepExecution.instance_id == instance_id,
            Issue.status.notin_([IssueStatus.DISPOSITION_APPROVED, IssueStatus.CLOSED]),
            Issue.deleted_at.is_(None),
        )
        .all()
    )
    result: dict[int, list[Issue]] = {}
    for block, issue in rows:
        result.setdefault(block.step_execution_id, []).append(issue)
    return result


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


def start_blockers(
    db: Session,
    instance: ProcedureInstance,
    step_exec: StepExecution,
) -> list[Blocker]:
    """Everything stopping this step from being claimed/started."""
    blockers: list[Blocker] = []
    exec_lookup = _exec_lookup(instance)
    version = db.get(ProcedureVersion, instance.version_id)
    vs_map = version_step_map(version)

    # Bound-step holds on the step itself.
    bound = bound_blocks_by_step(db, instance.id)
    for issue in bound.get(step_exec.id, []):
        blockers.append(
            Blocker(
                kind="hold",
                message=f"Blocked by {issue.issue_number}",
                issue_id=issue.id,
                issue_number=issue.issue_number,
            )
        )

    # Gate against the op-level entry — for sub-steps that's the parent op.
    gate_op_order: int | None = None
    if step_exec.level == 0:
        gate_op_order = step_exec.step_number
    elif step_exec.parent_step_order is not None:
        gate_op_order = step_exec.parent_step_order
        parent_exec = next(
            (
                se
                for se in instance.step_executions
                if se.step_number == gate_op_order and se.level == 0
            ),
            None,
        )
        if parent_exec is not None:
            if _status_value(parent_exec.status) == StepStatus.ON_HOLD.value:
                blockers.append(
                    Blocker(kind="parent_hold", message="Parent OP is on hold (open NC)")
                )
            for issue in bound.get(parent_exec.id, []):
                blockers.append(
                    Blocker(
                        kind="hold",
                        message=f"OP blocked by {issue.issue_number}",
                        issue_id=issue.id,
                        issue_number=issue.issue_number,
                    )
                )

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


def complete_blockers(
    db: Session,
    instance: ProcedureInstance,
    step_exec: StepExecution,
) -> list[Blocker]:
    """Undispositioned issues holding this step's (or OP's) COMPLETE.

    Step scope: NCs raised on the step itself. OP scope: NCs raised on the
    OP or any of its sub-steps — an OP cannot complete around held work.
    """
    raised = holding_ncs_by_step(db, instance.id)
    scope_ids = [step_exec.id]
    if step_exec.level == 0:
        scope_ids += [
            se.id
            for se in instance.step_executions
            if se.parent_step_order == step_exec.step_number
        ]
    blockers: list[Blocker] = []
    seen: set[int] = set()
    for se_id in scope_ids:
        for issue in raised.get(se_id, []):
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


# ============ Claims ============


def active_claims(db: Session, instance_id: int) -> list[StepClaim]:
    return (
        db.query(StepClaim)
        .filter(StepClaim.instance_id == instance_id, StepClaim.released_at.is_(None))
        .all()
    )


def active_claim_for_step(db: Session, step_execution_id: int) -> StepClaim | None:
    return (
        db.query(StepClaim)
        .filter(
            StepClaim.step_execution_id == step_execution_id,
            StepClaim.released_at.is_(None),
        )
        .first()
    )


def release_claim(
    db: Session,
    claim: StepClaim,
    reason: ClaimReleaseReason,
    user_id: int | None,
) -> None:
    """End a claim. Releasing un-finished work returns the step to pending —
    no zombie claims, no zombie in-progress rows."""
    old = get_model_dict(claim)
    claim.released_at = datetime.now(UTC)
    claim.release_reason = reason
    log_update(db, claim, old, user_id)

    step_exec = claim.step_execution
    if reason in (ClaimReleaseReason.RELEASED, ClaimReleaseReason.SUPERSEDED):
        others = (
            db.query(StepClaim)
            .filter(
                StepClaim.step_execution_id == step_exec.id,
                StepClaim.released_at.is_(None),
                StepClaim.id != claim.id,
            )
            .count()
        )
        if others == 0 and _status_value(step_exec.status) == StepStatus.IN_PROGRESS.value:
            step_old = get_model_dict(step_exec)
            step_exec.status = StepStatus.PENDING
            step_exec.started_at = None
            log_update(db, step_exec, step_old, user_id)


def release_user_claims(
    db: Session,
    instance_id: int,
    user_id: int,
    reason: ClaimReleaseReason,
) -> list[StepClaim]:
    claims = (
        db.query(StepClaim)
        .filter(
            StepClaim.instance_id == instance_id,
            StepClaim.user_id == user_id,
            StepClaim.released_at.is_(None),
        )
        .all()
    )
    for claim in claims:
        release_claim(db, claim, reason, user_id)
    return claims


@dataclass
class ClaimResult:
    claim: StepClaim
    instance_started: bool = False


def claim_step(
    db: Session,
    instance: ProcedureInstance,
    step_exec: StepExecution,
    user: User,
) -> ClaimResult:
    """Claim = START. One user per step; one active step per user (claiming
    another supersedes the first). Checks the start gates."""
    inst_status = _status_value(instance.status)
    if inst_status not in (InstanceStatus.CUT.value, InstanceStatus.IN_WORK.value):
        raise FlowError("Instance is not active")

    existing = active_claim_for_step(db, step_exec.id)
    if existing is not None:
        if existing.user_id == user.id:
            return ClaimResult(claim=existing)
        holder = existing.user.name if existing.user else "another user"
        raise ClaimConflict(f"Step {step_display(step_exec)} is claimed by {holder}")

    step_status = _status_value(step_exec.status)
    if step_status == StepStatus.PENDING.value:
        blockers = start_blockers(db, instance, step_exec)
        if blockers:
            raise FlowError("Cannot start: " + "; ".join(b.message for b in blockers))
    elif step_status != StepStatus.IN_PROGRESS.value:
        # IN_PROGRESS without an active claim is adoptable (legacy starts);
        # anything terminal or held is not claimable.
        raise FlowError(f"Cannot claim step in {step_status} status")

    # One active step per user: supersede the previous claim.
    release_user_claims(db, instance.id, user.id, ClaimReleaseReason.SUPERSEDED)

    instance_started = False
    if inst_status == InstanceStatus.CUT.value:
        instance.status = InstanceStatus.IN_WORK
        instance.started_at = datetime.now(UTC)
        db.query(InventoryProduction).filter(
            InventoryProduction.procedure_instance_id == instance.id,
            InventoryProduction.status == ProductionStatus.PLANNED,
        ).update({InventoryProduction.status: ProductionStatus.WIP})
        instance_started = True

    if _status_value(step_exec.status) == StepStatus.PENDING.value:
        step_old = get_model_dict(step_exec)
        step_exec.status = StepStatus.IN_PROGRESS
        step_exec.started_at = datetime.now(UTC)
        log_update(db, step_exec, step_old, user.id)

    claim = StepClaim(
        instance_id=instance.id,
        step_execution_id=step_exec.id,
        user_id=user.id,
        claimed_at=datetime.now(UTC),
    )
    db.add(claim)
    db.flush()
    log_create(db, claim, user.id)

    return ClaimResult(claim=claim, instance_started=instance_started)


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
    validation_errors: list[str] = field(default_factory=list)


def complete_step_flow(
    db: Session,
    instance: ProcedureInstance,
    step_exec: StepExecution,
    user_id: int,
    data_captured: dict[str, Any] | None = None,
    notes: str | None = None,
) -> CompleteResult:
    """COMPLETE is a commitment moment: it checks the undispositioned-issue
    state of its scope, validates required data, releases the claim, and
    cascades instance completion."""
    step_status = _status_value(step_exec.status)
    if step_status in (StepStatus.COMPLETED.value, StepStatus.SIGNED_OFF.value):
        raise FlowError("Step already completed")
    if step_status not in (
        StepStatus.PENDING.value,
        StepStatus.IN_PROGRESS.value,
        StepStatus.AWAITING_SIGNOFF.value,
    ):
        raise FlowError(f"Cannot complete step in {step_status} status")

    existing = active_claim_for_step(db, step_exec.id)
    if existing is not None and existing.user_id != user_id:
        holder = existing.user.name if existing.user else "another user"
        raise ClaimConflict(f"Step {step_display(step_exec)} is claimed by {holder}")

    holds = complete_blockers(db, instance, step_exec)
    if holds:
        raise FlowError("Cannot complete: " + "; ".join(b.message for b in holds))

    version = db.get(ProcedureVersion, instance.version_id)
    errors = validate_data_captured(version, step_exec, data_captured)
    if errors:
        return CompleteResult(step_exec=step_exec, validation_errors=errors)

    if step_status == StepStatus.PENDING.value:
        step_exec.started_at = datetime.now(UTC)

    step_exec.status = StepStatus.COMPLETED
    step_exec.completed_at = datetime.now(UTC)
    step_exec.completed_by_id = user_id
    if data_captured:
        step_exec.data_captured = data_captured
    if notes is not None:
        step_exec.notes = notes

    for claim in (
        db.query(StepClaim)
        .filter(StepClaim.step_execution_id == step_exec.id, StepClaim.released_at.is_(None))
        .all()
    ):
        release_claim(db, claim, ClaimReleaseReason.COMPLETED, user_id)

    old_instance_status = _status_value(instance.status)
    check_instance_completion(db, instance)

    if step_exec.ad_hoc_issue_id is not None:
        redline_issue = (
            db.query(Issue)
            .filter(Issue.id == step_exec.ad_hoc_issue_id, Issue.deleted_at.is_(None))
            .first()
        )
        if redline_issue is not None:
            maybe_resume_step_after_nc_update(db, redline_issue, user_id)

    instance_completed = (
        old_instance_status != InstanceStatus.COMPLETED.value
        and _status_value(instance.status) == InstanceStatus.COMPLETED.value
    )
    return CompleteResult(step_exec=step_exec, instance_completed=instance_completed)


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
    raised = holding_ncs_by_step(db, instance.id)

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
                    scope_held = bool(raised.get(step_exec.id)) or any(
                        raised.get(c.id) for c in children
                    )
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
        if is_contingency and step_status == StepStatus.IN_PROGRESS.value:
            return

    instance.status = InstanceStatus.COMPLETED
    instance.completed_at = datetime.now(UTC)


def maybe_resume_step_after_nc_update(db: Session, issue: Issue, user_id: int | None) -> None:
    """If this NC just reached a terminal state and no other open NCs remain on
    its step, pop the step back to IN_PROGRESS. Propagates the resume to a
    held parent op when no sibling holds remain."""
    if issue.step_execution_id is None:
        return
    if _status_value(issue.issue_type) != IssueType.NON_CONFORMANCE.value:
        return
    if undispositioned(issue):
        return

    step_exec = db.get(StepExecution, issue.step_execution_id)
    if step_exec is None:
        return
    if _status_value(step_exec.status) != StepStatus.ON_HOLD.value:
        return

    remaining = (
        db.query(Issue)
        .filter(
            Issue.step_execution_id == step_exec.id,
            Issue.issue_type == IssueType.NON_CONFORMANCE,
            Issue.id != issue.id,
            Issue.status.notin_([IssueStatus.DISPOSITION_APPROVED, IssueStatus.CLOSED]),
            Issue.deleted_at.is_(None),
        )
        .count()
    )
    if remaining != 0:
        return

    # Hold back if any redline op authorized by an NC on this step is still
    # outstanding. Approving the disposition isn't enough — the rework itself
    # has to be completed before the held step can resume.
    open_redlines = (
        db.query(StepExecution)
        .join(Issue, Issue.id == StepExecution.ad_hoc_issue_id)
        .filter(
            StepExecution.instance_id == step_exec.instance_id,
            StepExecution.level == 0,
            Issue.step_execution_id == step_exec.id,
            Issue.deleted_at.is_(None),
            StepExecution.status.notin_(
                [StepStatus.COMPLETED, StepStatus.SIGNED_OFF, StepStatus.SKIPPED]
            ),
        )
        .count()
    )
    if open_redlines:
        return

    step_old = get_model_dict(step_exec)
    step_exec.status = StepStatus.IN_PROGRESS
    log_update(db, step_exec, step_old, user_id)

    # When an NC was logged on a sub-step the parent op was also flipped to
    # ON_HOLD. Resume the parent too — but only if no other sub-step of that
    # parent has any open NC remaining.
    if step_exec.level > 0 and step_exec.parent_step_order is not None:
        parent_exec = (
            db.query(StepExecution)
            .filter(
                StepExecution.instance_id == step_exec.instance_id,
                StepExecution.step_number == step_exec.parent_step_order,
                StepExecution.level == 0,
            )
            .first()
        )
        if (
            parent_exec is not None
            and _status_value(parent_exec.status) == StepStatus.ON_HOLD.value
        ):
            sibling_se_ids = [
                se.id
                for se in db.query(StepExecution)
                .filter(
                    StepExecution.instance_id == step_exec.instance_id,
                    StepExecution.parent_step_order == parent_exec.step_number,
                )
                .all()
            ]
            sibling_se_ids.append(parent_exec.id)
            siblings_open = (
                db.query(Issue)
                .filter(
                    Issue.step_execution_id.in_(sibling_se_ids),
                    Issue.issue_type == IssueType.NON_CONFORMANCE,
                    # Exclude the issue being dispositioned — its in-memory
                    # status change may not be flushed yet.
                    Issue.id != issue.id,
                    Issue.status.notin_([IssueStatus.DISPOSITION_APPROVED, IssueStatus.CLOSED]),
                    Issue.deleted_at.is_(None),
                )
                .count()
            )
            if siblings_open == 0:
                parent_old = get_model_dict(parent_exec)
                parent_exec.status = StepStatus.IN_PROGRESS
                log_update(db, parent_exec, parent_old, user_id)


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

    claims = active_claims(db, instance.id)
    claims_by_step: dict[int, StepClaim] = {c.step_execution_id: c for c in claims}
    raised = holding_ncs_by_step(db, instance.id)
    bound = bound_blocks_by_step(db, instance.id)

    user_ids = {c.user_id for c in claims}
    for p in instance.participants or []:
        if p.get("user_id"):
            user_ids.add(p["user_id"])
    completer_ids = {se.completed_by_id for se in instance.step_executions if se.completed_by_id}
    users = (
        db.query(User).filter(User.id.in_(user_ids | completer_ids)).all()
        if (user_ids | completer_ids)
        else []
    )
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

    # Attachment counts per step (evidence indicator ⎙n).
    step_exec_ids = [se.id for se in instance.step_executions]
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
        claim = claims_by_step.get(se.id)
        claim_user = user_lookup.get(claim.user_id) if claim else None
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
                "claim": {
                    "user_id": claim.user_id,
                    "name": claim_user.name if claim_user else None,
                    "initials": user_initials(claim_user.name if claim_user else None),
                    "claimed_at": _iso(claim.claimed_at),
                    "stale": _stale(claim_user),
                }
                if claim
                else None,
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
                        "disposition_state": disposition_state(i),
                    }
                    for i in bound.get(se.id, [])
                ]
                + [
                    {
                        "issue_id": i.id,
                        "issue_number": i.issue_number,
                        "kind": "raised",
                        "disposition_state": disposition_state(i),
                    }
                    for i in raised.get(se.id, [])
                ],
                "attachments": attach_counts.get(se.id, 0),
                "has_notes": bool(se.notes),
            }
        )

    # Roster: active claimants first, then claim-less joined observers.
    roster: list[dict[str, Any]] = []
    step_by_id = {se.id: se for se in instance.step_executions}
    for claim in sorted(claims, key=lambda c: c.claimed_at):
        user = user_lookup.get(claim.user_id)
        se = step_by_id.get(claim.step_execution_id)
        roster.append(
            {
                "user_id": claim.user_id,
                "name": user.name if user else None,
                "initials": user_initials(user.name if user else None),
                "step_order": se.step_number if se else None,
                "step_number": step_display(se) if se else None,
                "claimed_at": _iso(claim.claimed_at),
                "stale": _stale(user),
                "observer": False,
            }
        )
    claimant_ids = {c.user_id for c in claims}
    for p in instance.participants or []:
        uid = p.get("user_id")
        if uid is None or uid in claimant_ids:
            continue
        user = user_lookup.get(uid)
        roster.append(
            {
                "user_id": uid,
                "name": user.name if user else p.get("user_name"),
                "initials": user_initials(user.name if user else p.get("user_name")),
                "step_order": None,
                "step_number": None,
                "claimed_at": None,
                "stale": _stale(user),
                "observer": True,
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
                    "disposition_state": disposition_state(issue),
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
