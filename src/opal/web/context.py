"""Template environment and the base context every web page renders with."""

from pathlib import Path
from typing import Any

from fastapi import Request
from fastapi.responses import RedirectResponse

from opal.api.deps import DbSession
from opal.core.auth import SESSION_COOKIE, resolve_session
from opal.db.models import User
from opal.web.templating import Jinja2Templates

TEMPLATES_DIR = Path(__file__).parent / "templates"
templates = Jinja2Templates(directory=str(TEMPLATES_DIR))

STATIC_DIR = Path(__file__).parent / "static"


def static_url(path: str) -> str:
    """/static URL with an mtime cache-buster.

    Pages stay open for days on shop-floor tablets; without a version
    in the URL a normal reload can keep serving stale CSS/JS forever.
    """
    try:
        version = int((STATIC_DIR / path).stat().st_mtime)
    except OSError:
        return f"/static/{path}"
    return f"/static/{path}?v={version}"


templates.env.globals["static_url"] = static_url


def get_current_user(request: Request, db) -> User | None:
    """Get current user from the session cookie."""
    return resolve_session(db, request.cookies.get(SESSION_COOKIE))


def require_admin_web(request: Request, db) -> RedirectResponse | None:
    """Return redirect if current user is not admin, else None."""
    user = get_current_user(request, db)
    if not user or not user.is_admin:
        return RedirectResponse(url="/", status_code=302)
    return None


def get_base_context(request: Request, db: DbSession, title: str) -> dict[str, Any]:
    """Get base context for all pages."""
    from opal.config import get_active_project, get_active_settings
    from opal.version import get_version_info

    project = get_active_project()
    settings = get_active_settings()

    # Resolve current user from the signed cookie
    is_admin = False
    current_user = get_current_user(request, db)
    if current_user:
        is_admin = current_user.is_admin

    from opal.core import lifecycle

    version_info = get_version_info()

    return {
        "request": request,
        "title": title,
        "project_name": project.name if project else None,
        "opal_version": version_info.full,
        "app_version": version_info.display,
        "version_is_dev": version_info.is_dev,
        "version_tooltip": version_info.tooltip,
        "current_user": current_user,
        "is_admin": is_admin,
        "passkeys_enabled": settings.passkeys_enabled,
        "demo_active": lifecycle.is_demo_active(),
    }
