"""API routes.

Everything except health, the auth endpoints and the Onshape webhook sits
behind require_user: requests must present a session cookie or a bearer API
token or they receive 401. Do not add business routers outside `protected`.
"""

from fastapi import APIRouter, Depends

from opal.api.deps import require_user
from opal.api.routes import (
    attachments,
    auth,
    bom,
    datasets,
    events,
    execution,
    health,
    inventory,
    issues,
    notifications,
    onshape,
    parts,
    procedures,
    project,
    purchases,
    reports,
    requirements,
    risks,
    search,
    suppliers,
    undo,
    users,
    welcome,
    workcenters,
)

router = APIRouter()

# Unauthenticated surface: health checks, login/passkey handshake, and the
# HMAC-verified Onshape webhook.
router.include_router(health.router, tags=["health"])
router.include_router(auth.public_router)
router.include_router(onshape.webhook_router)

# Everything else requires an authenticated user.
protected = APIRouter(dependencies=[Depends(require_user)])
protected.include_router(auth.router)  # tokens, sessions, password, passkey mgmt
protected.include_router(users.router, prefix="/users", tags=["users"])
protected.include_router(parts.router, prefix="/parts", tags=["parts"])
protected.include_router(inventory.router, prefix="/inventory", tags=["inventory"])
protected.include_router(purchases.router, prefix="/purchases", tags=["purchases"])
protected.include_router(procedures.router)  # Has its own /procedures prefix
protected.include_router(execution.router)  # Has its own /procedure-instances prefix
protected.include_router(issues.router)  # Has its own /issues prefix
protected.include_router(risks.router)  # Has its own /risks prefix
protected.include_router(datasets.router)  # Has its own /datasets prefix
protected.include_router(notifications.router)  # Has its own /notifications prefix
protected.include_router(workcenters.router)  # Has its own /workcenters prefix
protected.include_router(suppliers.router)  # Has its own /suppliers prefix
protected.include_router(events.router)  # Has its own /events prefix
protected.include_router(reports.router)  # Has its own /reports prefix
protected.include_router(requirements.router, prefix="/requirements", tags=["requirements"])
protected.include_router(bom.router, prefix="/bom", tags=["bom"])
protected.include_router(project.router)  # Has its own /project prefix
protected.include_router(search.router)  # Has its own /search prefix
protected.include_router(attachments.router)  # Has its own /attachments prefix
protected.include_router(undo.router)  # Has its own /undo prefix
protected.include_router(
    onshape.router
)  # Has its own /onshape prefix; endpoints check onshape_enabled
protected.include_router(welcome.router)  # Has its own /welcome prefix

router.include_router(protected)
