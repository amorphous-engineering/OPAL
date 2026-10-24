"""Sign-off definitions: the one definition of a step's effective sign-offs.

A step (or OP) carries an ordered list of sign-off slots ``[{label, role}]``.
It is complete when every slot is signed. A slot's label is its position, never
authored: the first slot is Primary buyoff, every later one Secondary buyoff (``slot_label``).
The role (the gate) is the only authored part of a slot. Templates may store the list
explicitly (``signoffs``) or leave it null, in which case it is derived from the
legacy ``requires_signoff`` / ``required_role`` fields. Once a list is written,
the legacy fields become derived from it (``derive_legacy``) so there is one
fact and one home.
"""

from collections.abc import Mapping, Sequence
from typing import Any

from sqlalchemy.orm import Session

from opal.core.roles import UnknownRoleError, canonical_role_name

PRIMARY_LABEL = "Primary buyoff"
SECONDARY_LABEL = "Secondary buyoff"

MAX_ROLE = 50


class SignoffError(ValueError):
    """A sign-off definition list is malformed."""


class UnknownSignoffRole(SignoffError, UnknownRoleError):
    """A sign-off slot names a role that does not exist (a 400, not a 422)."""


def slot_label(index: int) -> str:
    """The label of the slot at ``index``: Primary buyoff first, Secondary buyoff after."""
    return PRIMARY_LABEL if index == 0 else SECONDARY_LABEL


def _slot(label: str, role: str | None) -> dict[str, Any]:
    return {"label": label, "role": role}


def relabel_signoffs(slots: Sequence[Mapping[str, Any]]) -> list[dict[str, Any]]:
    """Slots with labels set by position (for reads and comparisons)."""
    return [_slot(slot_label(i), s.get("role") or None) for i, s in enumerate(slots)]


def default_signoffs(
    required_role: str | None, requires_signoff: bool, has_children: bool
) -> list[dict[str, Any]]:
    """The list a step has when none is stored."""
    if has_children:
        return [_slot(PRIMARY_LABEL, required_role)] if requires_signoff else []
    slots = [_slot(PRIMARY_LABEL, required_role)]
    if requires_signoff:
        slots.append(_slot(SECONDARY_LABEL, None))
    return slots


def effective_signoffs(step: Mapping[str, Any], has_children: bool) -> list[dict[str, Any]]:
    """A step's sign-off slots, in order. ``step`` is any mapping with the keys
    ``signoffs``, ``requires_signoff`` and ``required_role`` (a version snapshot
    step, or a row rendered as a dict).

    - explicit non-null list: that list (a leaf with an empty list gets the
      default primary slot);
    - null, leaf: Primary buyoff (role = required_role) plus Secondary buyoff
      when requires_signoff;
    - null, OP with sub-steps: one Primary buyoff slot when requires_signoff, else none.

    A leaf step always has at least one slot; an OP with sub-steps may have none.
    """
    explicit = step.get("signoffs")
    role = step.get("required_role")
    requires = bool(step.get("requires_signoff"))
    if explicit is None:
        return default_signoffs(role, requires, has_children)
    slots = [_slot(str(s.get("label") or ""), s.get("role") or None) for s in explicit]
    if not slots and not has_children:
        return default_signoffs(role, False, False)
    return slots


def normalize_signoffs(raw: Sequence[Mapping[str, Any]]) -> list[dict[str, Any]]:
    """Validate and clean a posted list: roles trimmed or null, labels by position.
    A posted label is ignored."""
    out: list[dict[str, Any]] = []
    for i, item in enumerate(raw):
        label = slot_label(i)
        role_raw = item.get("role")
        role = str(role_raw).strip() if role_raw is not None else ""
        if len(role) > MAX_ROLE:
            raise SignoffError(f"Sign-off role is longer than {MAX_ROLE} characters")
        out.append(_slot(label, role or None))
    return out


def derive_legacy(
    slots: Sequence[Mapping[str, Any]], has_children: bool
) -> tuple[bool, str | None]:
    """(requires_signoff, required_role) implied by an effective list."""
    requires = len(slots) > 0 if has_children else len(slots) > 1
    role = slots[0].get("role") if slots else None
    return requires, role


def apply_legacy_to_explicit(
    explicit: Sequence[Mapping[str, Any]],
    has_children: bool,
    *,
    requires_signoff: bool | None = None,
    set_role: bool = False,
    required_role: str | None = None,
) -> list[dict[str, Any]]:
    """Carry a legacy write (requires_signoff / required_role) into an explicit list.

    Turning requires_signoff on appends the default
    trailing slot, turning it off drops every slot after the first (all of them
    for an OP); a role write lands on slot 0.
    """
    slots = effective_signoffs({"signoffs": list(explicit)}, has_children)
    if requires_signoff is not None:
        if has_children:
            if requires_signoff and not slots:
                slots = [_slot(PRIMARY_LABEL, None)]
            elif not requires_signoff:
                slots = []
        elif requires_signoff and len(slots) < 2:
            slots = [*slots, _slot(SECONDARY_LABEL, None)]
        elif not requires_signoff:
            slots = slots[:1]
    if set_role and slots:
        slots[0] = _slot(slots[0]["label"], required_role or None)
    return slots


def effective_for(step: Any, has_children: bool) -> list[dict[str, Any]]:
    """effective_signoffs for an object with the three template attributes
    (a ProcedureStep row). Labels come from position, so a master step stored
    before labels were fixed reads as Primary buyoff / Secondary buyoff too."""
    return relabel_signoffs(
        effective_signoffs(
            {
                "signoffs": step.signoffs,
                "requires_signoff": step.requires_signoff,
                "required_role": step.required_role,
            },
            has_children,
        )
    )


class _Unset:
    def __repr__(self) -> str:
        return "UNSET"


UNSET: Any = _Unset()


def write_signoff_fields(
    step: Any,
    has_children: bool,
    *,
    signoffs: Sequence[Mapping[str, Any]] | None | Any = UNSET,
    requires_signoff: bool | Any = UNSET,
    required_role: str | None | Any = UNSET,
    db: Session | None = None,
) -> None:
    """The one write path for a template step's sign-off fields.

    Writing ``signoffs`` stores the list (None resets to derived) and derives the
    legacy ``requires_signoff`` / ``required_role`` from it. Legacy-only writes
    keep working: they land on the legacy columns and, when the step already has
    an explicit list, are carried into it so the two never disagree.
    With ``db``, every role must be an existing role (else UnknownRoleError) and
    is stored in the role's canonical casing.
    Raises SignoffError on a malformed list."""
    if db is not None:
        try:
            if signoffs is not UNSET and signoffs is not None:
                signoffs = [{**s, "role": canonical_role_name(db, s.get("role"))} for s in signoffs]
            if required_role is not UNSET:
                required_role = canonical_role_name(db, required_role)
        except UnknownRoleError as err:
            raise UnknownSignoffRole(str(err)) from err
    if signoffs is not UNSET:
        if signoffs is None:
            step.signoffs = None
        else:
            step.signoffs = normalize_signoffs(signoffs)
            step.requires_signoff, step.required_role = derive_legacy(
                effective_for(step, has_children), has_children
            )
            return
    if requires_signoff is not UNSET:
        step.requires_signoff = bool(requires_signoff)
    if required_role is not UNSET:
        step.required_role = required_role
    if step.signoffs is not None and (requires_signoff is not UNSET or required_role is not UNSET):
        step.signoffs = apply_legacy_to_explicit(
            step.signoffs,
            has_children,
            requires_signoff=None if requires_signoff is UNSET else bool(requires_signoff),
            set_role=required_role is not UNSET,
            required_role=None if required_role is UNSET else required_role,
        )
        step.requires_signoff, step.required_role = derive_legacy(
            effective_for(step, has_children), has_children
        )
