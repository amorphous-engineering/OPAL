"""Structure of a procedure draft: document order, numbering, and tree edits.

A procedure is a two-level tree: top-level OPs (normal ones, then contingency
ones) each holding sub-steps. ``ProcedureStep.order`` is a global sequence in
document order and ``step_number`` is derived from it ("1", "1.2", "C1").
Every structural edit rebuilds both from the tree, so numbering never drifts.
"""

from collections import defaultdict

from opal.db.models.procedure import ProcedureStep


def children_map(steps: list[ProcedureStep]) -> dict[int | None, list[ProcedureStep]]:
    """Group steps by parent, siblings sorted by their current order."""
    kids: dict[int | None, list[ProcedureStep]] = defaultdict(list)
    for s in steps:
        kids[s.parent_step_id].append(s)
    for siblings in kids.values():
        siblings.sort(key=lambda s: (s.order, s.id))
    return kids


def document_order(steps: list[ProcedureStep]) -> list[ProcedureStep]:
    """Steps as the document reads: normal OPs, then contingency OPs, each followed by its steps."""
    kids = children_map(steps)
    tops = kids.get(None, [])
    ordered_tops = [t for t in tops if not t.is_contingency] + [t for t in tops if t.is_contingency]
    out: list[ProcedureStep] = []
    for top in ordered_tops:
        out.append(top)
        out.extend(kids.get(top.id, []))
    return out


def renumber(steps: list[ProcedureStep]) -> None:
    """Recompute step_number for every step from the current order values.

    Normal top-level OPs are "1", "2", ...; contingency OPs "C1", "C2", ...;
    sub-steps "<op number>.<index>". Mutates in place; the caller commits.
    """
    kids = children_map(steps)
    tops = kids.get(None, [])
    normal = c = 0
    for op in tops:
        if op.is_contingency:
            c += 1
            op.step_number = f"C{c}"
        else:
            normal += 1
            op.step_number = str(normal)
    for op in tops:
        for i, sub in enumerate(kids.get(op.id, []), start=1):
            sub.step_number = f"{op.step_number}.{i}"
            sub.level = 1
            sub.is_contingency = op.is_contingency
        op.level = 0


def normalize(steps: list[ProcedureStep]) -> None:
    """Rebuild order (1..n in document order) and step numbers from the tree."""
    for i, s in enumerate(document_order(steps), start=1):
        s.order = i
    renumber(steps)


def place(
    steps: list[ProcedureStep],
    step: ProcedureStep,
    parent_id: int | None,
    index: int,
    is_contingency: bool = False,
) -> None:
    """Put ``step`` at ``index`` among the children of ``parent_id`` and normalize.

    For a top-level step the siblings are the OPs of the same contingency group.
    ``index`` is clamped to the sibling range.
    """
    by_id = {s.id: s for s in steps}
    parent = by_id.get(parent_id) if parent_id is not None else None
    step.parent_step_id = parent_id
    if parent is not None:
        step.is_contingency = parent.is_contingency
        step.level = 1
    else:
        step.is_contingency = is_contingency
        step.level = 0
    kids = children_map([s for s in steps if s.id != step.id])
    siblings = [
        s
        for s in kids.get(parent_id, [])
        if parent is not None or s.is_contingency == step.is_contingency
    ]
    siblings.insert(max(0, min(index, len(siblings))), step)
    # Only the relative order among siblings matters; normalize() makes it global.
    for n, s in enumerate(siblings):
        s.order = n
    normalize(steps)
