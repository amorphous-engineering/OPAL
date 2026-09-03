"""Proxy-aware request helpers.

When ``OPAL_TRUST_PROXY`` is set OPAL sits behind a reverse proxy that
terminates TLS and rewrites the client-facing headers. Only then do we honor
``X-Forwarded-Proto`` / ``X-Forwarded-For`` — trusting them unconditionally
would let any client forge its scheme or source IP.
"""

from fastapi import Request, Response

from opal.config import get_active_settings


def request_is_secure(request: Request) -> bool:
    """True if the browser reached OPAL over HTTPS (directly or via a trusted proxy)."""
    if request.url.scheme == "https":
        return True
    if get_active_settings().trust_proxy:
        # Leftmost value is the scheme the browser used to reach the proxy.
        proto = request.headers.get("x-forwarded-proto", "").split(",")[0].strip().lower()
        return proto == "https"
    return False


def client_ip(request: Request) -> str | None:
    """The originating client IP, seeing through a trusted proxy when configured."""
    if get_active_settings().trust_proxy:
        # nginx et al. prepend the client IP as the leftmost X-Forwarded-For entry.
        forwarded = request.headers.get("x-forwarded-for", "").split(",")[0].strip()
        if forwarded:
            return forwarded
    return request.client.host if request.client else None


def set_session_cookie(response: Response, request: Request, token: str) -> None:
    """Attach the session cookie with the right security attributes.

    One home for the API login, the web login, setup and the demo switch."""
    from opal.core.auth import SESSION_COOKIE, SESSION_LIFETIME

    response.set_cookie(
        SESSION_COOKIE,
        token,
        max_age=int(SESSION_LIFETIME.total_seconds()),
        httponly=True,
        samesite="lax",
        secure=request_is_secure(request),
    )


def clear_session_cookie(response: Response) -> None:
    from opal.core.auth import SESSION_COOKIE

    response.delete_cookie(SESSION_COOKIE)
