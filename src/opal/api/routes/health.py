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
    )
