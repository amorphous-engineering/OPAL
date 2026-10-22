"""FastAPI middleware configuration."""

import logging
from urllib.parse import urlparse

from fastapi import FastAPI, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import PlainTextResponse

from opal.config import get_active_settings

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


def setup_middleware(app: FastAPI) -> None:
    """Configure all middleware for the application."""
    settings = get_active_settings()
    logger.info(
        "Sign-in methods: password=%s passkeys=%s oidc=%s",
        settings.password_login_enabled,
        settings.passkeys_enabled,
        f"{settings.oidc_issuer}" if settings.oidc_enabled else False,
    )

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
