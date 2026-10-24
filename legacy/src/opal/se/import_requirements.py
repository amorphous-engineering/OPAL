"""One-shot importer: opal.project.yaml requirement catalog -> Requirement table.

The yaml catalog (ProjectConfig.requirements) is deprecated in favor of
first-class Requirement rows. This importer is idempotent: existing
req_numbers are skipped, and PartRequirement rows are re-linked to the new
FK (requirement_ref_id) wherever their string requirement_id matches.

Imported rows arrive as level-0 drafts with no parent — the yaml catalog is
flat, so flow-down structure is added afterwards by editing the rows.
"""

from dataclasses import dataclass, field

from sqlalchemy.orm import Session

from opal.core.audit import log_create
from opal.db.models.part import PartRequirement
from opal.db.models.requirement import Requirement
from opal.project import ProjectConfig


@dataclass
class ImportResult:
    created: list[str] = field(default_factory=list)
    skipped: list[str] = field(default_factory=list)
    relinked: int = 0

    def summary(self) -> str:
        return (
            f"created {len(self.created)} requirement(s), "
            f"skipped {len(self.skipped)} existing, "
            f"re-linked {self.relinked} part allocation(s)"
        )


def import_requirements_from_config(
    db: Session, config: ProjectConfig, user_id: int | None = None
) -> ImportResult:
    """Import the yaml requirement catalog. Flushes but does not commit."""
    result = ImportResult()

    for cfg in config.requirements:
        existing = (
            db.query(Requirement)
            .filter(Requirement.req_number == cfg.id, Requirement.deleted_at.is_(None))
            .first()
        )
        if existing is not None:
            result.skipped.append(cfg.id)
            requirement = existing
        else:
            requirement = Requirement(
                req_number=cfg.id,
                title=cfg.title,
                statement=cfg.description or cfg.title,
                category=cfg.category or None,
                level=0,
            )
            db.add(requirement)
            db.flush()
            log_create(db, requirement, user_id)
            result.created.append(cfg.id)

        # Re-link part allocations that still reference the yaml string ID.
        links = (
            db.query(PartRequirement)
            .filter(
                PartRequirement.requirement_id == cfg.id,
                PartRequirement.requirement_ref_id.is_(None),
            )
            .all()
        )
        for link in links:
            link.requirement_ref_id = requirement.id
            result.relinked += 1

    db.flush()
    return result
