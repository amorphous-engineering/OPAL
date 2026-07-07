"""Welcome / onboarding API routes."""

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from opal.api.deps import DbSession, RequiredUser

router = APIRouter(prefix="/welcome", tags=["welcome"])


class WelcomeResponse(BaseModel):
    ok: bool = True


@router.post("/complete", response_model=WelcomeResponse)
def complete_onboarding(
    db: DbSession,
    user: RequiredUser,
) -> WelcomeResponse:
    """Mark the current user's onboarding as complete."""
    user.needs_onboarding = False
    db.commit()
    return WelcomeResponse()


@router.post("/load-demo")
def load_demo_data(
    request: Request,
    db: DbSession,
    user: RequiredUser,
) -> JSONResponse:
    """Enter the demo: a separate throwaway database seeded with the Mojave
    Sphinx dataset. The real database is untouched; exiting deletes the demo
    file. Admin only.
    """
    if not user.is_admin:
        raise HTTPException(status_code=403, detail="Admin access required")

    user.needs_onboarding = False
    db.commit()

    from opal.api.app import start_onshape_polling
    from opal.api.routes.auth import set_session_cookie
    from opal.core import lifecycle
    from opal.core.auth import create_session
    from opal.db.base import SessionLocal
    from opal.db.models.user import User

    demo_user_id = lifecycle.enter_demo(user)
    start_onshape_polling(request.app)

    response = JSONResponse({"ok": True})
    if demo_user_id is not None:
        # The session table lives per-database: mint a fresh session in the
        # demo database so the operator stays logged in across the switch.
        with SessionLocal() as demo_db:
            demo_user = demo_db.query(User).filter(User.id == demo_user_id).first()
            if demo_user:
                token = create_session(
                    demo_db,
                    demo_user,
                    auth_method="demo",
                    user_agent=request.headers.get("user-agent"),
                    ip_address=request.client.host if request.client else None,
                )
                demo_db.commit()
                set_session_cookie(response, request, token)
    return response
