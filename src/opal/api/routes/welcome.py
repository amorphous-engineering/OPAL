"""Welcome / onboarding API routes."""

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from opal.api.deps import DbSession, RequiredUser

router = APIRouter(prefix="/welcome", tags=["welcome"])


class WelcomeResponse(BaseModel):
    ok: bool = True


@router.post("/complete", response_model=WelcomeResponse)
async def complete_onboarding(
    db: DbSession,
    user: RequiredUser,
) -> WelcomeResponse:
    """Mark the current user's onboarding as complete."""
    user.needs_onboarding = False
    db.commit()
    return WelcomeResponse()


@router.post("/load-demo")
async def load_demo_data(
    request: Request,
    db: DbSession,
    user: RequiredUser,
) -> JSONResponse:
    """Enter the demo: a separate throwaway database seeded with Project
    Kestrel. The real database is untouched; exiting deletes the demo file.
    Admin only.
    """
    if not user.is_admin:
        raise HTTPException(status_code=403, detail="Admin access required")

    user.needs_onboarding = False
    db.commit()

    from opal.api.app import start_onshape_polling
    from opal.core import lifecycle
    from opal.db.base import SessionLocal
    from opal.db.models.user import User

    demo_user_id = lifecycle.enter_demo(user)
    start_onshape_polling(request.app)

    response = JSONResponse({"ok": True})
    if demo_user_id is not None:
        with SessionLocal() as demo_db:
            demo_user = demo_db.query(User).filter(User.id == demo_user_id).first()
            if demo_user:
                max_age = 365 * 24 * 3600
                response.set_cookie("opal_user_id", str(demo_user.id), max_age=max_age)
                response.set_cookie("opal_user_name", demo_user.name, max_age=max_age)
                response.set_cookie("opal_user_email", demo_user.email or "", max_age=max_age)
                response.set_cookie(
                    "opal_user_is_admin", "1" if demo_user.is_admin else "0", max_age=max_age
                )
    return response
