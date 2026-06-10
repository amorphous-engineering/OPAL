"""Project configuration API routes.

One instance = one project: configuration lives in the database
(app_setting key 'project_config'), not in a yaml file. The wizard
configures THIS instance; it never creates directories or switches
databases.
"""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from opal.api.deps import DbSession, RequiredAdmin
from opal.config import get_active_project, load_project_from_db, save_project_to_db
from opal.project import (
    PartNumberingConfig,
    ProjectConfig,
    TierConfig,
)

router = APIRouter(prefix="/project", tags=["project"])


class TierInput(BaseModel):
    """Tier configuration input."""

    level: int
    name: str
    code: str
    description: str = ""


class PartNumberingInput(BaseModel):
    """Part numbering configuration input."""

    prefix: str = ""
    separator: str = "-"
    sequence_digits: int = 4
    format: str = "{prefix}{sep}{tier_code}{sep}{sequence}"


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


class ProjectConfigUpdate(BaseModel):
    """Request model for updating project configuration."""

    name: str
    description: str = ""
    tiers: list[TierInput]
    part_numbering: PartNumberingInput
    categories: list[str] = []


class ProjectConfigResponse(BaseModel):
    """Response model for project configuration."""

    name: str
    description: str
    project_dir: str | None
    tiers: list[TierInput]
    part_numbering: PartNumberingInput
    categories: list[str]
    requirements: list[RequirementInput]

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


def _tiers_from_input(tiers: list[TierInput]) -> list[TierConfig]:
    return [
        TierConfig(level=t.level, name=t.name, code=t.code, description=t.description)
        for t in tiers
    ]


def _numbering_from_input(pn: PartNumberingInput) -> PartNumberingConfig:
    return PartNumberingConfig(
        prefix=pn.prefix,
        separator=pn.separator,
        sequence_digits=pn.sequence_digits,
        format=pn.format,
    )


@router.get("/config")
async def get_project_config() -> ProjectConfigResponse:
    """Get current project configuration."""
    project = get_active_project()
    if not project:
        raise HTTPException(status_code=404, detail="No active project configuration")
    return ProjectConfigResponse.from_config(project)


@router.post("/config")
async def create_project(
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
    )

    save_project_to_db(db, config)
    db.commit()

    return ProjectConfigResponse.from_config(config)


@router.put("/config")
async def update_project_config(
    data: ProjectConfigUpdate, db: DbSession, admin: RequiredAdmin
) -> ProjectConfigResponse:
    """Update existing project configuration."""
    project = get_active_project()
    if not project:
        raise HTTPException(status_code=404, detail="No active project configuration")

    project.name = data.name
    project.description = data.description
    project.tiers = _tiers_from_input(data.tiers)
    project.part_numbering = _numbering_from_input(data.part_numbering)
    project.categories = data.categories

    save_project_to_db(db, project)
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
async def preview_part_number(data: PartNumberPreview) -> PartNumberPreviewResponse:
    """Preview what a part number would look like."""
    project = get_active_project()
    if not project:
        raise HTTPException(status_code=404, detail="No active project configuration")

    tier = project.get_tier(data.tier_level)
    if not tier:
        raise HTTPException(status_code=400, detail=f"Unknown tier level: {data.tier_level}")

    part_number = project.generate_part_number(data.tier_level, data.sequence)

    return PartNumberPreviewResponse(part_number=part_number, tier_name=tier.name)
