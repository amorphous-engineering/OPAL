"""Part number generation and validation.

One home for part-number facts: format parsing, uniqueness, and sequencing.
Sequences are per-tier rows in the designator_sequence table (keyed
"PN-{tier_level}"), incremented atomically like every other designator.
The counter never rolls back and soft-deleted parts keep their numbers,
so part numbers are never recycled — gaps are information.
"""

import re

from sqlalchemy.orm import Session

from opal.db.models.designator import DesignatorSequence
from opal.db.models.part import Part
from opal.project import ProjectConfig

# Fallback format when no project config is loaded: PN-{tier}-{seq:04d}
_FALLBACK_SEQUENCE_DIGITS = 4


class PartNumberError(ValueError):
    """A part number fails validation against the project numbering format."""


def _sequence_key(tier_level: int) -> str:
    return f"PN-{tier_level}"


def _format_part_number(project: ProjectConfig | None, tier_level: int, sequence: int) -> str:
    if project is None:
        return f"PN-{tier_level}-{sequence:0{_FALLBACK_SEQUENCE_DIGITS}d}"
    return project.generate_part_number(tier_level, sequence)


def part_number_regex(project: ProjectConfig | None, tier_level: int) -> re.Pattern[str]:
    """Build a regex matching valid part numbers for a tier.

    Derived from PartNumberingConfig.format by escaping literal chunks and
    substituting placeholder values; {sequence} captures the numeric sequence
    (at least sequence_digits digits — zfill pads but never truncates).
    """
    if project is None:
        return re.compile(rf"PN-{tier_level}-(?P<sequence>\d{{{_FALLBACK_SEQUENCE_DIGITS},}})$")

    tier = project.get_tier(tier_level)
    if tier is None:
        raise PartNumberError(f"Unknown tier level: {tier_level}")

    values = {
        "prefix": project.part_numbering.prefix,
        "sep": project.part_numbering.separator,
        "tier_code": tier.code,
        "tier_name": tier.name,
        "tier_level": str(tier.level),
    }
    template = project.part_numbering.format
    pattern = ""
    pos = 0
    for match in re.finditer(r"\{(\w+)\}", template):
        pattern += re.escape(template[pos : match.start()])
        token = match.group(1)
        if token == "sequence":
            pattern += rf"(?P<sequence>\d{{{project.part_numbering.sequence_digits},}})"
        elif token == "variant":
            pattern += rf"(?P<variant>\d{{{project.part_numbering.variant_digits},}})"
        elif token in values:
            pattern += re.escape(values[token])
        else:
            raise PartNumberError(f"Unknown placeholder {{{token}}} in part numbering format")
        pos = match.end()
    pattern += re.escape(template[pos:])
    return re.compile(pattern + "$")


def validate_part_number(project: ProjectConfig | None, tier_level: int, pn: str) -> int:
    """Validate a part number against the tier's format; return its sequence.

    Raises PartNumberError naming the expected format. Legacy/CAD designators
    belong in external_pn, not as malformed internal identities.
    """
    match = part_number_regex(project, tier_level).match(pn)
    if not match:
        example = _format_part_number(project, tier_level, 1)
        raise PartNumberError(
            f"'{pn}' does not match the tier-{tier_level} part number format (e.g. {example})"
        )
    return int(match.group("sequence"))


def pn_exists(db: Session, pn: str) -> bool:
    """True if any part row holds this number — including soft-deleted rows.

    Soft-deleted parts permanently block their numbers; no recycling.
    """
    return db.query(Part.id).filter(Part.internal_pn == pn).first() is not None


def _get_or_create_sequence(db: Session, tier_level: int) -> DesignatorSequence:
    seq = (
        db.query(DesignatorSequence)
        .filter(DesignatorSequence.designator_type == _sequence_key(tier_level))
        .with_for_update()
        .first()
    )
    if seq is None:
        seq = DesignatorSequence(designator_type=_sequence_key(tier_level), last_value=0)
        db.add(seq)
    return seq


def next_part_number(db: Session, tier_level: int) -> str:
    """Consume and return the next part number for a tier.

    Skips past any number already taken (e.g. by a manual override or a
    pre-counter row); the skip itself advances the counter, so skipped
    numbers stay consumed.
    """
    from opal.config import get_active_project

    project = get_active_project()
    seq = _get_or_create_sequence(db, tier_level)
    while True:
        seq.last_value += 1
        pn = _format_part_number(project, tier_level, seq.last_value)
        if not pn_exists(db, pn):
            break
    db.flush()
    return pn


def format_has_variant(project: ProjectConfig | None) -> bool:
    """True when the numbering format mints variant codes."""
    return project is not None and "{variant}" in project.part_numbering.format


def next_variant_part_number(db: Session, tier_level: int, source_pn: str) -> str:
    """Mint the next variant of an existing part number.

    Variants share the source's tier+sequence base; the next code is
    max(existing)+1 across ALL rows including soft-deleted ones — variant
    codes are never reused. The tier sequence counter is not touched:
    a variant is a sibling, not a new sequence.
    """
    from opal.config import get_active_project

    project = get_active_project()
    if project is None or not format_has_variant(project):
        raise PartNumberError("Part numbering format has no {variant} placeholder")

    regex = part_number_regex(project, tier_level)
    match = regex.match(source_pn)
    if not match:
        example = _format_part_number(project, tier_level, 1)
        raise PartNumberError(
            f"'{source_pn}' does not match the tier-{tier_level} part number format "
            f"(e.g. {example}), so its variant family cannot be derived"
        )
    sequence = int(match.group("sequence"))

    # Full-column scan + regex match: correct for arbitrary token order and
    # fine at single-instance SQLite scale.
    max_variant = 0
    for (pn,) in db.query(Part.internal_pn).filter(Part.internal_pn.isnot(None)).all():
        m = regex.match(pn)
        if m and int(m.group("sequence")) == sequence:
            max_variant = max(max_variant, int(m.group("variant")))
    return project.generate_part_number(tier_level, sequence, max_variant + 1)


def peek_next_part_number(db: Session, tier_level: int) -> tuple[str, int]:
    """Preview the next part number for a tier without consuming it."""
    from opal.config import get_active_project

    project = get_active_project()
    seq = (
        db.query(DesignatorSequence)
        .filter(DesignatorSequence.designator_type == _sequence_key(tier_level))
        .first()
    )
    candidate = (seq.last_value if seq else 0) + 1
    while pn_exists(db, _format_part_number(project, tier_level, candidate)):
        candidate += 1
    return _format_part_number(project, tier_level, candidate), candidate


def register_part_number(db: Session, tier_level: int, pn: str) -> int:
    """Validate a manual part-number override and advance the tier counter.

    Advancing to max(counter, sequence) keeps future auto-numbers from ever
    colliding with (or reissuing) the overridden number.
    """
    from opal.config import get_active_project

    sequence = validate_part_number(get_active_project(), tier_level, pn)
    seq = _get_or_create_sequence(db, tier_level)
    seq.last_value = max(seq.last_value, sequence)
    db.flush()
    return sequence
