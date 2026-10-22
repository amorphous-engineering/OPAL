"""Browser-facing routes outside the JSON API: the OIDC redirect handshake and
the single-page web client.

The OIDC endpoints are full-page redirects (the provider sends the browser
back to /oidc/callback), so they cannot live under /api. Failures land on
/login?error=… where the web client renders the message.

Every other non-API GET serves the built SvelteKit client (``index.html``),
which owns routing from there.
"""

import hmac
import logging
import secrets
from pathlib import Path
from urllib.parse import quote

from fastapi import APIRouter, Query, Request
from fastapi.responses import FileResponse, HTMLResponse, RedirectResponse, Response

from opal.api.deps import DbSession
from opal.api.net import client_ip, request_is_secure, set_session_cookie
from opal.core.auth import create_session

logger = logging.getLogger(__name__)

# Built by `pnpm build` in frontend/ (adapter-static, SPA fallback).
CLIENT_DIR = Path(__file__).parent.parent / "web_client"

router = APIRouter()


def _safe_next(value: str) -> str:
    """Confine post-login redirects to this app — never an attacker's host."""
    if not value.startswith("/") or value.startswith("//"):
        return "/"
    return value


def _login_error(message: str) -> RedirectResponse:
    from opal.core import oidc

    logger.warning("OIDC sign-in failed: %s", message)
    response = RedirectResponse(url=f"/login?error={quote(message)}", status_code=302)
    response.delete_cookie(oidc.STATE_COOKIE)
    return response


@router.get("/oidc/login", response_model=None)
def oidc_login(request: Request, next: str = Query("/")) -> RedirectResponse:
    """Begin the authorization-code handshake and redirect to the provider.

    ``state``, ``nonce`` and the PKCE verifier are signed into one short-lived
    cookie, so the handshake needs no server-side storage.
    """
    from opal.core import oidc

    if not oidc.is_enabled():
        return RedirectResponse(url="/login", status_code=302)
    config = oidc.get_config()
    state = secrets.token_urlsafe(24)
    nonce = secrets.token_urlsafe(24)
    verifier, challenge = oidc.make_pkce_pair()
    callback_url = oidc.redirect_uri(str(request.base_url), config)
    try:
        auth_url = oidc.build_authorization_url(config, callback_url, state, nonce, challenge)
    except oidc.OidcError as exc:
        return _login_error(str(exc))
    payload = oidc.sign_state(
        {"state": state, "nonce": nonce, "verifier": verifier, "next": _safe_next(next)}
    )
    response = RedirectResponse(url=auth_url, status_code=302)
    response.set_cookie(
        oidc.STATE_COOKIE,
        payload,
        max_age=600,
        httponly=True,
        # The provider redirects back cross-site; `lax` survives a top-level GET.
        samesite="lax",
        secure=request_is_secure(request),
    )
    return response


@router.get("/oidc/callback", response_model=None)
def oidc_callback(
    request: Request,
    db: DbSession,
    code: str = Query(""),
    state: str = Query(""),
    error: str = Query(""),
    error_description: str = Query(""),
) -> RedirectResponse:
    """Complete the handshake: verify the token, resolve the user, mint a session."""
    from opal.core import oidc

    if not oidc.is_enabled():
        return RedirectResponse(url="/login", status_code=302)
    if error:
        return _login_error(
            f"The identity provider refused the sign-in: {error_description or error}"
        )
    if not code or not state:
        return _login_error("The identity provider returned an incomplete response.")
    stored = oidc.verify_state(request.cookies.get(oidc.STATE_COOKIE))
    if stored is None:
        return _login_error("The sign-in request expired. Please try again.")
    # Constant-time compare: state is the CSRF defence for the whole flow.
    if not hmac.compare_digest(str(stored.get("state", "")), state):
        return _login_error("The sign-in request did not match. Please try again.")

    config = oidc.get_config()
    callback_url = oidc.redirect_uri(str(request.base_url), config)
    try:
        tokens = oidc.exchange_code(config, code, callback_url, str(stored["verifier"]))
        claims = oidc.verify_id_token(config, tokens["id_token"], str(stored["nonce"]))
        # Groups often live only in userinfo; merge it over the id_token claims.
        userinfo = oidc.fetch_userinfo(config, tokens.get("access_token", ""))
        if userinfo and str(userinfo.get("sub", claims["sub"])) == str(claims["sub"]):
            claims = {**claims, **userinfo}
        user = oidc.resolve_identity(db, config, claims)
    except oidc.OidcError as exc:
        db.rollback()
        return _login_error(str(exc))

    token = create_session(
        db,
        user,
        auth_method="oidc",
        user_agent=request.headers.get("user-agent"),
        ip_address=client_ip(request),
    )
    db.commit()
    response = RedirectResponse(url=_safe_next(str(stored.get("next", "/"))), status_code=302)
    set_session_cookie(response, request, token)
    response.delete_cookie(oidc.STATE_COOKIE)
    return response


@router.get("/{path:path}", include_in_schema=False, response_model=None)
def web_client(path: str) -> Response:
    """Serve the built web client: real files as-is, every other path as the SPA shell."""
    if path.startswith("api/") or path == "api":
        return Response(status_code=404)
    candidate = (CLIENT_DIR / path).resolve()
    if path and candidate.is_file() and CLIENT_DIR.resolve() in candidate.parents:
        # Hashed build assets never change under the same name.
        immutable = path.startswith("_app/immutable/")
        cache = "public, max-age=31536000, immutable" if immutable else "no-cache"
        return FileResponse(candidate, headers={"Cache-Control": cache})
    index = CLIENT_DIR / "index.html"
    if not index.exists():
        return HTMLResponse(
            "Web client not built. Run `pnpm install && pnpm build` in frontend/.",
            status_code=503,
        )
    return FileResponse(index, headers={"Cache-Control": "no-cache"})
