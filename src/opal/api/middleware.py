"""FastAPI middleware configuration."""

import hmac
import logging
from urllib.parse import quote, urlparse

from fastapi import FastAPI, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import PlainTextResponse, RedirectResponse

from opal.api.net import client_ip
from opal.config import get_active_settings
from opal.core.auth import SESSION_COOKIE, create_session, resolve_session

logger = logging.getLogger(__name__)

UNSAFE_METHODS = ("POST", "PUT", "PATCH", "DELETE")


class OriginCheckMiddleware(BaseHTTPMiddleware):
    """CSRF protection: state-changing browser requests must be same-origin.

    Browsers attach an Origin header to unsafe cross-site requests; we reject
    any whose host does not match the request host. Requests without an
    Origin header (curl, the TUI, scripts) pass through — they cannot carry a
    victim's cookie, and bearer-token requests are immune to CSRF by nature.
    """

    async def dispatch(self, request: Request, call_next) -> Response:
        if request.method in UNSAFE_METHODS:
            host = request.headers.get("host", "")
            origin = request.headers.get("origin")
            if origin is not None:
                # An explicit Origin must match the host. `null` (sandboxed
                # iframe, file://, opaque redirect) is never a legitimate
                # same-origin app request here — reject rather than allow it.
                origin_host = "" if origin == "null" else urlparse(origin).netloc
                if origin == "null" or (origin_host and origin_host != host):
                    return self._reject(request, f"origin {origin}")
            else:
                # No Origin (curl, the TUI, bearer clients) can't carry a
                # victim's cookie, so it passes — but if a browser sent a
                # Referer, cross-check it as a fallback.
                referer = request.headers.get("referer")
                if referer:
                    ref_host = urlparse(referer).netloc
                    if ref_host and ref_host != host:
                        return self._reject(request, f"referer {referer}")
        return await call_next(request)

    @staticmethod
    def _reject(request: Request, source: str) -> Response:
        logger.warning(
            "Rejected cross-origin %s %s from %s",
            request.method,
            request.scope.get("path", request.url.path),
            source,
        )
        return PlainTextResponse("Cross-origin request rejected", status_code=403)


class UserSelectionMiddleware(BaseHTTPMiddleware):
    """Mode-aware web auth middleware.

    local mode: redirect to /login unless a valid session cookie is present.
    exe mode: trust X-ExeDev-UserID / X-ExeDev-Email headers from the proxy,
              auto-provision users and mint real sessions.

    The JSON API is exempt here because it enforces auth itself (401 via
    require_user on every business router).
    """

    LOCAL_EXEMPT = ("/setup", "/login", "/logout", "/api/", "/static/", "/docs", "/favicon.ico")
    EXE_EXEMPT = (
        "/__exe.dev/",
        "/setup",
        "/login",
        "/logout",
        "/setup-profile",
        "/api/",
        "/static/",
        "/docs",
        "/favicon.ico",
    )

    async def dispatch(self, request: Request, call_next) -> Response:
        settings = get_active_settings()
        if settings.auth_mode == "exe":
            return await self._dispatch_exe(request, call_next)
        return await self._dispatch_local(request, call_next)

    @staticmethod
    def _session_user_id(request: Request) -> int | None:
        """Resolve the session cookie to an active user id, if any.

        Covers stale credentials by construction: a session minted before a
        database switch or factory reset simply does not exist in the new
        database and resolves to None (logged out). A pre-init or mid-switch
        database fails closed the same way rather than raising.
        """
        from opal.db.session import get_session

        token = request.cookies.get(SESSION_COOKIE)
        if not token:
            return None
        try:
            with get_session() as db:
                user = resolve_session(db, token)
                return user.id if user else None
        except Exception:
            return None

    async def _dispatch_local(self, request: Request, call_next) -> Response:
        """Local mode: require a valid session for web pages."""
        # Gate on the raw routed ASGI path, not request.url (which is
        # reconstructed and can be desynced from the routed path via a crafted
        # Host header), so an exempt-prefix match cannot skip the auth check.
        path = request.scope.get("path", request.url.path)
        if any(path.startswith(p) for p in self.LOCAL_EXEMPT):
            return await call_next(request)

        # A session surviving a database switch/reset resolves to None in
        # the new database — treated as logged out, not as valid.
        if self._session_user_id(request) is None:
            response = RedirectResponse(url="/login", status_code=302)
            response.delete_cookie(SESSION_COOKIE)
            return response

        return await call_next(request)

    async def _dispatch_exe(self, request: Request, call_next) -> Response:
        """Exe mode: trust proxy headers, auto-provision users, mint sessions."""
        path = request.scope.get("path", request.url.path)
        if any(path.startswith(p) for p in self.EXE_EXEMPT):
            return await call_next(request)

        # The identity headers below are only trustworthy if the request
        # actually transited the trusted proxy. Require a shared secret to
        # prove that; without it, any LAN client could spoof X-ExeDev-* and
        # become any user (or self-provision admin). Fail closed when unset.
        expected_secret = get_active_settings().exe_proxy_secret
        presented_secret = request.headers.get("X-ExeDev-Proxy-Secret", "")
        if not expected_secret or not hmac.compare_digest(presented_secret, expected_secret):
            logger.warning("Rejected exe request: missing or invalid proxy secret")
            return PlainTextResponse("Proxy authentication required", status_code=403)

        exe_user_id = request.headers.get("X-ExeDev-UserID")
        exe_email = request.headers.get("X-ExeDev-Email")

        if not exe_user_id or not exe_email:
            # No proxy headers — redirect to exe.dev login
            redirect_path = quote(str(request.url.path), safe="")
            return RedirectResponse(
                url=f"/__exe.dev/login?redirect={redirect_path}",
                status_code=302,
            )

        # Look up or create user
        user = await self._get_or_create_exe_user(exe_user_id, exe_email)
        if not user:
            return RedirectResponse(url="/__exe.dev/login", status_code=302)

        # Reuse an existing valid session; only mint one when absent so we do
        # not create a session row per request
        session_user_id = self._session_user_id(request)
        new_token: str | None = None
        if session_user_id != user["id"]:
            from opal.db.session import get_session as db_session

            with db_session() as db:
                from opal.db.models.user import User

                db_user = db.query(User).filter(User.id == user["id"]).first()
                if db_user is not None:
                    new_token = create_session(
                        db,
                        db_user,
                        auth_method="exe",
                        user_agent=request.headers.get("user-agent"),
                        ip_address=client_ip(request),
                    )

        if user["needs_profile_setup"]:
            response: Response = RedirectResponse(url="/setup-profile", status_code=302)
        else:
            response = await call_next(request)

        if new_token is not None:
            from opal.api.routes.auth import set_session_cookie

            set_session_cookie(response, request, new_token)
        return response

    async def _get_or_create_exe_user(self, exe_user_id: str, exe_email: str) -> dict | None:
        """Look up user by exe_user_id, auto-create if not found."""
        from opal.core.auth import generate_unique_username
        from opal.db.models.user import User
        from opal.db.session import get_session

        with get_session() as db:
            user = (
                db.query(User)
                .filter(
                    User.exe_user_id == exe_user_id,
                    User.is_active == True,  # noqa: E712
                )
                .first()
            )

            if user:
                # Update email if changed
                if user.email != exe_email:
                    user.email = exe_email
                    db.flush()
                return {
                    "id": user.id,
                    "name": user.name,
                    "email": user.email,
                    "is_admin": user.is_admin,
                    "needs_profile_setup": user.needs_profile_setup,
                }

            # Auto-create: derive placeholder name from email local part
            local_part = exe_email.split("@")[0] if "@" in exe_email else exe_email
            name = local_part.replace(".", " ").replace("_", " ").replace("-", " ").title()

            # First user ever = admin
            is_first_user = db.query(User).count() == 0

            new_user = User(
                name=name,
                username=generate_unique_username(db, local_part),
                email=exe_email,
                exe_user_id=exe_user_id,
                is_active=True,
                is_admin=is_first_user,
                needs_profile_setup=True,
            )
            db.add(new_user)
            db.flush()
            db.refresh(new_user)
            logger.info(
                "Auto-provisioned exe user: %s (exe_user_id=%s, needs_profile_setup=True)",
                name,
                exe_user_id,
            )

            return {
                "id": new_user.id,
                "name": new_user.name,
                "email": new_user.email,
                "is_admin": new_user.is_admin,
                "needs_profile_setup": True,
            }


def setup_middleware(app: FastAPI) -> None:
    """Configure all middleware for the application."""
    settings = get_active_settings()
    logger.info("Auth mode: %s", settings.auth_mode)

    # CORS: only when extra origins are explicitly configured. The default is
    # same-origin only (no CORS headers at all). A "*" wildcard never gets
    # credentials — wildcard plus cookies would let any website act as a
    # logged-in user.
    origins = settings.cors_origins
    if origins == ["*"]:
        # Wildcard without credentials: other origins may read public
        # endpoints but can never ride a logged-in user's cookie.
        app.add_middleware(
            CORSMiddleware,
            allow_origins=["*"],
            allow_credentials=False,
            allow_methods=["*"],
            allow_headers=["*"],
        )
    elif origins:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=origins,
            allow_credentials=True,
            allow_methods=["*"],
            allow_headers=["*"],
        )

    # CSRF origin check for unsafe methods
    app.add_middleware(OriginCheckMiddleware)

    # User selection middleware (mode-aware: local or exe)
    app.add_middleware(UserSelectionMiddleware)
