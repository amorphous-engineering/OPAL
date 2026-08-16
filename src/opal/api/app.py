"""FastAPI application factory."""

import asyncio
import contextlib
import logging
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from opal.api.middleware import setup_middleware
from opal.api.routes import router as api_router
from opal.config import get_settings
from opal.core.part_lifecycle import DraftPartsBlocked
from opal.web.routes import router as web_router
from opal.web.templating import Jinja2Templates

# Template directory
TEMPLATES_DIR = Path(__file__).parent.parent / "web" / "templates"
STATIC_DIR = Path(__file__).parent.parent / "web" / "static"

# Jinja2 templates
templates = Jinja2Templates(directory=str(TEMPLATES_DIR))


def start_onshape_polling(app: FastAPI) -> None:
    """(Re)start the Onshape polling task for the currently active settings.

    Cancels any existing task first — called at startup and again after
    database switches (demo enter/exit, factory reset).
    """
    from opal.config import get_active_settings

    existing: asyncio.Task | None = getattr(app.state, "onshape_polling_task", None)
    if existing and not existing.done():
        existing.cancel()
    app.state.onshape_polling_task = None

    settings = get_active_settings()
    if settings.onshape_enabled and settings.onshape_poll_interval_minutes > 0:
        try:
            from opal.integrations.onshape.polling import onshape_polling_loop

            app.state.onshape_polling_task = asyncio.create_task(
                onshape_polling_loop(settings.onshape_poll_interval_minutes)
            )
            logging.getLogger(__name__).info(
                "Onshape polling enabled (every %d min)",
                settings.onshape_poll_interval_minutes,
            )
        except Exception:
            logging.getLogger(__name__).warning("Failed to start Onshape polling", exc_info=True)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    """Application lifespan handler."""
    from opal.config import apply_db_overlay, bootstrap_project_config, get_active_settings
    from opal.core import lifecycle
    from opal.db.base import SessionLocal

    settings = get_active_settings()
    settings.ensure_directories()

    # The server always boots against the real database; demo switches are
    # runtime-only. Capture the boot URL so lifecycle knows the way home.
    lifecycle.set_real_database_url(settings.database_url)

    # Overlay DB-stored AppSetting values (Onshape credentials edited via
    # /settings/onshape) on top of env-loaded settings before we read any
    # integration config.
    with contextlib.suppress(Exception), SessionLocal() as _db:
        apply_db_overlay(_db)

    # Establish project config: DB blob wins; a cwd opal.project.yaml is
    # imported once. Failures are logged, not swallowed silently.
    try:
        with SessionLocal() as _db:
            bootstrap_project_config(_db)
    except Exception:
        logging.getLogger(__name__).warning("Project config bootstrap failed", exc_info=True)

    start_onshape_polling(app)

    yield

    # Cancel polling on shutdown
    polling_task: asyncio.Task | None = getattr(app.state, "onshape_polling_task", None)
    if polling_task and not polling_task.done():
        polling_task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await polling_task


def create_app() -> FastAPI:
    """Create and configure the FastAPI application."""
    import logging

    settings = get_settings()
    logging.getLogger(__name__).info(
        "OPAL sign-in: password=%s oidc=%s",
        settings.password_login_enabled,
        settings.oidc_issuer if settings.oidc_enabled else "off",
    )

    # The interactive API explorer enumerates every endpoint; on a semi-trusted
    # LAN it is pre-auth reconnaissance. Serve it only in debug.
    app = FastAPI(
        title="OPAL",
        description="Operations, Procedures, Assets, Logistics - ERP for small teams",
        version="0.1.0",
        lifespan=lifespan,
        debug=settings.debug,
        docs_url="/docs" if settings.debug else None,
        redoc_url="/redoc" if settings.debug else None,
        openapi_url="/openapi.json" if settings.debug else None,
    )

    # Setup middleware
    setup_middleware(app)

    # Draft parts block physical/financial commitments everywhere with one
    # structured 409 (error=draft_parts_blocked, draft_parts list, remedy)
    @app.exception_handler(DraftPartsBlocked)
    async def draft_parts_blocked_handler(request: Request, exc: DraftPartsBlocked) -> JSONResponse:
        return JSONResponse(status_code=409, content={"detail": exc.payload()})

    # Mount static files
    if STATIC_DIR.exists():
        app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")

    # Include API routes
    app.include_router(api_router, prefix="/api")

    # Include web routes
    app.include_router(web_router)

    return app


# Create application instance
app = create_app()
