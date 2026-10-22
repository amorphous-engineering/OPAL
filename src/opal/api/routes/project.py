"""Project configuration API routes.

One instance = one project: configuration lives in the database
(app_setting key 'project_config'), not in a yaml file. The wizard
configures THIS instance; it never creates directories or switches
databases.
"""

from typing import Any, Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field, field_validator, model_validator

from opal.api.deps import DbSession, RequiredAdmin
from opal.config import get_active_project, load_project_from_db, save_project_to_db
from opal.project import (
    PartNumberingConfig,
    ProjectConfig,
    TierConfig,
)

router = APIRouter(prefix="/project", tags=["project"])


class TierInput(BaseModel):
    """Tier configuration input.

    The semantic fields are optional: None means "not specified", which on
    update keeps the stored value for that level and on create derives the
    legacy level-based defaults (see TierConfig)."""

    level: int
    name: str
    code: str
    description: str = ""
    default_tracking: Literal["serialized", "bulk"] | None = None
    require_lot: bool | None = None
    auto_serial: bool | None = None

    @field_validator("name", "code")
    @classmethod
    def _not_blank(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("must not be blank")
        return value

    @field_validator("code")
    @classmethod
    def _no_spaces(cls, value: str) -> str:
        if any(ch.isspace() for ch in value):
            raise ValueError("must not contain spaces")
        return value


#: Placeholders a part number format may use (see ProjectConfig.generate_part_number).
PART_NUMBER_VARIABLES = ("prefix", "sep", "tier_code", "tier_name", "tier_level", "sequence")


class PartNumberingInput(BaseModel):
    """Part numbering configuration input."""

    prefix: str = ""
    separator: str = "-"
    sequence_digits: int = Field(default=4, ge=1, le=10)
    format: str = "{prefix}{sep}{tier_code}{sep}{sequence}"

    @field_validator("format")
    @classmethod
    def _format_is_renderable(cls, value: str) -> str:
        """A format that cannot render would break every later part creation."""
        sample = dict.fromkeys(PART_NUMBER_VARIABLES, "x")
        try:
            rendered = value.format(**sample)
        except (KeyError, IndexError, ValueError) as err:
            allowed = ", ".join("{" + v + "}" for v in PART_NUMBER_VARIABLES)
            raise ValueError(f"unusable format ({err!r}); the variables are {allowed}") from err
        if "{sequence" not in value:
            raise ValueError("the format must contain {sequence}, or part numbers repeat")
        if not rendered.strip():
            raise ValueError("the format renders empty")
        return value


class RequirementInput(BaseModel):
    """Requirement configuration input (legacy yaml catalog entries)."""

    id: str
    title: str
    description: str = ""
    category: str = ""


class ProjectConfigCreate(BaseModel):
    """Request model for configuring this instance's project."""

    name: str
    description: str = ""
    tiers: list[TierInput]
    part_numbering: PartNumberingInput
    categories: list[str] = []
    #: None keeps the stored custom fields on update.
    custom_fields: dict[str, Any] | None = None

    @field_validator("name")
    @classmethod
    def _name_required(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("must not be blank")
        return value

    @field_validator("categories")
    @classmethod
    def _clean_categories(cls, value: list[str]) -> list[str]:
        seen: list[str] = []
        for item in value:
            item = item.strip()
            if item and item not in seen:
                seen.append(item)
        return seen

    @model_validator(mode="after")
    def _tiers_are_coherent(self) -> "ProjectConfigCreate":
        if not self.tiers:
            raise ValueError("at least one tier is required")
        levels = [t.level for t in self.tiers]
        if len(set(levels)) != len(levels):
            raise ValueError("tier levels must be unique")
        codes = [t.code for t in self.tiers]
        if len(set(codes)) != len(codes):
            raise ValueError("tier codes must be unique")
        return self


class ProjectConfigUpdate(ProjectConfigCreate):
    """Request model for updating project configuration."""


class ProjectConfigResponse(BaseModel):
    """Response model for project configuration."""

    name: str
    description: str
    project_dir: str | None
    tiers: list[TierInput]
    part_numbering: PartNumberingInput
    categories: list[str]
    requirements: list[RequirementInput]
    custom_fields: dict[str, Any]

    @classmethod
    def from_config(cls, config: ProjectConfig) -> "ProjectConfigResponse":
        """Create response from ProjectConfig."""
        return cls(
            name=config.name,
            description=config.description,
            project_dir=str(config.project_dir) if config.project_dir else None,
            tiers=[
                TierInput(
                    level=t.level,
                    name=t.name,
                    code=t.code,
                    description=t.description,
                    default_tracking=t.default_tracking,
                    require_lot=t.require_lot,
                    auto_serial=t.auto_serial,
                )
                for t in config.tiers
            ],
            part_numbering=PartNumberingInput(
                prefix=config.part_numbering.prefix,
                separator=config.part_numbering.separator,
                sequence_digits=config.part_numbering.sequence_digits,
                format=config.part_numbering.format,
            ),
            categories=config.categories,
            custom_fields=config.custom_fields,
            requirements=[
                RequirementInput(
                    id=r.id,
                    title=r.title,
                    description=r.description,
                    category=r.category,
                )
                for r in config.requirements
            ],
        )


def _tiers_from_input(
    tiers: list[TierInput], existing: list[TierConfig] | None = None
) -> list[TierConfig]:
    """Build TierConfigs, resolving unspecified semantic fields.

    A None semantic field falls back to the stored tier of the same level
    (an edit that doesn't mention them must not reset them), then to the
    legacy level-based derivation inside TierConfig.
    """
    current = {t.level: t for t in existing or []}
    result = []
    for t in tiers:
        data = t.model_dump(exclude_none=True)
        prev = current.get(t.level)
        if prev is not None:
            data.setdefault("default_tracking", prev.default_tracking)
            data.setdefault("require_lot", prev.require_lot)
            data.setdefault("auto_serial", prev.auto_serial)
        result.append(TierConfig(**data))
    return result


def _numbering_from_input(pn: PartNumberingInput) -> PartNumberingConfig:
    return PartNumberingConfig(
        prefix=pn.prefix,
        separator=pn.separator,
        sequence_digits=pn.sequence_digits,
        format=pn.format,
    )


@router.get("/config")
def get_project_config() -> ProjectConfigResponse:
    """Get current project configuration."""
    project = get_active_project()
    if not project:
        raise HTTPException(status_code=404, detail="No active project configuration")
    return ProjectConfigResponse.from_config(project)


@router.post("/config")
def create_project(
    data: ProjectConfigCreate, db: DbSession, admin: RequiredAdmin
) -> ProjectConfigResponse:
    """Configure this instance's project (stored in the database)."""
    if load_project_from_db(db) is not None:
        raise HTTPException(
            status_code=400,
            detail="This instance already has a project configuration — edit it instead",
        )

    config = ProjectConfig(
        name=data.name,
        description=data.description,
        tiers=_tiers_from_input(data.tiers),
        part_numbering=_numbering_from_input(data.part_numbering),
        categories=data.categories,
        custom_fields=data.custom_fields or {},
    )

    save_project_to_db(db, config, user_id=admin.id)
    db.commit()

    return ProjectConfigResponse.from_config(config)


@router.put("/config")
def update_project_config(
    data: ProjectConfigUpdate, db: DbSession, admin: RequiredAdmin
) -> ProjectConfigResponse:
    """Update existing project configuration."""
    project = get_active_project()
    if not project:
        raise HTTPException(status_code=404, detail="No active project configuration")

    # A tier that parts still use cannot go: they would be left with a level
    # the project no longer defines.
    from opal.db.models import Part

    dropped = {t.level for t in project.tiers} - {t.level for t in data.tiers}
    if dropped:
        in_use = (
            db.query(Part.tier)
            .filter(Part.tier.in_(dropped), Part.deleted_at.is_(None))
            .distinct()
            .all()
        )
        if in_use:
            names = ", ".join(
                f"{project.get_tier(level).name} (level {level})"  # type: ignore[union-attr]
                for (level,) in sorted(in_use)
                if project.get_tier(level)
            )
            raise HTTPException(
                status_code=409,
                detail=f"Parts still use tier {names}; reassign them before removing it",
            )

    project.name = data.name
    project.description = data.description
    project.tiers = _tiers_from_input(data.tiers, existing=project.tiers)
    project.part_numbering = _numbering_from_input(data.part_numbering)
    project.categories = data.categories
    if data.custom_fields is not None:
        project.custom_fields = data.custom_fields

    save_project_to_db(db, project, user_id=admin.id)
    db.commit()

    return ProjectConfigResponse.from_config(project)


class PartNumberPreview(BaseModel):
    """Part number preview request."""

    tier_level: int
    sequence: int = 1


class PartNumberPreviewResponse(BaseModel):
    """Part number preview response."""

    part_number: str
    tier_name: str


@router.post("/preview-part-number")
def preview_part_number(data: PartNumberPreview) -> PartNumberPreviewResponse:
    """Preview what a part number would look like."""
    project = get_active_project()
    if not project:
        raise HTTPException(status_code=404, detail="No active project configuration")

    tier = project.get_tier(data.tier_level)
    if not tier:
        raise HTTPException(status_code=400, detail=f"Unknown tier level: {data.tier_level}")

    part_number = project.generate_part_number(data.tier_level, data.sequence)

    return PartNumberPreviewResponse(part_number=part_number, tier_name=tier.name)


class RequirementsImportResult(BaseModel):
    created: list[str]
    skipped: list[str]
    relinked: int


@router.post("/requirements/import", response_model=RequirementsImportResult)
def import_requirement_catalog(db: DbSession, admin: RequiredAdmin) -> RequirementsImportResult:
    """Import the deprecated yaml requirement catalog as first-class requirements.

    Idempotent: requirement numbers that already exist are skipped.
    """
    from opal.se.import_requirements import import_requirements_from_config

    project = get_active_project()
    if not project or not project.requirements:
        raise HTTPException(status_code=404, detail="The project has no requirement catalog")
    result = import_requirements_from_config(db, project, user_id=admin.id)
    db.commit()
    return RequirementsImportResult(
        created=result.created, skipped=result.skipped, relinked=result.relinked
    )
