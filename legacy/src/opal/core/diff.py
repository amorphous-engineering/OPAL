"""Procedure version diff logic."""

from dataclasses import dataclass, field
from typing import Any

from opal.core.callouts import step_callouts
from opal.core.signoffs import effective_signoffs, relabel_signoffs


@dataclass
class StepDiff:
    """Diff result for a single step."""

    status: str  # "added", "removed", "modified", "unchanged"
    step_a: dict[str, Any] | None = None
    step_b: dict[str, Any] | None = None
    changed_fields: list[str] = field(default_factory=list)


_STEP_COMPARE_FIELDS = [
    "title",
    "instructions",
    "is_contingency",
    "estimated_duration_minutes",
    "required_role",
    "callouts",
    "required_data_schema",
    "requires_signoff",
    "signoffs",
    "strict_sequence",
    "depends_on",
    "step_kit",
    "images",
]


def diff_procedure_versions(
    content_a: dict[str, Any],
    content_b: dict[str, Any],
) -> tuple[list[str], list[StepDiff]]:
    """Compare two procedure version content dicts.

    Returns:
        Tuple of (procedure-level changed field names, list of StepDiff).
    """
    # Procedure-level changes
    proc_changes: list[str] = []
    for pf in ("procedure_name", "procedure_description"):
        if content_a.get(pf) != content_b.get(pf):
            proc_changes.append(pf)

    # Build step lookups keyed by step_number. Sign-offs compare as the effective
    # list, so a legacy snapshot (no list) equals its explicit rewrite.
    steps_a = {
        s["step_number"]: s for s in _with_effective_signoffs(content_a) if "step_number" in s
    }
    steps_b = {
        s["step_number"]: s for s in _with_effective_signoffs(content_b) if "step_number" in s
    }

    all_step_numbers = sorted(
        set(steps_a.keys()) | set(steps_b.keys()),
        key=_step_sort_key,
    )

    diffs: list[StepDiff] = []
    for sn in all_step_numbers:
        sa = steps_a.get(sn)
        sb = steps_b.get(sn)

        if sa and not sb:
            diffs.append(StepDiff(status="removed", step_a=sa))
        elif sb and not sa:
            diffs.append(StepDiff(status="added", step_b=sb))
        else:
            # Both exist — compare fields
            changed = []
            for f in _STEP_COMPARE_FIELDS:
                if sa.get(f) != sb.get(f):
                    changed.append(f)
            if changed:
                diffs.append(
                    StepDiff(status="modified", step_a=sa, step_b=sb, changed_fields=changed)
                )
            else:
                diffs.append(StepDiff(status="unchanged", step_a=sa, step_b=sb))

    return proc_changes, diffs


def _with_effective_signoffs(content: dict[str, Any]) -> list[dict[str, Any]]:
    """Snapshot steps with ``signoffs`` replaced by the effective list. Labels are
    set by position, so a version published before labels were fixed compares by
    its roles only."""
    steps = content.get("steps", [])
    parents = {s.get("parent_step_id") for s in steps if s.get("parent_step_id") is not None}
    out = []
    for s in steps:
        n = {k: v for k, v in s.items() if k != "caution"}
        n["signoffs"] = relabel_signoffs(effective_signoffs(s, s.get("id") in parents))
        n["callouts"] = step_callouts(s)
        out.append(n)
    return out


def _step_sort_key(sn: str) -> tuple:
    """Sort step numbers: 1, 1.1, 1.2, 2, C1, C2."""
    is_contingency = sn.startswith("C")
    num_part = sn.lstrip("C")
    parts = num_part.split(".")
    nums = []
    for p in parts:
        try:
            nums.append(int(p))
        except ValueError:
            nums.append(0)
    return (is_contingency, nums)


def diff_part_lists(
    list_a: list[dict[str, Any]],
    list_b: list[dict[str, Any]],
    qty_key: str = "quantity_required",
) -> list[dict[str, Any]]:
    """Compare two snapshot part lists (kit_items / output_items) by part id.

    Returns one row per part that is added, removed, or changed in quantity
    (unchanged parts are omitted).
    """
    a = {i["part_id"]: float(i.get(qty_key, 0)) for i in list_a if "part_id" in i}
    b = {i["part_id"]: float(i.get(qty_key, 0)) for i in list_b if "part_id" in i}
    rows: list[dict[str, Any]] = []
    for pid in sorted(set(a) | set(b)):
        if pid not in b:
            rows.append(
                {"part_id": pid, "status": "removed", "quantity_a": a[pid], "quantity_b": None}
            )
        elif pid not in a:
            rows.append(
                {"part_id": pid, "status": "added", "quantity_a": None, "quantity_b": b[pid]}
            )
        elif a[pid] != b[pid]:
            rows.append(
                {"part_id": pid, "status": "modified", "quantity_a": a[pid], "quantity_b": b[pid]}
            )
    return rows


def _normalized(content: dict[str, Any]) -> dict[str, Any]:
    """Snapshot content with database identity removed, so a restored or re-created
    draft that reads the same compares equal to the version it came from."""
    steps = _with_effective_signoffs(content)
    order_by_id = {s.get("id"): s.get("order") for s in steps}
    norm_steps = []
    for s in steps:
        n = {k: v for k, v in s.items() if k not in ("id", "parent_step_id", "images")}
        n["parent_order"] = order_by_id.get(s.get("parent_step_id"))
        n["images"] = [i.get("caption") for i in s.get("images", [])]
        n["step_kit"] = sorted(s.get("step_kit", []), key=lambda k: k.get("part_id", 0))
        norm_steps.append(n)
    return {
        "name": content.get("procedure_name"),
        "description": content.get("procedure_description"),
        "steps": sorted(norm_steps, key=lambda s: s.get("order", 0)),
        "kit": sorted(content.get("kit_items", []), key=lambda k: k.get("part_id", 0)),
        "outputs": sorted(content.get("output_items", []), key=lambda k: k.get("part_id", 0)),
    }


def snapshots_equivalent(a: dict[str, Any], b: dict[str, Any]) -> bool:
    """True when two snapshot contents describe the same procedure."""
    return _normalized(a) == _normalized(b)
