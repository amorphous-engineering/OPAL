"""Health check endpoints."""

from fastapi import APIRouter
from pydantic import BaseModel

from opal.version import get_version_info

router = APIRouter()


class HealthResponse(BaseModel):
    """Health check response, including the identity of the running build."""

    status: str
    version: str
    branch: str | None = None
    commit: str | None = None
    dirty: bool = False
    # Header display: "v1.3.2" or "v1.3.2+devel.6befb6f"; dev builds render
    # distinctly so a checkout is never mistaken for a release.
    display: str
    is_dev: bool = False
    tooltip: str


@router.get("/health", response_model=HealthResponse)
def health_check() -> HealthResponse:
    """Check API health status."""
    info = get_version_info()
    return HealthResponse(
        status="healthy",
        version=info.full,
        branch=info.branch,
        commit=info.commit,
        dirty=info.dirty,
        display=info.display,
        is_dev=info.is_dev,
        tooltip=info.tooltip,
    )
