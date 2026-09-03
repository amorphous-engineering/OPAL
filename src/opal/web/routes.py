"""Web UI routes."""

import contextlib
import hmac
import logging
import math
import re
import secrets
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Form, Query, Request, Response
from fastapi.responses import HTMLResponse, RedirectResponse
from sqlalchemy import case, func, or_

from opal.api.deps import DbSession
from opal.api.net import client_ip as _client_ip
from opal.api.net import request_is_secure
from opal.core import execution_flow as exec_flow
from opal.core.auth import (
    SESSION_COOKIE,
    authenticate_password,
    create_session,
    generate_unique_username,
    hash_password,
    login_rate_limiter,
    resolve_session,
    revoke_session,
    sign_payload,
    validate_password_strength,
    verify_payload,
)
from opal.core.holds import holding_readout, scope_label
from opal.db.models import (
    InventoryRecord,
    Kit,
    Part,
    Purchase,
    PurchaseLine,
    Supplier,
    User,
    Workcenter,
)
from opal.db.models.dataset import DataPoint, Dataset
from opal.db.models.execution import InstanceStatus, ProcedureInstance, StepExecution
from opal.db.models.issue import Containment, Issue, IssuePriority, IssueStatus, IssueType
from opal.db.models.procedure import MasterProcedure, ProcedureStatus, ProcedureVersion
from opal.db.models.purchase import PurchaseStatus
from opal.db.models.requirement import Requirement
from opal.db.models.risk import Risk, RiskDisposition, RiskIssueRole
from opal.project import DEFAULT_TIERS
from opal.risks.dispositions import OPEN_DISPOSITIONS
from opal.web.templating import Jinja2Templates

logger = logging.getLogger("opal.web")

# Template directory
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


def status_value(status) -> str:
    """Get string value from status (handles both enum and string)."""
    if hasattr(status, "value"):
        return status.value
    return str(status) if status else ""


# Register custom filter
templates.env.filters["status_value"] = status_value
templates.env.filters["initials"] = exec_flow.user_initials

# Audit log display helpers
_TABLE_URL_MAP: dict[str, str] = {
    "part": "/parts",
    "inventory_record": "/inventory/opal",
    "master_procedure": "/procedures",
    "procedure_instance": "/executions",
    "issue": "/issues",
    "risk": "/risks",
    "purchase": "/purchases",
    "supplier": "/suppliers",
    "dataset": "/datasets",
    "workcenter": "/workcenters",
    "user": "/users",
}

TABLE_DISPLAY_NAMES: dict[str, str] = {
    "part": "Part",
    "inventory_record": "Inventory",
    "master_procedure": "Procedure",
    "procedure_step": "Step",
    "procedure_version": "Version",
    "procedure_instance": "Execution",
    "step_execution": "Step Exec",
    "issue": "Issue",
    "risk": "Risk",
    "purchase": "Purchase",
    "purchase_line": "PO Line",
    "supplier": "Supplier",
    "dataset": "Dataset",
    "data_point": "Data Point",
    "workcenter": "Workcenter",
    "user": "User",
    "kit": "Kit",
    "step_kit": "Step Kit",
    "inventory_consumption": "Consumption",
    "inventory_production": "Production",
    "attachment": "Attachment",
    "stock_transfer": "Transfer",
    "stock_test_result": "Test Result",
    "test_template": "Test Template",
}

templates.env.globals["TABLE_DISPLAY_NAMES"] = TABLE_DISPLAY_NAMES

# Default rows per page for paginated table partials
PAGE_SIZE = 100


def paginate_query(
    request: Request,
    query,
    page: int,
    colspan: int,
    page_size: int = PAGE_SIZE,
) -> tuple[list, dict[str, Any]]:
    """Apply offset/limit pagination to a query.

    Returns the page of results plus a context dict for the shared
    partials/pagination_row.html footer. prev/next URLs preserve all current
    query parameters (filters, sorting) and only change `page`.
    """
    total = query.count()
    pages = max(1, math.ceil(total / page_size))
    page = min(max(1, page), pages)
    items = query.offset((page - 1) * page_size).limit(page_size).all()

    def page_url(p: int) -> str:
        return str(request.url.include_query_params(page=p))

    pagination = {
        "page": page,
        "pages": pages,
        "total": total,
        "colspan": colspan,
        "start": (page - 1) * page_size + 1 if total else 0,
        "end": (page - 1) * page_size + len(items),
        "has_prev": page > 1,
        "has_next": page < pages,
        "prev_url": page_url(page - 1),
        "next_url": page_url(page + 1),
    }
    return items, pagination


def _active_database_path() -> str:
    """Resolved SQLite path for the footer, evaluated per render.

    Multiple OPAL processes (serve, MCP, installed binaries) can silently
    resolve different databases; the UI states which one it is serving.
    """
    from opal.config import get_active_settings

    return get_active_settings().database_url.removeprefix("sqlite:///")


templates.env.globals["active_database_path"] = _active_database_path


def _build_change_summary(entry) -> str:
    """Build short text summary of audit log changes."""
    action_val = entry.action.value if hasattr(entry.action, "value") else entry.action
    if action_val == "create":
        if entry.new_values and "name" in entry.new_values:
            return f"Created: {entry.new_values['name']}"
        return "Created"
    elif action_val == "update" and entry.new_values:
        fields = list(entry.new_values.keys())[:3]
        suffix = f" +{len(entry.new_values) - 3}" if len(entry.new_values) > 3 else ""
        return f"Changed: {', '.join(fields)}{suffix}"
    elif action_val == "delete":
        if entry.old_values and "name" in entry.old_values:
            return f"Deleted: {entry.old_values['name']}"
        return "Deleted"
    return ""


router = APIRouter()


def _get_current_user(request: Request, db) -> User | None:
    """Get current user from the session cookie."""
    return resolve_session(db, request.cookies.get(SESSION_COOKIE))


def _require_admin_web(request: Request, db) -> RedirectResponse | None:
    """Return redirect if current user is not admin, else None."""
    user = _get_current_user(request, db)
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
    current_user = _get_current_user(request, db)
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


# ============ LOGIN / LOGOUT ============


def _login_rate_key(request: Request, username: str) -> str:
    return f"{_client_ip(request) or 'unknown'}:{username.strip().lower()}"


def _mint_login_session(
    request: Request, db: DbSession, user: User, auth_method: str, next_url: str = "/"
) -> RedirectResponse:
    """Create a session for a successful login and redirect appropriately."""
    from opal.api.routes.auth import set_session_cookie

    token = create_session(
        db,
        user,
        auth_method=auth_method,
        user_agent=request.headers.get("user-agent"),
        ip_address=_client_ip(request),
    )
    db.commit()
    if user.needs_profile_setup:
        redirect_url = "/setup-profile"
    elif user.needs_onboarding:
        redirect_url = "/welcome"
    else:
        redirect_url = next_url or "/"
    response = RedirectResponse(url=redirect_url, status_code=302)
    set_session_cookie(response, request, token)
    return response


def _login_context(request: Request, **extra: Any) -> dict[str, Any]:
    """Which sign-in methods this instance offers, plus per-render extras."""
    from opal.config import get_active_settings
    from opal.core import oidc

    settings = get_active_settings()
    oidc_on = oidc.is_enabled()
    return {
        "request": request,
        "password_login_enabled": settings.password_login_enabled,
        "passkeys_enabled": settings.passkeys_enabled,
        "oidc_enabled": oidc_on,
        "oidc_provider_name": oidc.get_config().provider_name if oidc_on else None,
        **extra,
    }


@router.get("/login", response_class=HTMLResponse, response_model=None)
def login_page(request: Request, db: DbSession) -> HTMLResponse | RedirectResponse:
    """Sign-in page: password, passkey and OIDC, whichever are enabled."""
    # First-run: zero users means nobody can sign in yet. Send the operator to
    # /setup so the first admin exists before any credential is checked.
    if db.query(User).count() == 0:
        return RedirectResponse(url="/setup", status_code=302)

    # If already logged in, redirect to home
    if resolve_session(db, request.cookies.get(SESSION_COOKIE)) is not None:
        return RedirectResponse(url="/", status_code=302)

    return templates.TemplateResponse("login.html", _login_context(request))


# ============ OPENID CONNECT ============


@router.get("/oidc/login", response_model=None)
def oidc_login(request: Request, next: str = Query("/")) -> RedirectResponse | HTMLResponse:
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
        return templates.TemplateResponse(
            "login.html", _login_context(request, error=str(exc)), status_code=502
        )

    payload = oidc.sign_state(
        {"state": state, "nonce": nonce, "verifier": verifier, "next": _safe_next(next)}
    )
    response = RedirectResponse(url=auth_url, status_code=302)
    _set_oidc_state_cookie(response, request, payload)
    return response


@router.get("/oidc/callback", response_model=None)
def oidc_callback(
    request: Request,
    db: DbSession,
    code: str = Query(""),
    state: str = Query(""),
    error: str = Query(""),
    error_description: str = Query(""),
) -> RedirectResponse | HTMLResponse:
    """Complete the handshake: verify the token, resolve the user, mint a session."""
    from opal.core import oidc

    def _fail(message: str, status_code: int = 400) -> HTMLResponse:
        logger.warning("OIDC sign-in failed: %s", message)
        response = templates.TemplateResponse(
            "login.html", _login_context(request, error=message), status_code=status_code
        )
        response.delete_cookie(oidc.STATE_COOKIE)
        return response

    if not oidc.is_enabled():
        return RedirectResponse(url="/login", status_code=302)

    if error:
        return _fail(f"The identity provider refused the sign-in: {error_description or error}")
    if not code or not state:
        return _fail("The identity provider returned an incomplete response.")

    stored = oidc.verify_state(request.cookies.get(oidc.STATE_COOKIE))
    if stored is None:
        return _fail("The sign-in request expired. Please try again.")
    # Constant-time compare: state is the CSRF defence for the whole flow.
    if not hmac.compare_digest(str(stored.get("state", "")), state):
        return _fail("The sign-in request did not match. Please try again.")

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
        return _fail(str(exc))

    db.commit()
    db.refresh(user)

    response = _mint_login_session(
        request, db, user, auth_method="oidc", next_url=_safe_next(str(stored.get("next", "/")))
    )
    response.delete_cookie(oidc.STATE_COOKIE)
    return response


def _safe_next(value: str) -> str:
    """Confine post-login redirects to this app — never an attacker's host."""
    if not value.startswith("/") or value.startswith("//"):
        return "/"
    return value


def _set_oidc_state_cookie(response: Response, request: Request, payload: str) -> None:
    from opal.core import oidc

    response.set_cookie(
        oidc.STATE_COOKIE,
        payload,
        max_age=600,
        httponly=True,
        # The provider redirects back cross-site, so the cookie must survive a
        # top-level cross-site GET. `lax` does exactly that and no more.
        samesite="lax",
        secure=request_is_secure(request),
    )


def _setup_context(request: Request, **extra: Any) -> dict[str, Any]:
    """First-run context: the admin form, plus SSO when it is pre-configured."""
    from opal.core import oidc

    oidc_on = oidc.is_enabled()
    return {
        "request": request,
        "oidc_enabled": oidc_on,
        "oidc_provider_name": oidc.get_config().provider_name if oidc_on else None,
        **extra,
    }


@router.get("/setup", response_class=HTMLResponse, response_model=None)
def setup_page(request: Request, db: DbSession) -> HTMLResponse | RedirectResponse:
    """First-run admin creation. Bounces home once any user exists."""
    if db.query(User).count() > 0:
        return RedirectResponse(url="/", status_code=302)
    return templates.TemplateResponse("setup.html", _setup_context(request))


@router.post("/setup", response_model=None)
def setup_submit(
    request: Request,
    db: DbSession,
    name: str = Form(default=""),
    email: str = Form(default=""),
    username: str = Form(default=""),
    password: str = Form(default=""),
    password_confirm: str = Form(default=""),
) -> RedirectResponse | HTMLResponse:
    """Create the first admin account.

    Always credentialed: an instance whose only administrator lives in an
    external identity provider has no recovery path when that provider is
    unreachable. OIDC is configured afterwards from Settings — or pre-set by
    environment, in which case the first identity to sign in becomes admin.
    """
    if db.query(User).count() > 0:
        return RedirectResponse(url="/", status_code=302)

    def _retry(error: str) -> HTMLResponse:
        return templates.TemplateResponse(
            "setup.html",
            _setup_context(request, error=error, name=name, email=email, username=username),
            status_code=400,
        )

    clean_name = name.strip()
    clean_username = username.strip().lower()
    if not clean_name:
        return _retry("Name is required to create the first admin user.")
    if not clean_username:
        return _retry("Username is required.")
    if password != password_confirm:
        return _retry("Passwords do not match.")
    if error := validate_password_strength(password):
        return _retry(error)

    user = User(
        name=clean_name,
        username=generate_unique_username(db, clean_username),
        password_hash=hash_password(password),
        email=(email.strip() or None),
        is_active=True,
        is_admin=True,
        needs_onboarding=True,
    )
    db.add(user)
    db.commit()
    db.refresh(user)

    return _mint_login_session(request, db, user, auth_method="password")


@router.post("/login", response_model=None)
def login_submit(
    request: Request,
    db: DbSession,
    username: str = Form(...),
    password: str = Form(...),
) -> RedirectResponse | HTMLResponse:
    """Verify credentials and mint a session."""
    from opal.config import get_active_settings

    if not get_active_settings().password_login_enabled:
        return templates.TemplateResponse(
            "login.html",
            _login_context(request, error="Password sign-in is disabled on this instance."),
            status_code=403,
        )

    username = username.strip().lower()
    rate_key = _login_rate_key(request, username)
    if login_rate_limiter.is_blocked(rate_key):
        return templates.TemplateResponse(
            "login.html",
            _login_context(request, error="Too many failed attempts. Try again in a few minutes."),
            status_code=429,
        )

    # Passwordless (pre-credential) accounts are NOT claimable from the login
    # form. That was a trust-on-first-use oracle: anyone who guessed a migrated
    # username could seize the account — often an admin — by setting its
    # password. Claiming now requires an admin-issued, out-of-band link (see
    # /claim). Such accounts fall through to authenticate_password, which fails
    # closed with timing-safe dummy verification — indistinguishable from a
    # wrong password, so the form leaks nothing about which usernames exist or
    # are claimable.
    user = authenticate_password(db, username, password)
    if user is None:
        login_rate_limiter.record_failure(rate_key)
        return templates.TemplateResponse(
            "login.html",
            _login_context(request, error="Invalid username or password.", username=username),
            status_code=401,
        )

    login_rate_limiter.reset(rate_key)
    return _mint_login_session(request, db, user, auth_method="password")


@router.post("/login/set-password", response_model=None)
def login_set_password(
    request: Request,
    db: DbSession,
    state: str = Form(...),
    password: str = Form(...),
    password_confirm: str = Form(...),
) -> RedirectResponse | HTMLResponse:
    """Set the initial password for a migrated account being claimed.

    Reached only via an admin-issued claim link (see GET /claim). The signed
    state token names the account and carries its own expiry; it is honored
    only while the account still has no password hash, so a link cannot re-set
    an already-claimed account.
    """
    payload = verify_payload(state)
    if not payload or payload.get("kind") != "account-claim":
        return RedirectResponse(url="/login", status_code=302)

    user = db.query(User).filter(User.id == payload["uid"], User.is_active.is_(True)).first()
    if user is None or user.password_hash is not None:
        # Account vanished or someone else already claimed it
        return RedirectResponse(url="/login", status_code=302)

    def _retry(error: str) -> HTMLResponse:
        return templates.TemplateResponse(
            "login_set_password.html",
            _login_context(request, username=user.username, state=state, error=error),
            status_code=400,
        )

    if password != password_confirm:
        return _retry("Passwords do not match.")
    if error := validate_password_strength(password):
        return _retry(error)

    user.password_hash = hash_password(password)
    return _mint_login_session(request, db, user, auth_method="password")


@router.get("/claim", response_class=HTMLResponse, response_model=None)
def claim_account(
    request: Request, db: DbSession, token: str = Query("")
) -> HTMLResponse | RedirectResponse:
    """Landing page for an admin-issued account-claim link.

    The token is minted by an admin (POST /users/{id}/claim-link) and delivered
    out of band. This is the only path by which a passwordless account can set
    its first password. An invalid, expired, or already-claimed link is sent to
    the normal login page and reveals nothing.
    """
    payload = verify_payload(token)
    if not payload or payload.get("kind") != "account-claim":
        return RedirectResponse(url="/login", status_code=302)
    user = db.query(User).filter(User.id == payload["uid"], User.is_active.is_(True)).first()
    if user is None or user.password_hash is not None:
        return RedirectResponse(url="/login", status_code=302)
    return templates.TemplateResponse(
        "login_set_password.html",
        _login_context(request, username=user.username, state=token),
    )


@router.get("/logout", response_model=None)
def logout(request: Request, db: DbSession) -> HTMLResponse | RedirectResponse:
    """Revoke the OPAL session and clear the cookie.

    This ends the session in OPAL only. The identity provider's own session is
    deliberately left alone: RP-initiated logout would sign the user out of
    every application federated with that provider, which is not what a
    per-app sign-out button means.
    """
    revoke_session(db, request.cookies.get(SESSION_COOKIE))
    db.commit()

    response = RedirectResponse(url="/login", status_code=302)
    response.delete_cookie(SESSION_COOKIE)
    return response


@router.get("/setup-profile", response_class=HTMLResponse)
def setup_profile_page(request: Request, db: DbSession) -> HTMLResponse:
    """Profile setup page for new exe-auth users to set their display name."""
    user = _get_current_user(request, db)
    if not user:
        return RedirectResponse(url="/login", status_code=302)
    if not user.needs_profile_setup:
        return RedirectResponse(url="/", status_code=302)

    return templates.TemplateResponse(
        "setup_profile.html",
        {
            "request": request,
            "user": user,
        },
    )


@router.post("/setup-profile")
def setup_profile_submit(
    request: Request,
    db: DbSession,
    name: str = Form(...),
) -> RedirectResponse:
    """Save display name and clear the profile setup flag."""
    user = _get_current_user(request, db)
    if not user:
        return RedirectResponse(url="/login", status_code=302)

    user.name = name.strip()
    user.needs_profile_setup = False
    db.commit()

    return RedirectResponse(url="/", status_code=302)


@router.get("/welcome", response_class=HTMLResponse)
def welcome_page(request: Request, db: DbSession) -> HTMLResponse:
    """Welcome / onboarding page."""
    context = get_base_context(request, db, "Welcome")
    current_user = context.get("current_user")
    if not current_user:
        return RedirectResponse(url="/login", status_code=302)

    # First admin on a fresh system → project setup wizard
    is_fresh = db.query(Part).filter(Part.deleted_at.is_(None)).count() == 0
    if current_user.is_admin and is_fresh:
        return templates.TemplateResponse("welcome/setup.html", context)

    # Everyone else → orientation tutorial
    return templates.TemplateResponse("welcome/tutorial.html", context)


@router.get("/", response_class=HTMLResponse)
def index(request: Request, db: DbSession) -> HTMLResponse:
    """Home page."""
    from opal.db.models.audit import AuditLog

    context = get_base_context(request, db, "OPAL")

    # Redirect new users to onboarding
    current_user = context.get("current_user")
    if current_user and current_user.needs_onboarding:
        return RedirectResponse(url="/welcome", status_code=302)

    # Get counts for dashboard
    context["parts_count"] = db.query(Part).filter(Part.deleted_at.is_(None)).count()
    context["procedures_count"] = (
        db.query(MasterProcedure).filter(MasterProcedure.deleted_at.is_(None)).count()
    )
    context["open_issues_count"] = (
        db.query(Issue)
        .filter(
            Issue.deleted_at.is_(None),
            Issue.status == IssueStatus.OPEN,
        )
        .count()
    )
    context["in_progress_count"] = (
        db.query(ProcedureInstance).filter(ProcedureInstance.status == "in_work").count()
    )
    context["risks_count"] = (
        db.query(Risk)
        .filter(Risk.deleted_at.is_(None), Risk.disposition.in_(OPEN_DISPOSITIONS))
        .count()
    )
    context["high_risks_count"] = (
        db.query(Risk)
        .filter(
            Risk.deleted_at.is_(None),
            Risk.disposition.in_(OPEN_DISPOSITIONS),
            Risk.probability * Risk.impact > 12,
        )
        .count()
    )

    # Low stock count: aggregate on-hand quantity per part in one query
    qty_subq = (
        db.query(
            InventoryRecord.part_id.label("part_id"),
            func.sum(InventoryRecord.quantity).label("total_quantity"),
        )
        .group_by(InventoryRecord.part_id)
        .subquery()
    )
    context["low_stock_count"] = (
        db.query(Part)
        .outerjoin(qty_subq, qty_subq.c.part_id == Part.id)
        .filter(
            Part.deleted_at.is_(None),
            Part.reorder_point.isnot(None),
            func.coalesce(qty_subq.c.total_quantity, 0) < Part.reorder_point,
        )
        .count()
    )

    # Expiring soon count (within 30 days)
    today = date.today()
    threshold = today + timedelta(days=30)
    expiring_soon_count = (
        db.query(InventoryRecord)
        .join(Part)
        .filter(
            Part.deleted_at.is_(None),
            InventoryRecord.expiration_date.isnot(None),
            InventoryRecord.expiration_date <= threshold,
        )
        .count()
    )
    context["expiring_soon_count"] = expiring_soon_count

    # Calibration overdue count
    cal_overdue_count = (
        db.query(InventoryRecord)
        .join(Part)
        .filter(
            Part.deleted_at.is_(None),
            Part.is_tooling == True,  # noqa: E712
            InventoryRecord.calibration_due_at.isnot(None),
            InventoryRecord.calibration_due_at <= datetime.now(UTC),
        )
        .count()
    )
    context["cal_overdue_count"] = cal_overdue_count

    # Get recent audit activity
    recent_activity = db.query(AuditLog).order_by(AuditLog.timestamp.desc()).limit(15).all()
    context["recent_activity"] = recent_activity

    return templates.TemplateResponse("index.html", context)


def _pn_segments(pn: str | None, tier_code: str | None) -> tuple[str, str, str] | None:
    """Split a PN around its tier-code segment so the tag can set it apart.

    Returns (before, tier_code, after), or None when the code isn't a
    delimited segment of the PN (custom formats, missing config).
    """
    if not pn or not tier_code:
        return None
    match = re.search(rf"(?<![A-Za-z0-9]){re.escape(tier_code)}(?![A-Za-z0-9])", pn)
    if not match:
        return None
    return pn[: match.start()], pn[match.start() : match.end()], pn[match.end() :]


# ============ PARTS ============


def _parts_list_context(request: Request, db: DbSession) -> dict[str, Any]:
    from opal.config import get_active_project

    context = get_base_context(request, db, "Parts - OPAL")

    # Categories for the filter dropdown and the create form datalist
    categories = (
        db.query(Part.category)
        .filter(Part.deleted_at.is_(None), Part.category.isnot(None))
        .distinct()
        .all()
    )
    category_set = {c[0] for c in categories if c[0]}
    project = get_active_project()
    if project and project.categories:
        category_set |= set(project.categories)
    context["categories"] = sorted(category_set)
    context["tiers"] = project.tiers if project else DEFAULT_TIERS
    context["form_open"] = False
    context["form_prefill"] = {}
    return context


@router.get("/parts", response_class=HTMLResponse)
def parts_list(request: Request, db: DbSession) -> HTMLResponse:
    """Parts list page; hosts the create overlay."""
    return templates.TemplateResponse("parts/list.html", _parts_list_context(request, db))


@router.get("/parts/table", response_class=HTMLResponse)
def parts_table(
    request: Request,
    db: DbSession,
    search: str | None = Query(None),
    category: str | None = Query(None),
    tier: str | None = Query(None),
    top_level: str | None = Query(None),
    low_stock: str | None = Query(None),
    state: str | None = Query(None),
    sort_by: str | None = Query("id"),
    sort_order: str | None = Query("desc"),
    page: int = Query(1, ge=1),
) -> HTMLResponse:
    """Parts table rows (HTMX partial)."""
    # Aggregate on-hand quantity per part once, then outer-join it so the
    # whole table renders from a single query instead of one SUM per row.
    qty_subq = (
        db.query(
            InventoryRecord.part_id.label("part_id"),
            func.sum(InventoryRecord.quantity).label("total_quantity"),
        )
        .group_by(InventoryRecord.part_id)
        .subquery()
    )
    total_qty_col = func.coalesce(qty_subq.c.total_quantity, 0)

    query = (
        db.query(Part, total_qty_col.label("total_quantity"))
        .outerjoin(qty_subq, qty_subq.c.part_id == Part.id)
        .filter(Part.deleted_at.is_(None))
    )

    if state in ("draft", "active"):
        query = query.filter(Part.lifecycle_state == state)

    if search:
        search_term = f"%{search}%"
        query = query.filter(
            or_(
                Part.name.ilike(search_term),
                Part.internal_pn.ilike(search_term),
                Part.external_pn.ilike(search_term),
                Part.description.ilike(search_term),
            )
        )

    if category:
        query = query.filter(Part.category == category)

    if tier:
        with contextlib.suppress(ValueError):
            query = query.filter(Part.tier == int(tier))

    if top_level:
        if top_level == "true":
            query = query.filter(Part.parent_id.is_(None))
        elif top_level == "false":
            query = query.filter(Part.parent_id.isnot(None))

    if low_stock == "true":
        # Filter in SQL so results are correct beyond the page limit
        query = query.filter(
            Part.reorder_point.isnot(None),
            total_qty_col < Part.reorder_point,
        )

    # Apply sorting
    sort_columns = {
        "id": Part.id,
        "internal_pn": Part.internal_pn,
        "external_pn": Part.external_pn,
        "name": Part.name,
        "category": Part.category,
        "tier": Part.tier,
        "state": Part.lifecycle_state,
        "unit_of_measure": Part.unit_of_measure,
    }

    sort_col = sort_columns.get(sort_by, Part.id)
    if sort_order == "asc":
        query = query.order_by(sort_col.asc())
    else:
        query = query.order_by(sort_col.desc())
    rows, pagination = paginate_query(request, query, page, colspan=6)

    parts_with_qty = []
    for part, total_qty in rows:
        tq = total_qty or 0
        is_low = bool(part.reorder_point is not None and tq < part.reorder_point)
        part_data = {
            "id": part.id,
            "internal_pn": part.internal_pn,
            "external_pn": part.external_pn,
            "name": part.name,
            "category": part.category,
            "tier": part.tier,
            "unit_of_measure": part.unit_of_measure,
            "total_quantity": tq,
            "reorder_point": part.reorder_point,
            "is_low_stock": is_low,
            "lifecycle_state": part.lifecycle_state,
        }
        parts_with_qty.append(type("PartWithQty", (), part_data)())

    return templates.TemplateResponse(
        "parts/table_rows.html",
        {
            "request": request,
            "parts": parts_with_qty,
            "sort_by": sort_by,
            "sort_order": sort_order,
            "pagination": pagination,
        },
    )


@router.get("/parts/search", response_class=HTMLResponse)
def parts_search_dropdown(
    request: Request,
    db: DbSession,
    q: str = Query("", min_length=0),
    limit: int = Query(5, ge=1, le=10),
) -> HTMLResponse:
    """Search parts and return dropdown results (HTMX partial)."""
    if not q or len(q) < 1:
        return HTMLResponse("")

    search_term = f"%{q}%"
    parts = (
        db.query(Part)
        .filter(
            Part.deleted_at.is_(None),
            or_(
                Part.name.ilike(search_term),
                Part.internal_pn.ilike(search_term),
                Part.external_pn.ilike(search_term),
            ),
        )
        .order_by(Part.id.desc())
        .limit(limit)
        .all()
    )

    return templates.TemplateResponse(
        "components/part_search_results.html",
        {"request": request, "parts": parts, "query": q},
    )


@router.get("/parts/import", response_class=HTMLResponse)
def parts_import(request: Request, db: DbSession) -> HTMLResponse:
    """CSV import page for parts."""
    context = get_base_context(request, db, "Import Parts - OPAL")
    return templates.TemplateResponse("parts/import.html", context)


@router.get("/parts/new", response_class=HTMLResponse)
def parts_new(request: Request, db: DbSession, parent_id: int | None = Query(None)) -> HTMLResponse:
    """Deep link: the parts list with the create overlay open.

    The form never asks what the invoking context already knows —
    ?parent_id pre-fills PARENT (create-from-BOM and friends).
    """
    context = _parts_list_context(request, db)
    context["form_open"] = True
    if parent_id is not None:
        parent = db.query(Part).filter(Part.id == parent_id, Part.deleted_at.is_(None)).first()
        if parent:
            context["form_prefill"] = {
                "parent_id": parent.id,
                "parent_label": f"{parent.internal_pn} - {parent.name}",
            }
    return templates.TemplateResponse("parts/list.html", context)


def _parts_detail_response(
    request: Request, db: DbSession, part_id: int, edit_open: bool = False
) -> HTMLResponse:
    from opal.config import get_active_project

    part = db.query(Part).filter(Part.id == part_id, Part.deleted_at.is_(None)).first()
    if not part:
        return templates.TemplateResponse(
            "errors/404.html",
            {"request": request, "message": f"Part {part_id} not found"},
            status_code=404,
        )

    # The PN is the page's name; the DB row id appears nowhere
    context = get_base_context(request, db, f"{part.internal_pn or part.name} - OPAL")
    context["part"] = part

    # Tier name + PN tier-segment from project config
    project = get_active_project()
    tier_config = project.get_tier(part.tier) if project else None
    context["tier_name"] = tier_config.name if tier_config else None
    context["pn_segments"] = _pn_segments(
        part.internal_pn, tier_config.code if tier_config else str(part.tier)
    )

    # Get inventory records
    inventory_records = db.query(InventoryRecord).filter(InventoryRecord.part_id == part_id).all()
    context["inventory_records"] = inventory_records

    # Calculate total quantity for display
    total_quantity = sum(r.quantity for r in inventory_records)
    part.total_quantity = total_quantity  # Attach to part for template access

    # Where Used: procedure kit usage
    from opal.db.models.procedure import StepKit

    kit_usages = (
        db.query(Kit)
        .join(MasterProcedure)
        .filter(Kit.part_id == part.id, MasterProcedure.deleted_at.is_(None))
        .all()
    )
    context["kit_usages"] = kit_usages

    # Where Used: step-level kit usage
    step_kit_usages = db.query(StepKit).filter(StepKit.part_id == part.id).all()
    context["step_kit_usages"] = step_kit_usages

    # Allocated requirements (PartRequirement joined to first-class rows)
    from opal.db.models import PartRequirement

    part_reqs = db.query(PartRequirement).filter(PartRequirement.part_id == part.id).all()
    context["part_requirements"] = [
        {
            "allocation": pr,
            "req": db.get(Requirement, pr.requirement_ref_id) if pr.requirement_ref_id else None,
        }
        for pr in part_reqs
    ]

    # Where Used: consumption history
    from opal.db.models.inventory import InventoryConsumption

    consumption_history = (
        db.query(InventoryConsumption)
        .join(InventoryRecord)
        .filter(InventoryRecord.part_id == part.id)
        .order_by(InventoryConsumption.created_at.desc())
        .limit(50)
        .all()
    )
    context["consumption_history"] = consumption_history

    # BOM: components of this assembly (design-level)
    from opal.db.models.part import BOMLine

    bom_lines = db.query(BOMLine).filter(BOMLine.assembly_id == part.id).all()
    context["bom_lines"] = bom_lines

    # BOM: assemblies this part is used in (where-used)
    where_used = db.query(BOMLine).filter(BOMLine.component_id == part.id).all()
    context["where_used"] = where_used

    # Test templates
    from opal.db.models.inventory import TestTemplate

    test_templates = (
        db.query(TestTemplate)
        .filter(TestTemplate.part_id == part.id)
        .order_by(TestTemplate.sort_order)
        .all()
    )
    context["test_templates"] = test_templates

    # Onshape link (if integration is active)
    onshape_link = None
    try:
        from opal.db.models.onshape_link import OnshapeLink

        onshape_link = db.query(OnshapeLink).filter(OnshapeLink.part_id == part.id).first()
    except Exception:
        pass
    context["onshape_link"] = onshape_link

    # Supplier catalog entries for this part (hide soft-deleted suppliers)
    context["supplier_entries"] = [
        sp for sp in part.supplier_entries if sp.supplier.deleted_at is None
    ]

    # Where it stands: PO lines not yet fully received on live POs
    open_po_lines = (
        db.query(PurchaseLine)
        .join(Purchase, PurchaseLine.purchase_id == Purchase.id)
        .filter(
            PurchaseLine.part_id == part.id,
            Purchase.status.in_(
                (PurchaseStatus.DRAFT, PurchaseStatus.ORDERED, PurchaseStatus.PARTIAL)
            ),
        )
        .all()
    )
    context["open_po_lines"] = open_po_lines

    # Lifecycle: referenced drafts lose the delete control entirely
    from opal.core.part_lifecycle import reference_counts

    refs = reference_counts(db, part)
    context["part_reference_counts"] = refs
    context["part_is_referenced"] = bool(refs)

    # The edit overlay (shared part form) lives on this page
    context["tiers"] = project.tiers if project else DEFAULT_TIERS
    categories = (
        db.query(Part.category)
        .filter(Part.deleted_at.is_(None), Part.category.isnot(None))
        .distinct()
        .all()
    )
    category_set = {c[0] for c in categories if c[0]}
    if project and project.categories:
        category_set |= set(project.categories)
    context["categories"] = sorted(category_set)
    context["form_open"] = edit_open

    return templates.TemplateResponse("parts/detail.html", context)


@router.get("/parts/{part_id}", response_class=HTMLResponse)
def parts_detail(request: Request, db: DbSession, part_id: int) -> HTMLResponse:
    """Part detail page; hosts the edit overlay."""
    return _parts_detail_response(request, db, part_id)


@router.get("/parts/{part_id}/edit", response_class=HTMLResponse)
def parts_edit(request: Request, db: DbSession, part_id: int) -> HTMLResponse:
    """Deep link: the part page with the edit overlay open."""
    return _parts_detail_response(request, db, part_id, edit_open=True)


# ============ INVENTORY ============


@router.get("/inventory", response_class=HTMLResponse)
def inventory_list(request: Request, db: DbSession) -> HTMLResponse:
    """Inventory list page."""
    context = get_base_context(request, db, "Inventory - OPAL")

    # Get locations for filter
    locations = db.query(InventoryRecord.location).distinct().all()
    context["locations"] = sorted([loc[0] for loc in locations])

    return templates.TemplateResponse("inventory/list.html", context)


@router.get("/inventory/new", response_class=HTMLResponse)
def inventory_new(
    request: Request,
    db: DbSession,
    part_id: int | None = Query(None),
) -> HTMLResponse:
    """New inventory record form page."""
    context = get_base_context(request, db, "Add Inventory - OPAL")

    # Get locations for autocomplete
    locations = db.query(InventoryRecord.location).distinct().all()
    context["locations"] = sorted([loc[0] for loc in locations if loc[0]])

    # If part_id provided, load the part
    selected_part = None
    if part_id:
        selected_part = db.query(Part).filter(Part.id == part_id, Part.deleted_at.is_(None)).first()
    context["selected_part"] = selected_part

    return templates.TemplateResponse("inventory/new.html", context)


@router.get("/inventory/table", response_class=HTMLResponse)
def inventory_table(
    request: Request,
    db: DbSession,
    location: str | None = Query(None),
    part_id: int | None = Query(None),
    opal_search: str | None = Query(None),
    source_type: str | None = Query(None),
    expiration: str | None = Query(None),
    calibration: str | None = Query(None),
    page: int = Query(1, ge=1),
) -> HTMLResponse:
    """Inventory table rows (HTMX partial)."""
    query = db.query(InventoryRecord).join(Part).filter(Part.deleted_at.is_(None))

    if location:
        query = query.filter(InventoryRecord.location == location)
    if part_id:
        query = query.filter(InventoryRecord.part_id == part_id)
    if opal_search:
        query = query.filter(InventoryRecord.opal_number.ilike(f"%{opal_search}%"))
    if source_type:
        query = query.filter(InventoryRecord.source_type == source_type)
    if expiration == "expired":
        query = query.filter(
            InventoryRecord.expiration_date.isnot(None),
            InventoryRecord.expiration_date < date.today(),
        )
    elif expiration == "expiring":
        today = date.today()
        threshold = today + timedelta(days=30)
        query = query.filter(
            InventoryRecord.expiration_date.isnot(None),
            InventoryRecord.expiration_date <= threshold,
        )
    if calibration == "overdue":
        now = datetime.now(UTC)
        query = query.filter(
            Part.is_tooling == True,  # noqa: E712
            InventoryRecord.calibration_due_at.isnot(None),
            InventoryRecord.calibration_due_at <= now,
        )

    # Order by OPAL number (most recent first)
    records, pagination = paginate_query(
        request, query.order_by(InventoryRecord.opal_number.desc()), page, colspan=9
    )

    return templates.TemplateResponse(
        "inventory/table_rows.html",
        {
            "request": request,
            "records": records,
            "today": date.today(),
            "now": datetime.now(UTC),
            "pagination": pagination,
        },
    )


@router.get("/inventory/opal/{opal_number}", response_class=HTMLResponse)
def inventory_opal_detail(
    request: Request,
    db: DbSession,
    opal_number: str,
) -> HTMLResponse:
    """OPAL item detail page with full traceability history."""
    from sqlalchemy.orm import joinedload, selectinload

    from opal.db.models.inventory import InventoryConsumption, InventoryProduction
    from opal.db.models.purchase import PurchaseLine

    record = (
        db.query(InventoryRecord)
        .options(
            joinedload(InventoryRecord.part),
            selectinload(InventoryRecord.consumptions).joinedload(
                InventoryConsumption.procedure_instance
            ),
        )
        .join(Part)
        .filter(InventoryRecord.opal_number == opal_number, Part.deleted_at.is_(None))
        .first()
    )

    if not record:
        return templates.TemplateResponse(
            "errors/404.html",
            {"request": request, "message": f"OPAL {opal_number} not found"},
            status_code=404,
        )

    context = get_base_context(request, db, f"{opal_number} - OPAL")
    context["record"] = record
    context["opal_number"] = opal_number
    context["today"] = date.today()
    context["now"] = datetime.now(UTC)

    # Build history timeline
    history = []

    # Track source PO for display
    source_po = None
    source_info = {}
    if record.source_purchase_line_id:
        po_line = (
            db.query(PurchaseLine).filter(PurchaseLine.id == record.source_purchase_line_id).first()
        )
        if po_line and po_line.purchase:
            source_po = {
                "id": po_line.purchase_id,
                "number": po_line.purchase.reference,
            }
            source_info = {
                "po_id": po_line.purchase_id,
                "po_number": po_line.purchase.reference,
            }
    context["source_po"] = source_po

    history.append(
        {
            "event": "created",
            "timestamp": record.created_at,
            "details": {
                "source_type": record.source_type.value
                if record.source_type and hasattr(record.source_type, "value")
                else record.source_type,
                "quantity": float(record.quantity),
                **source_info,
            },
        }
    )

    # Consumptions
    for c in record.consumptions:
        history.append(
            {
                "event": "consumed",
                "timestamp": c.created_at,
                "details": {
                    "quantity": float(c.quantity),
                    "usage_type": c.usage_type.value
                    if hasattr(c.usage_type, "value")
                    else c.usage_type,
                    "procedure_instance_id": c.procedure_instance_id,
                    "work_order_number": c.procedure_instance.work_order_number
                    if c.procedure_instance
                    else None,
                    "notes": c.notes,
                },
            }
        )

    # Sort by timestamp
    history.sort(key=lambda h: h["timestamp"], reverse=True)
    context["history"] = history

    # Source production info (if this item was produced)
    source_wo = None
    if record.source_production_id:
        production = (
            db.query(InventoryProduction)
            .filter(InventoryProduction.id == record.source_production_id)
            .first()
        )
        if production and production.procedure_instance:
            source_wo = {
                "instance_id": production.procedure_instance_id,
                "work_order_number": production.procedure_instance.work_order_number,
                "serial_number": production.serial_number,
            }
    context["source_wo"] = source_wo

    # Genealogy data
    from opal.core.genealogy import get_full_genealogy

    genealogy = get_full_genealogy(db, opal_number)
    context["genealogy_components"] = genealogy["components"]
    context["genealogy_assemblies"] = genealogy["assemblies_containing"]

    # Test results and templates
    from opal.db.models.inventory import StockTestResult, TestTemplate

    test_results = (
        db.query(StockTestResult)
        .filter(StockTestResult.inventory_record_id == record.id)
        .order_by(StockTestResult.created_at.desc())
        .all()
    )
    context["test_results"] = test_results

    test_templates = (
        db.query(TestTemplate)
        .filter(TestTemplate.part_id == record.part_id)
        .order_by(TestTemplate.sort_order)
        .all()
    )
    context["test_templates"] = test_templates

    return templates.TemplateResponse("inventory/opal_detail.html", context)


@router.get("/inventory/{inventory_id}/adjust", response_class=HTMLResponse)
def inventory_adjust(
    request: Request,
    db: DbSession,
    inventory_id: int,
) -> HTMLResponse:
    """Inventory adjustment form page."""
    record = (
        db.query(InventoryRecord)
        .join(Part)
        .filter(InventoryRecord.id == inventory_id, Part.deleted_at.is_(None))
        .first()
    )
    if not record:
        return templates.TemplateResponse(
            "errors/404.html",
            {"request": request, "message": f"Inventory record {inventory_id} not found"},
            status_code=404,
        )

    context = get_base_context(request, db, f"Adjust {record.opal_number or inventory_id} - OPAL")
    context["record"] = record
    return templates.TemplateResponse("inventory/adjust.html", context)


# ============ PURCHASES ============


@router.get("/purchases", response_class=HTMLResponse)
def purchases_list(request: Request, db: DbSession) -> HTMLResponse:
    """Purchases list page."""
    context = get_base_context(request, db, "Purchases - OPAL")
    context["statuses"] = [s.value for s in PurchaseStatus]
    return templates.TemplateResponse("purchases/list.html", context)


@router.get("/purchases/table", response_class=HTMLResponse)
def purchases_table(
    request: Request,
    db: DbSession,
    status: str | None = Query(None),
    page: int = Query(1, ge=1),
) -> HTMLResponse:
    """Purchases table rows (HTMX partial)."""
    query = db.query(Purchase)

    if status:
        query = query.filter(Purchase.status == status)

    purchases, pagination = paginate_query(
        request, query.order_by(Purchase.id.desc()), page, colspan=6
    )

    return templates.TemplateResponse(
        "purchases/table_rows.html",
        {"request": request, "purchases": purchases, "pagination": pagination},
    )


@router.get("/purchases/new", response_class=HTMLResponse)
def purchases_new(
    request: Request,
    db: DbSession,
    supplier_id: int | None = None,
) -> HTMLResponse:
    """New purchase form page."""
    context = get_base_context(request, db, "New Purchase - OPAL")

    # Get suppliers for dropdown - convert to dicts for JSON serialization
    suppliers = (
        db.query(Supplier)
        .filter(
            Supplier.deleted_at.is_(None),
            Supplier.is_active == True,  # noqa: E712
        )
        .order_by(Supplier.name)
        .all()
    )
    context["suppliers"] = [{"id": s.id, "name": s.name, "code": s.code} for s in suppliers]
    context["preselected_supplier_id"] = supplier_id

    return templates.TemplateResponse("purchases/new.html", context)


@router.get("/purchases/{purchase_id}", response_class=HTMLResponse)
def purchases_detail(request: Request, db: DbSession, purchase_id: int) -> HTMLResponse:
    """Purchase detail page."""
    purchase = db.query(Purchase).filter(Purchase.id == purchase_id).first()
    if not purchase:
        return templates.TemplateResponse(
            "errors/404.html",
            {"request": request, "message": f"Purchase {purchase_id} not found"},
            status_code=404,
        )

    context = get_base_context(request, db, f"{purchase.reference or 'PO'} - OPAL")
    context["purchase"] = purchase
    context["statuses"] = [s.value for s in PurchaseStatus]

    # Known stock locations feed the receive form's datalist — receiving
    # into an existing location should not require retyping it.
    context["known_locations"] = [
        row[0]
        for row in db.query(InventoryRecord.location)
        .filter(InventoryRecord.location.isnot(None))
        .distinct()
        .order_by(InventoryRecord.location)
        .all()
    ]

    # Expense ledger records (written at receive time)
    from opal.db.models import PurchaseExpense

    expenses = (
        db.query(PurchaseExpense)
        .filter(PurchaseExpense.purchase_id == purchase_id)
        .order_by(PurchaseExpense.received_at, PurchaseExpense.id)
        .all()
    )
    context["expenses"] = expenses
    totals = [e.total_cost for e in expenses if e.total_cost is not None]
    context["expense_total"] = sum(totals) if totals else None

    return templates.TemplateResponse("purchases/detail.html", context)


# ============ PROCEDURES ============


@router.get("/procedures", response_class=HTMLResponse)
def procedures_list(request: Request, db: DbSession) -> HTMLResponse:
    """Procedures list page."""
    context = get_base_context(request, db, "Procedures - OPAL")
    context["statuses"] = [s.value for s in ProcedureStatus]
    return templates.TemplateResponse("procedures/list.html", context)


@router.get("/procedures/table", response_class=HTMLResponse)
def procedures_table(
    request: Request,
    db: DbSession,
    search: str | None = Query(None),
    status: str | None = Query(None),
    page: int = Query(1, ge=1),
) -> HTMLResponse:
    """Procedures table rows (HTMX partial)."""
    from opal.db.models.procedure import ProcedureStep

    # Join version number and step count in one query instead of two extra
    # queries per row
    step_count_subq = (
        db.query(
            ProcedureStep.procedure_id.label("procedure_id"),
            func.count(ProcedureStep.id).label("step_count"),
        )
        .group_by(ProcedureStep.procedure_id)
        .subquery()
    )
    query = (
        db.query(
            MasterProcedure,
            ProcedureVersion.version_number,
            func.coalesce(step_count_subq.c.step_count, 0).label("step_count"),
        )
        .outerjoin(ProcedureVersion, ProcedureVersion.id == MasterProcedure.current_version_id)
        .outerjoin(step_count_subq, step_count_subq.c.procedure_id == MasterProcedure.id)
        .filter(MasterProcedure.deleted_at.is_(None))
    )

    if search:
        search_term = f"%{search}%"
        query = query.filter(MasterProcedure.name.ilike(search_term))

    if status:
        query = query.filter(MasterProcedure.status == status)

    rows, pagination = paginate_query(
        request, query.order_by(MasterProcedure.id.desc()), page, colspan=8
    )

    procs_with_info = []
    for p, version_number, step_count in rows:
        # Handle status - may be enum or string depending on context
        status_val = p.status.value if hasattr(p.status, "value") else p.status
        procs_with_info.append(
            {
                "id": p.id,
                "name": p.name,
                "procedure_type": p.procedure_type.value
                if hasattr(p.procedure_type, "value")
                else p.procedure_type,
                "status": status_val,
                "current_version_id": p.current_version_id,
                "version_number": version_number,
                "step_count": step_count,
                "created_at": p.created_at,
                "updated_at": p.updated_at,
            }
        )

    return templates.TemplateResponse(
        "procedures/table_rows.html",
        {"request": request, "procedures": procs_with_info, "pagination": pagination},
    )


@router.get("/procedures/new", response_class=HTMLResponse)
def procedures_new(request: Request, db: DbSession) -> HTMLResponse:
    """New procedure form page."""
    context = get_base_context(request, db, "New Procedure - OPAL")

    # Get workcenters for the form
    workcenters = (
        db.query(Workcenter).filter(Workcenter.is_active.is_(True)).order_by(Workcenter.name).all()
    )
    context["workcenters"] = workcenters

    return templates.TemplateResponse("procedures/new.html", context)


_PROCEDURE_TABS = ("meta", "operations", "flow", "kit", "outputs", "versions")


@router.get("/procedures/{procedure_id}", response_class=HTMLResponse)
def procedures_detail(
    request: Request,
    db: DbSession,
    procedure_id: int,
    tab: str = "meta",
    op: int | None = None,
    step: int | None = None,
) -> HTMLResponse:
    """Procedure detail / editor page."""
    procedure = (
        db.query(MasterProcedure)
        .filter(MasterProcedure.id == procedure_id, MasterProcedure.deleted_at.is_(None))
        .first()
    )
    if not procedure:
        return templates.TemplateResponse(
            "errors/404.html",
            {"request": request, "message": f"Procedure {procedure_id} not found"},
            status_code=404,
        )

    context = get_base_context(request, db, f"{procedure.name} - OPAL")
    context["procedure"] = procedure
    context["statuses"] = [s.value for s in ProcedureStatus]

    # Get versions
    versions = (
        db.query(ProcedureVersion)
        .filter(ProcedureVersion.procedure_id == procedure_id)
        .order_by(ProcedureVersion.version_number.desc())
        .all()
    )
    context["versions"] = versions

    # Get current version number
    current_version_num = None
    if procedure.current_version_id:
        current_ver = (
            db.query(ProcedureVersion)
            .filter(ProcedureVersion.id == procedure.current_version_id)
            .first()
        )
        if current_ver:
            current_version_num = current_ver.version_number
    context["current_version_num"] = current_version_num

    # Get kit items
    kit_items = (
        db.query(Kit).join(Part).filter(Kit.procedure_id == procedure_id).order_by(Part.name).all()
    )
    context["kit_items"] = [
        {
            "id": k.id,
            "part_id": k.part_id,
            "part_name": k.part.name,
            "part_internal_pn": k.part.internal_pn,
            "part_external_pn": k.part.external_pn,
            "quantity_required": float(k.quantity_required),
        }
        for k in kit_items
    ]

    # Get output items (what this procedure produces)
    from opal.db.models.procedure import ProcedureOutput

    output_items = (
        db.query(ProcedureOutput)
        .join(Part)
        .filter(ProcedureOutput.procedure_id == procedure_id)
        .order_by(Part.name)
        .all()
    )
    context["output_items"] = [
        {
            "id": o.id,
            "part_id": o.part_id,
            "part_name": o.part.name,
            "part_internal_pn": o.part.internal_pn,
            "part_external_pn": o.part.external_pn,
            "quantity_produced": float(o.quantity_produced),
        }
        for o in output_items
    ]

    # Organize steps hierarchically
    all_steps = procedure.steps
    ops = []  # Top-level normal ops
    contingency_ops = []  # Top-level contingency ops

    # Build step lookup for sub-steps
    step_children: dict[int, list] = {}
    for step in all_steps:
        if step.parent_step_id:
            if step.parent_step_id not in step_children:
                step_children[step.parent_step_id] = []
            step_children[step.parent_step_id].append(step)

    # Separate top-level ops
    for step in all_steps:
        if step.parent_step_id is None:
            step_data = {
                "step": step,
                "sub_steps": sorted(step_children.get(step.id, []), key=lambda s: s.order),
            }
            if step.is_contingency:
                contingency_ops.append(step_data)
            else:
                ops.append(step_data)

    # Sort by `order` (the sequence field the reorder API updates). `step_number`
    # is a stable display label and never changes when ops are rearranged.
    ops.sort(key=lambda x: x["step"].order)
    contingency_ops.sort(key=lambda x: x["step"].order)

    context["ops"] = ops
    context["contingency_ops"] = contingency_ops

    # Validate tab + pick selected op for the Operations tab.
    context["tab"] = tab if tab in _PROCEDURE_TABS else "meta"
    all_ops = ops + contingency_ops
    valid_op_orders = {o["step"].order for o in all_ops}

    def _default_op_order() -> int | None:
        if not all_ops:
            return None
        return all_ops[0]["step"].order

    context["selected_op_order"] = op if op in valid_op_orders else _default_op_order()
    context["selected_step_id"] = step

    # Per-step kit lookup keyed by step.id for the inline editor.
    from opal.db.models.procedure import ProcedureStep, StepDependency, StepKit

    step_kit_rows = (
        db.query(StepKit)
        .join(ProcedureStep, StepKit.step_id == ProcedureStep.id)
        .filter(ProcedureStep.procedure_id == procedure_id)
        .all()
    )
    step_kit_by_step: dict[int, list[dict]] = {}
    for sk in step_kit_rows:
        step_kit_by_step.setdefault(sk.step_id, []).append(
            {
                "id": sk.id,
                "part_id": sk.part_id,
                "part_name": sk.part.name,
                "quantity_required": float(sk.quantity_required),
                "usage_type": sk.usage_type.value
                if hasattr(sk.usage_type, "value")
                else sk.usage_type,
                "notes": sk.notes,
            }
        )
    context["step_kit_by_step"] = step_kit_by_step

    # Dependency edges for the Flow tab — only top-level op-to-op edges.
    dep_rows = (
        db.query(StepDependency)
        .join(ProcedureStep, StepDependency.step_id == ProcedureStep.id)
        .filter(ProcedureStep.procedure_id == procedure_id)
        .all()
    )
    context["dependencies"] = [
        {"step_id": d.step_id, "depends_on_step_id": d.depends_on_step_id} for d in dep_rows
    ]

    # Reference documents (drawings, PDFs, datasheets) attached at template level.
    from opal.db.models.attachment import Attachment

    context["reference_attachments"] = (
        db.query(Attachment)
        .filter(
            Attachment.procedure_id == procedure_id,
            Attachment.kind == "reference",
        )
        .order_by(Attachment.original_filename.asc())
        .all()
    )

    return templates.TemplateResponse("procedures/detail.html", context)


@router.get("/procedures/{procedure_id}/edit", response_class=HTMLResponse)
def procedures_edit(request: Request, db: DbSession, procedure_id: int) -> HTMLResponse:
    """Procedure edit form page."""
    procedure = (
        db.query(MasterProcedure)
        .filter(MasterProcedure.id == procedure_id, MasterProcedure.deleted_at.is_(None))
        .first()
    )
    if not procedure:
        return templates.TemplateResponse(
            "errors/404.html",
            {"request": request, "message": f"Procedure {procedure_id} not found"},
            status_code=404,
        )

    context = get_base_context(request, db, f"Edit {procedure.name} - OPAL")
    context["procedure"] = procedure
    return templates.TemplateResponse("procedures/edit.html", context)


@router.get("/procedures/{procedure_id}/steps/{step_id}/edit")
def procedures_step_edit(db: DbSession, procedure_id: int, step_id: int) -> RedirectResponse:
    """Redirect the deep-link step editor URL to the inline editor in the
    Operations tab. Keeps old bookmarks working."""
    from opal.db.models.procedure import ProcedureStep

    step = (
        db.query(ProcedureStep)
        .filter(ProcedureStep.id == step_id, ProcedureStep.procedure_id == procedure_id)
        .first()
    )
    parent_order = None
    if step is not None:
        if step.parent_step_id is not None:
            parent = db.query(ProcedureStep).filter(ProcedureStep.id == step.parent_step_id).first()
            if parent is not None:
                parent_order = parent.order
        else:
            parent_order = step.order

    target = f"/procedures/{procedure_id}?tab=operations"
    if parent_order is not None:
        target += f"&op={parent_order}"
    target += f"&step={step_id}"
    return RedirectResponse(url=target, status_code=302)


@router.get("/procedures/{proc_id}/versions/{v1_id}/diff/{v2_id}", response_class=HTMLResponse)
def procedures_version_diff(
    request: Request, db: DbSession, proc_id: int, v1_id: int, v2_id: int
) -> HTMLResponse:
    """Side-by-side diff of two procedure versions."""
    from opal.core.diff import diff_procedure_versions

    procedure = db.query(MasterProcedure).filter(MasterProcedure.id == proc_id).first()
    if not procedure:
        return HTMLResponse("Procedure not found", status_code=404)

    version_a = db.query(ProcedureVersion).filter(ProcedureVersion.id == v1_id).first()
    version_b = db.query(ProcedureVersion).filter(ProcedureVersion.id == v2_id).first()
    if not version_a or not version_b:
        return HTMLResponse("Version not found", status_code=404)

    proc_changes, step_diffs = diff_procedure_versions(version_a.content, version_b.content)

    context = get_base_context(
        request, db, f"Diff v{version_a.version_number} → v{version_b.version_number} - OPAL"
    )
    context["procedure"] = procedure
    context["version_a"] = version_a
    context["version_b"] = version_b
    context["proc_changes"] = proc_changes
    context["step_diffs"] = step_diffs
    context["added_count"] = sum(1 for d in step_diffs if d.status == "added")
    context["removed_count"] = sum(1 for d in step_diffs if d.status == "removed")
    context["modified_count"] = sum(1 for d in step_diffs if d.status == "modified")
    context["unchanged_count"] = sum(1 for d in step_diffs if d.status == "unchanged")

    return templates.TemplateResponse("procedures/version_diff.html", context)


@router.get("/procedures/{proc_id}/versions/{ver_id}/print", response_class=HTMLResponse)
def procedures_version_print(
    request: Request, db: DbSession, proc_id: int, ver_id: int
) -> HTMLResponse:
    """Print-friendly procedure traveler."""
    import base64
    import io

    import segno

    version = (
        db.query(ProcedureVersion)
        .filter(
            ProcedureVersion.id == ver_id,
            ProcedureVersion.procedure_id == proc_id,
        )
        .first()
    )
    if not version:
        return HTMLResponse("Version not found", status_code=404)

    procedure = db.query(MasterProcedure).filter(MasterProcedure.id == proc_id).first()

    # Generate QR code as data URI
    url = f"{request.base_url}procedures/{proc_id}/versions/{ver_id}"
    qr = segno.make(url)
    buf = io.BytesIO()
    qr.save(buf, kind="svg", scale=3, border=1)
    qr_data_uri = "data:image/svg+xml;base64," + base64.b64encode(buf.getvalue()).decode()

    # Get kit items for this procedure
    kit_items_raw = (
        db.query(Kit).join(Part).filter(Kit.procedure_id == proc_id).order_by(Part.name).all()
    )
    kit_items = [
        {
            "part_name": k.part.name,
            "part_pn": k.part.internal_pn,
            "quantity": float(k.quantity_required),
        }
        for k in kit_items_raw
    ]

    # Extract steps from version content
    steps = version.content.get("steps", [])

    return templates.TemplateResponse(
        "procedures/print_traveler.html",
        {
            "request": request,
            "procedure_name": version.content.get("procedure_name", procedure.name),
            "version_number": version.version_number,
            "description": version.content.get("procedure_description"),
            "published_at": version.created_at.strftime("%Y-%m-%dT%H:%M:%SZ")
            if version.created_at
            else "",
            "qr_data_uri": qr_data_uri,
            "kit_items": kit_items,
            "steps": steps,
        },
    )


@router.get("/procedures/versions/{version_id}", response_class=HTMLResponse)
def procedures_version_detail(request: Request, db: DbSession, version_id: int) -> HTMLResponse:
    """View a specific procedure version."""
    version = db.query(ProcedureVersion).filter(ProcedureVersion.id == version_id).first()
    if not version:
        return templates.TemplateResponse(
            "errors/404.html",
            {"request": request, "message": f"Version {version_id} not found"},
            status_code=404,
        )

    procedure = db.query(MasterProcedure).filter(MasterProcedure.id == version.procedure_id).first()

    # Get all versions for this procedure (for compare links)
    versions = (
        db.query(ProcedureVersion)
        .filter(ProcedureVersion.procedure_id == procedure.id)
        .order_by(ProcedureVersion.version_number.desc())
        .all()
    )

    context = get_base_context(request, db, f"v{version.version_number} - {procedure.name} - OPAL")
    context["version"] = version
    context["procedure"] = procedure
    context["versions"] = versions

    # Build hierarchical step structure from version content
    version_steps = version.content.get("steps", [])
    children_map: dict[int, list[dict]] = {}
    for step in version_steps:
        parent_id = step.get("parent_step_id")
        if parent_id is not None:
            children_map.setdefault(parent_id, []).append(step)

    ops: list[dict[str, Any]] = []
    contingency_ops: list[dict[str, Any]] = []
    for step in version_steps:
        if step.get("parent_step_id") is None:
            step_data = {
                "step": step,
                "sub_steps": sorted(
                    children_map.get(step.get("id"), []),
                    key=lambda s: s["order"],
                ),
            }
            if step.get("is_contingency"):
                contingency_ops.append(step_data)
            else:
                ops.append(step_data)

    context["ops"] = ops
    context["contingency_ops"] = contingency_ops

    # Resolve part names for kit/output items in snapshot
    part_ids: set[int] = set()
    for item in version.content.get("kit_items", []):
        part_ids.add(item["part_id"])
    for item in version.content.get("output_items", []):
        part_ids.add(item["part_id"])

    kit_parts: dict[int, dict[str, str]] = {}
    if part_ids:
        parts = db.query(Part).filter(Part.id.in_(part_ids)).all()
        kit_parts = {p.id: {"name": p.name, "internal_pn": p.internal_pn} for p in parts}
    context["kit_parts"] = kit_parts

    return templates.TemplateResponse("procedures/version_detail.html", context)


# ============ EXECUTION ============


@router.get("/executions", response_class=HTMLResponse)
def executions_list(request: Request, db: DbSession) -> HTMLResponse:
    """Procedure executions list page."""
    context = get_base_context(request, db, "Executions - OPAL")
    context["statuses"] = [s.value for s in InstanceStatus]

    # Get procedures for filter
    procedures = (
        db.query(MasterProcedure)
        .filter(MasterProcedure.deleted_at.is_(None))
        .order_by(MasterProcedure.name)
        .all()
    )
    context["procedures"] = procedures

    return templates.TemplateResponse("executions/list.html", context)


@router.get("/executions/table", response_class=HTMLResponse)
def executions_table(
    request: Request,
    db: DbSession,
    procedure_id: int | None = Query(None),
    status: str | None = Query(None),
    page: int = Query(1, ge=1),
) -> HTMLResponse:
    """Executions table rows (HTMX partial)."""
    from opal.db.models.execution import StepStatus

    # Aggregate step progress per instance and join the procedure/version
    # names so the table renders from a single query
    step_subq = (
        db.query(
            StepExecution.instance_id.label("instance_id"),
            func.count(StepExecution.id).label("total_steps"),
            func.sum(case((StepExecution.status == StepStatus.COMPLETED, 1), else_=0)).label(
                "completed_steps"
            ),
        )
        .group_by(StepExecution.instance_id)
        .subquery()
    )
    query = (
        db.query(
            ProcedureInstance,
            MasterProcedure.name.label("procedure_name"),
            ProcedureVersion.version_number,
            func.coalesce(step_subq.c.total_steps, 0).label("total_steps"),
            func.coalesce(step_subq.c.completed_steps, 0).label("completed_steps"),
        )
        .join(MasterProcedure, MasterProcedure.id == ProcedureInstance.procedure_id)
        .outerjoin(ProcedureVersion, ProcedureVersion.id == ProcedureInstance.version_id)
        .outerjoin(step_subq, step_subq.c.instance_id == ProcedureInstance.id)
    )

    if procedure_id:
        query = query.filter(ProcedureInstance.procedure_id == procedure_id)
    if status:
        query = query.filter(ProcedureInstance.status == status)

    rows, pagination = paginate_query(
        request, query.order_by(ProcedureInstance.id.desc()), page, colspan=6
    )

    instances_data = []
    for inst, procedure_name, version_number, total_steps, completed_steps in rows:
        status_val = inst.status.value if hasattr(inst.status, "value") else inst.status
        instances_data.append(
            {
                "id": inst.id,
                "procedure_name": procedure_name,
                "version_number": version_number or 0,
                "work_order": inst.work_order_number or "-",
                "status": status_val,
                "completed_steps": completed_steps,
                "total_steps": total_steps,
                "started_at": inst.started_at,
                "created_at": inst.created_at,
            }
        )

    return templates.TemplateResponse(
        "executions/table_rows.html",
        {"request": request, "instances": instances_data, "pagination": pagination},
    )


@router.get("/executions/new", response_class=HTMLResponse)
def executions_new(request: Request, db: DbSession) -> HTMLResponse:
    """Start new execution page."""
    context = get_base_context(request, db, "New Execution - OPAL")

    # Get active procedures with published versions
    procedures = (
        db.query(MasterProcedure)
        .filter(
            MasterProcedure.deleted_at.is_(None),
            MasterProcedure.current_version_id.isnot(None),
        )
        .order_by(MasterProcedure.name)
        .all()
    )
    context["procedures"] = [
        {"id": p.id, "name": p.name, "current_version_id": p.current_version_id} for p in procedures
    ]

    return templates.TemplateResponse("executions/new.html", context)


_EXECUTION_TABS = ("document", "data", "bom", "issues", "kitting")
# Old bookmarks/links: both dissolved tabs land on the document.
_EXECUTION_TAB_ALIASES = {"meta": "document", "operations": "document"}


def _execution_detail_context(
    request: Request,
    db: DbSession,
    instance: ProcedureInstance,
) -> dict:
    """Full context for the execution page and its partials (document rows,
    rail, docked bar). One builder — partial routes render fragments of the
    same facts."""
    version = db.query(ProcedureVersion).filter(ProcedureVersion.id == instance.version_id).first()

    context = get_base_context(request, db, f"{instance.work_order_number or 'Execution'} - OPAL")
    context["instance"] = instance
    context["version"] = version
    context["statuses"] = [s.value for s in InstanceStatus]

    # Build steps with execution status and organize hierarchically
    version_steps = version.content.get("steps", []) if version else []

    # Create a lookup for step executions by step order
    exec_lookup = {se.step_number: se for se in instance.step_executions}

    # Build step data with execution info
    def build_step_data(vs):
        step_exec = exec_lookup.get(vs["order"])
        return {
            "order": vs["order"],
            "step_number": vs.get("step_number", str(vs["order"])),
            "level": vs.get("level", 0),
            "parent_step_id": vs.get("parent_step_id"),
            "id": vs.get("id"),  # For linking sub-steps to parents
            "title": vs["title"],
            "instructions": vs.get("instructions"),
            "is_contingency": vs.get("is_contingency", False),
            "required_data_schema": vs.get("required_data_schema"),
            "execution": step_exec,
            "status": (
                step_exec.status.value
                if step_exec and hasattr(step_exec.status, "value")
                else (step_exec.status if step_exec else "pending")
            ),
        }

    all_steps = [build_step_data(vs) for vs in version_steps]
    context["steps"] = all_steps  # Flat list for backward compatibility

    # Organize into ops and sub-steps hierarchy
    ops = []  # Normal ops
    contingency_ops = []  # Contingency ops

    # Build lookup by step ID

    # Group sub-steps by parent
    children_map: dict[int, list] = {}
    for step in all_steps:
        parent_id = step.get("parent_step_id")
        if parent_id:
            if parent_id not in children_map:
                children_map[parent_id] = []
            children_map[parent_id].append(step)

    # Build hierarchical structure
    for step in all_steps:
        if step.get("parent_step_id") is None:  # Top-level op
            sub_steps = sorted(children_map.get(step.get("id"), []), key=lambda s: s["order"])
            # Calculate progress for this op
            total = len(sub_steps) if sub_steps else 1
            completed = (
                sum(1 for s in sub_steps if s["status"] in ["completed", "skipped"])
                if sub_steps
                else (1 if step["status"] in ["completed", "skipped"] else 0)
            )
            op_data = {
                "step": step,
                "sub_steps": sub_steps,
                "total_steps": total,
                "completed_steps": completed,
            }
            if step["is_contingency"]:
                contingency_ops.append(op_data)
            else:
                ops.append(op_data)

    # Sort ops
    def sort_key_normal(x):
        sn = x["step"].get("step_number", "0")
        return int(sn) if sn.isdigit() else 0

    def sort_key_contingency(x):
        return x["step"].get("step_number", "C0")

    ops.sort(key=sort_key_normal)
    contingency_ops.sort(key=sort_key_contingency)

    # Build redline op_data from ad-hoc StepExecution rows. These have no
    # corresponding snapshot entry — title/instructions live directly on the
    # row. Interleave them before their host op in the sidebar.
    redline_op_rows = [
        se for se in instance.step_executions if se.ad_hoc_issue_id is not None and se.level == 0
    ]
    redlines_by_host: dict[int, list] = {}
    if redline_op_rows:
        # Bulk-fetch the issues so we can show their issue_number / link.
        issue_ids = {se.ad_hoc_issue_id for se in redline_op_rows if se.ad_hoc_issue_id}
        issue_lookup = {i.id: i for i in db.query(Issue).filter(Issue.id.in_(issue_ids)).all()}
        for op_row in redline_op_rows:
            sub_rows = sorted(
                [s for s in instance.step_executions if s.parent_step_order == op_row.step_number],
                key=lambda s: s.step_number,
            )

            def _se_status(se):
                return se.status.value if hasattr(se.status, "value") else se.status

            sub_steps = [
                {
                    "order": s.step_number,
                    "step_number": s.step_number_str,
                    "level": s.level,
                    "parent_step_id": None,
                    "id": None,
                    "title": s.title or "",
                    "instructions": s.instructions,
                    "is_contingency": False,
                    "required_data_schema": s.required_data_schema,
                    "execution": s,
                    "status": _se_status(s),
                }
                for s in sub_rows
            ]
            total = len(sub_steps) if sub_steps else 1
            completed = (
                sum(1 for s in sub_steps if s["status"] in ["completed", "skipped"])
                if sub_steps
                else (1 if _se_status(op_row) in ["completed", "skipped"] else 0)
            )
            op_step = {
                "order": op_row.step_number,
                "step_number": op_row.step_number_str,
                "level": 0,
                "parent_step_id": None,
                "id": None,
                "title": op_row.title or "",
                "instructions": op_row.instructions,
                "is_contingency": False,
                "required_data_schema": op_row.required_data_schema,
                "execution": op_row,
                "status": _se_status(op_row),
                "is_ad_hoc": True,
                "ad_hoc_issue": issue_lookup.get(op_row.ad_hoc_issue_id),
                "ad_hoc_host_order": op_row.ad_hoc_host_order,
            }
            op_data = {
                "step": op_step,
                "sub_steps": sub_steps,
                "total_steps": total,
                "completed_steps": completed,
                "is_ad_hoc": True,
            }
            redlines_by_host.setdefault(op_row.ad_hoc_host_order, []).append(op_data)

    # Interleave: for each normal op, insert its redlines just before it.
    if redlines_by_host:
        interleaved: list = []
        for op_data in ops:
            host_order = op_data["step"].get("order")
            for r in redlines_by_host.get(host_order, []):
                interleaved.append(r)
            interleaved.append(op_data)
        ops = interleaved

    context["ops"] = ops
    context["contingency_ops"] = contingency_ops

    # Map step order -> version step data (for data capture schemas, requires_signoff)
    context["version_steps_map"] = {s["order"]: s for s in version_steps}

    # Get kit information
    from sqlalchemy.orm import joinedload

    kit_items = (
        db.query(Kit)
        .options(joinedload(Kit.part))
        .filter(Kit.procedure_id == instance.procedure_id)
        .all()
    )
    context["kit_items"] = kit_items

    # Get existing consumptions
    from opal.db.models.inventory import (
        InventoryConsumption,
        InventoryProduction,
    )
    from opal.db.models.procedure import ProcedureOutput

    consumptions = (
        db.query(InventoryConsumption)
        .options(joinedload(InventoryConsumption.inventory_record).joinedload(InventoryRecord.part))
        .filter(InventoryConsumption.procedure_instance_id == instance.id)
        .all()
    )
    context["consumptions"] = consumptions

    # Group consumptions by step execution ID for step-level display
    step_consumptions: dict[int, list] = {}
    for c in consumptions:
        if c.step_execution_id:
            step_consumptions.setdefault(c.step_execution_id, []).append(c)
    context["step_consumptions"] = step_consumptions

    # Step execution ID -> step number lookup
    step_exec_lookup = {
        se.id: se.step_number_str or str(se.step_number) for se in instance.step_executions
    }
    context["step_exec_lookup"] = step_exec_lookup

    # Get outputs (what this procedure produces)
    output_items = (
        db.query(ProcedureOutput)
        .filter(ProcedureOutput.procedure_id == instance.procedure_id)
        .all()
    )
    context["output_items"] = output_items

    # Get existing productions
    productions = (
        db.query(InventoryProduction)
        .options(joinedload(InventoryProduction.inventory_record).joinedload(InventoryRecord.part))
        .filter(InventoryProduction.procedure_instance_id == instance.id)
        .all()
    )
    context["productions"] = productions

    # BOM reconciliation data
    kit_items = context["kit_items"]
    consume_consumptions = [
        c
        for c in consumptions
        if (c.usage_type.value if hasattr(c.usage_type, "value") else c.usage_type) == "consume"
    ]
    consumed_by_part: dict[int, float] = {}
    for c in consume_consumptions:
        pid = c.inventory_record.part_id
        consumed_by_part[pid] = consumed_by_part.get(pid, 0) + float(c.quantity)

    bom_items = []
    for k in kit_items:
        qty_consumed = consumed_by_part.pop(k.part_id, 0)
        qty_required = float(k.quantity_required)
        bom_items.append(
            {
                "part_id": k.part_id,
                "part_pn": k.part.internal_pn,
                "part_name": k.part.name,
                "qty_required": qty_required,
                "qty_consumed": qty_consumed,
                "variance": qty_consumed - qty_required,
            }
        )
    # Unplanned consumptions (consumed but not in kit)
    unplanned = []
    for pid, qty in consumed_by_part.items():
        inv_c = next((c for c in consume_consumptions if c.inventory_record.part_id == pid), None)
        unplanned.append(
            {
                "part_id": pid,
                "part_pn": inv_c.inventory_record.part.internal_pn if inv_c else None,
                "part_name": inv_c.inventory_record.part.name if inv_c else "Unknown",
                "qty_consumed": qty,
            }
        )
    context["bom_items"] = bom_items
    context["unplanned_consumptions"] = unplanned

    # Material relevance (empty-state rule): declared intent decides where
    # content is expected; data always renders. Two predicates, one home each:
    # - kit_relevant (BOM tab): parts IN — a kit (procedure or step level) or
    #   actual consumptions. Reconciliation is meaningless without a kit side.
    # - material_relevant (KITTING tab): parts in OR out — the tab is also
    #   home to PRODUCTIONS and the FINALIZE PRODUCTION control, so an
    #   output-only procedure (ProcedureOutput, no kit) still shows it (F7);
    #   hiding it strands WIP productions with FINALIZE unreachable.
    kit_relevant = bool(
        kit_items
        or consumptions
        or any(vs.get("step_kit") for vs in context["version_steps_map"].values())
    )
    context["kit_relevant"] = kit_relevant
    context["material_relevant"] = kit_relevant or bool(productions or output_items)

    # Can finalize: instance completed + has WIP productions
    inst_status = instance.status.value if hasattr(instance.status, "value") else instance.status
    # Partials (_dockbar, _op_card, _rail) read inst_status from context —
    # only detail.html re-derives it with {% set %}.
    context["inst_status"] = inst_status
    has_wip = any(
        (p.status.value if hasattr(p.status, "value") else p.status) == "wip" for p in productions
    )
    context["can_finalize"] = inst_status == "completed" and has_wip

    # Linked issues — undispositioned holds sort first (rail ISSUES section)
    linked_issues = (
        db.query(Issue)
        .filter(
            Issue.procedure_instance_id == instance.id,
            Issue.deleted_at.is_(None),
        )
        .all()
    )
    disp_rank = {"undispositioned": 0, "open": 1, "dispositioned": 2, "closed": 3}
    linked_issues.sort(key=lambda i: (not i.is_blocking, disp_rank.get(i.disp_state, 4), -i.id))
    context["linked_issues"] = linked_issues

    # One authoritative answer per step execution for the COMPLETE and SKIP
    # controls: the full fold the server enforces (held scope + sequence for
    # COMPLETE; held scope + redline for SKIP), so a control never renders
    # active where the server would 400 it (F4/F5). Templates render the
    # controls from these — they do not re-derive gating. Keyed by
    # step_execution_id; a present, non-empty list means the control renders
    # inert (disabled) with the reason line beside it naming the blockers.
    complete_gate_by_se: dict[int, list[exec_flow.Blocker]] = {}
    skip_gate_by_se: dict[int, list[exec_flow.Blocker]] = {}
    for se in instance.step_executions:
        cg = exec_flow.complete_blockers(db, instance, se)
        if cg:
            complete_gate_by_se[se.id] = cg
        sg = exec_flow.skip_blockers(db, instance, se)
        if sg:
            skip_gate_by_se[se.id] = sg
    context["complete_gate_by_se"] = complete_gate_by_se
    context["skip_gate_by_se"] = skip_gate_by_se

    # Resolved-issue trace per step execution id: a dispositioned/closed issue
    # leaves a residual line on the step it was raised at — the hold clears,
    # the record stays.
    step_issue_history: dict[int, list[Issue]] = {}
    for iss in linked_issues:
        if iss.raised_step_id and iss.disp_state != "undispositioned":
            step_issue_history.setdefault(iss.raised_step_id, []).append(iss)
    context["step_issue_history"] = step_issue_history

    # Per-op aggregate of open NCs (op-level + any of its sub-steps) — the one
    # redline-visibility predicate: + REDLINE renders wherever this is
    # non-empty (step action rows and the dockbar overflow), and it populates
    # the modal's NC dropdown. Keyed by op.order; ad-hoc (redline) ops are
    # excluded below, so consumers never re-check is_ad_hoc.
    open_ncs_by_step_exec: dict[int, list[Issue]] = {}
    for iss in linked_issues:
        iss_type = iss.issue_type.value if hasattr(iss.issue_type, "value") else iss.issue_type
        iss_status = iss.status.value if hasattr(iss.status, "value") else iss.status
        if iss_type == "non_conformance" and iss.raised_step_id and iss_status != "closed":
            open_ncs_by_step_exec.setdefault(iss.raised_step_id, []).append(iss)
    open_ncs_by_op_order: dict[int, list[Issue]] = {}
    for op_data in ops + contingency_ops:
        op_step = op_data["step"]
        if op_data.get("is_ad_hoc"):
            continue
        op_exec = op_step.get("execution")
        bucket: list[Issue] = []
        if op_exec is not None:
            bucket.extend(open_ncs_by_step_exec.get(op_exec.id, []))
        for sub in op_data.get("sub_steps", []):
            sub_exec = sub.get("execution")
            if sub_exec is not None:
                bucket.extend(open_ncs_by_step_exec.get(sub_exec.id, []))
        if bucket:
            open_ncs_by_op_order[op_step["order"]] = bucket
    context["op_open_ncs_by_order"] = open_ncs_by_op_order

    # Gating lookup: top-level ops whose prerequisite ops haven't reached
    # a terminal status yet. Keyed by op.order → list of blocking step_number_str.
    exec_by_order = {se.step_number: se for se in instance.step_executions}
    gated_ops_by_order: dict[int, list[str]] = {}
    version_steps_for_gating = version.content.get("steps", []) if version else []
    for vs in version_steps_for_gating:
        if vs.get("level", 0) != 0:
            continue
        deps = vs.get("depends_on") or []
        if not deps:
            continue
        blockers: list[str] = []
        for dep_order in deps:
            prereq = exec_by_order.get(dep_order)
            if prereq is None:
                continue
            prereq_status = (
                prereq.status.value if hasattr(prereq.status, "value") else prereq.status
            )
            if prereq_status not in exec_flow.TERMINAL_STEP_STATUSES:
                blockers.append(prereq.step_number_str or str(dep_order))
        if blockers:
            gated_ops_by_order[vs["order"]] = blockers
    context["gated_ops_by_order"] = gated_ops_by_order

    # Reference documents on the procedure template (eng drawings, PDFs, etc.).
    from opal.db.models.attachment import Attachment as _Attachment

    context["reference_attachments"] = (
        db.query(_Attachment)
        .filter(
            _Attachment.procedure_id == instance.procedure_id,
            _Attachment.kind == "reference",
        )
        .order_by(_Attachment.original_filename.asc())
        .all()
    )

    # Meta tab extras: last-activity timestamp + flat data-capture audit rows.
    step_update_times = [
        se.updated_at for se in instance.step_executions if se.updated_at is not None
    ]
    candidate_times = [t for t in [instance.updated_at, *step_update_times] if t is not None]
    context["last_activity_at"] = max(candidate_times) if candidate_times else None

    data_rows = []
    for se in instance.step_executions:
        if not se.data_captured:
            continue
        step_num = se.step_number_str or str(se.step_number)
        by_name = se.completed_by_user.name if se.completed_by_user else None
        at = se.completed_at or se.updated_at
        for field, value in se.data_captured.items():
            if isinstance(value, bool):
                display = "YES" if value else "NO"
            elif value is None or value == "":
                display = "—"
            elif isinstance(value, list):
                # Multi-photo (and any future list-valued capture) — render
                # as "N image(s) (#12, #17)" rather than leaking the raw
                # storage format "[12, 17]" into the audit table.
                if value:
                    display = f"{len(value)} image(s) (" + ", ".join(f"#{v}" for v in value) + ")"
                else:
                    display = "—"
            else:
                display = str(value)
            data_rows.append(
                {
                    "step_number": step_num,
                    "step_sort": se.step_number,
                    "field": field,
                    "value": display,
                    "by": by_name,
                    "at": at,
                }
            )
    data_rows.sort(key=lambda r: (r["step_sort"], r["field"]))
    context["data_rows"] = data_rows

    # ---- Document layer: cursors, holds, evidence counts, presence ----

    cursors = exec_flow.instance_cursors(db, instance.id)
    cursor_user_ids = {c.user_id for c in cursors}
    cursor_users = (
        {u.id: u for u in db.query(User).filter(User.id.in_(cursor_user_ids)).all()}
        if cursor_user_ids
        else {}
    )
    cursors_by_se: dict[int, list[dict]] = {}
    for c in sorted(cursors, key=lambda c: c.focused_at):
        cursors_by_se.setdefault(c.step_execution_id, []).append(
            {"cursor": c, "user": cursor_users.get(c.user_id)}
        )
    context["cursors_by_se"] = cursors_by_se

    current_user = context.get("current_user")
    my_cursor = next((c for c in cursors if current_user and c.user_id == current_user.id), None)
    context["my_cursor_order"] = (
        my_cursor.step_execution.step_number
        if my_cursor is not None and my_cursor.step_execution is not None
        else None
    )

    # Bound hold points (issue_step_block) — hold COMPLETE of the bound step.
    bound_holds_by_se = exec_flow.bound_blocks_by_step(db, instance.id)
    context["bound_holds_by_se"] = bound_holds_by_se

    # Undispositioned NC holds per step execution id — derived from containment.
    holding_ncs_by_step = exec_flow.holding_ncs_by_step(db, instance.id)
    context["step_holding_ncs"] = holding_ncs_by_step

    # Undispositioned scope per op order — the op-card HELD BY blockline.
    # ONE derivation with the client updater (execdoc.js updateOpProgress):
    # raised/containment holds AND bound "resolve by" holds both fold in — a
    # bound hold on a child gates that child's COMPLETE, which holds the OP's
    # completion (check_instance_completion._row_held folds blockers_for_start),
    # so it belongs on the op header at SSR time too (F4).
    op_holds_by_order: dict[int, list] = {}
    for op_data in ops + contingency_ops:
        op_exec = op_data["step"].get("execution")
        bucket: list = []
        if op_exec is not None:
            bucket.extend(holding_ncs_by_step.get(op_exec.id, []))
            bucket.extend(bound_holds_by_se.get(op_exec.id, []))
        for sub in op_data.get("sub_steps", []):
            sub_exec = sub.get("execution")
            if sub_exec is not None:
                bucket.extend(holding_ncs_by_step.get(sub_exec.id, []))
                bucket.extend(bound_holds_by_se.get(sub_exec.id, []))
        seen_ids: set[int] = set()
        unique = [b for b in bucket if not (b.id in seen_ids or seen_ids.add(b.id))]
        if unique:
            op_holds_by_order[op_data["step"]["order"]] = unique
    context["op_holds_by_order"] = op_holds_by_order

    # strict_sequence display gating: sub-step N waits on its prior siblings.
    # Display-only — the claim API gate in core/execution_flow is authoritative.
    terminal = exec_flow.TERMINAL_STEP_STATUSES
    seq_blockers_by_order: dict[int, str] = {}
    for op_data in ops + contingency_ops:
        op_vs = context["version_steps_map"].get(op_data["step"]["order"]) or {}
        if not op_vs.get("strict_sequence"):
            continue
        for sub in op_data["sub_steps"]:
            if sub["status"] != "pending":
                continue
            unmet = [
                s["step_number"]
                for s in op_data["sub_steps"]
                if s["order"] < sub["order"] and s["status"] not in terminal
            ]
            if unmet:
                # The earliest unmet step is the one that matters; the rest
                # is a count, so a strict sequence never renders a pyramid.
                more = f" +{len(unmet) - 1}" if len(unmet) > 1 else ""
                seq_blockers_by_order[sub["order"]] = f"WAITING ON {unmet[0]}{more}"
    context["seq_blockers_by_order"] = seq_blockers_by_order

    # Evidence counts (⎙n) per step execution id.
    from opal.db.models.attachment import Attachment as _Att

    se_ids = [se.id for se in instance.step_executions]
    attach_counts: dict[int, int] = {}
    capture_attachments: dict[int, list] = {}
    if se_ids:
        for att in (
            db.query(_Att)
            .filter(_Att.step_execution_id.in_(se_ids))
            .order_by(_Att.created_at.desc())
            .all()
        ):
            attach_counts[att.step_execution_id] = attach_counts.get(att.step_execution_id, 0) + 1
            capture_attachments.setdefault(att.step_execution_id, []).append(att)
    context["attach_counts"] = attach_counts
    context["capture_attachments"] = capture_attachments

    # Step note trail per step execution id — chronological, append-only.
    context["step_notes_by_se"] = exec_flow.notes_by_step(db, se_ids)

    # Presence/progress snapshot for first paint; the page then polls /state.
    context["exec_state"] = exec_flow.build_execution_state(db, instance)

    # Active users for the issue capture's optional assignee.
    context["active_users"] = (
        db.query(User).filter(User.is_active.is_(True)).order_by(User.name.asc()).all()
    )

    return context


_BAR_ACTIONABLE = {"pending", "in_progress", "awaiting_signoff"}


def _set_bar_step(context: dict, step_order: int | None) -> None:
    """Resolve the docked bar's step: the requested order, else the session
    user's cursor, else the first actionable row of the document."""
    rows: list[tuple[dict, dict]] = []
    for op_data in context["ops"] + context["contingency_ops"]:
        rows.append((op_data, op_data["step"]))
        rows.extend((op_data, sub) for sub in op_data["sub_steps"])

    target = None
    if step_order is not None:
        target = next(((od, r) for od, r in rows if r["order"] == step_order), None)
    if target is None and context.get("my_cursor_order") is not None:
        target = next(((od, r) for od, r in rows if r["order"] == context["my_cursor_order"]), None)
    if target is None:
        leaf_rows = [(od, r) for od, r in rows if not od["sub_steps"] or r is not od["step"]]
        target = next(((od, r) for od, r in leaf_rows if r["status"] in _BAR_ACTIONABLE), None) or (
            leaf_rows[0] if leaf_rows else None
        )

    if target is None:
        context["bar_step"] = None
        return

    op_data, row = target
    vs = context["version_steps_map"].get(row["order"], {})
    is_op = row is op_data["step"]
    number = row["step_number"]
    if "." not in number and not is_op:
        number = f"{op_data['step']['step_number']}.{number}"
    context["bar_step"] = {
        "exec": row.get("execution"),
        "order": row["order"],
        "number": number,
        "title": row["title"],
        "status": row["status"],
        "is_op": is_op,
        "has_children": is_op and bool(op_data["sub_steps"]),
        "schema": row.get("required_data_schema") or vs.get("required_data_schema"),
        "caution": vs.get("caution"),
        "op_order": op_data["step"]["order"],
        "op_number": op_data["step"]["step_number"],
        "op_is_ad_hoc": bool(op_data.get("is_ad_hoc")),
        "op_open_ncs": (context.get("op_open_ncs_by_order") or {}).get(
            op_data["step"]["order"], []
        ),
        "step_kit": vs.get("step_kit") or [],
        # Single per-row gate answer (F4): the COMPLETE/SKIP controls render
        # from these, never re-derived in the template. Non-empty => control
        # inert (disabled), reason line beside it.
        "complete_blockers": (
            context.get("complete_gate_by_se", {}).get(row["execution"].id, [])
            if row.get("execution") is not None
            else []
        ),
        "skip_blockers": (
            context.get("skip_gate_by_se", {}).get(row["execution"].id, [])
            if row.get("execution") is not None
            else []
        ),
    }


@router.get("/executions/{instance_id}", response_class=HTMLResponse)
def executions_detail(
    request: Request,
    db: DbSession,
    instance_id: int,
    op: int | None = None,
    tab: str = "document",
) -> HTMLResponse:
    """Execution page — the multiplayer document."""
    instance = db.query(ProcedureInstance).filter(ProcedureInstance.id == instance_id).first()
    if not instance:
        return templates.TemplateResponse(
            "errors/404.html",
            {"request": request, "message": f"Execution {instance_id} not found"},
            status_code=404,
        )

    context = _execution_detail_context(request, db, instance)
    _set_bar_step(context, None)
    tab = _EXECUTION_TAB_ALIASES.get(tab, tab)
    context["tab"] = tab if tab in _EXECUTION_TABS else "document"
    return templates.TemplateResponse("executions/detail.html", context)


@router.get("/executions/{instance_id}/dockbar", response_class=HTMLResponse)
def executions_dockbar(
    request: Request, db: DbSession, instance_id: int, step: int | None = None
) -> HTMLResponse:
    """Docked bar partial for the focused step — refetched as focus moves."""
    instance = db.query(ProcedureInstance).filter(ProcedureInstance.id == instance_id).first()
    if not instance:
        return HTMLResponse("", status_code=404)
    context = _execution_detail_context(request, db, instance)
    _set_bar_step(context, step)
    return templates.TemplateResponse("executions/_dockbar.html", context)


@router.get("/executions/{instance_id}/rail", response_class=HTMLResponse)
def executions_rail(request: Request, db: DbSession, instance_id: int) -> HTMLResponse:
    """Rail partial (issues/holds, attachments, reference docs)."""
    instance = db.query(ProcedureInstance).filter(ProcedureInstance.id == instance_id).first()
    if not instance:
        return HTMLResponse("", status_code=404)
    context = _execution_detail_context(request, db, instance)
    return templates.TemplateResponse("executions/_rail.html", context)


@router.get("/executions/{instance_id}/step-row/{step_order}", response_class=HTMLResponse)
def executions_step_row(
    request: Request, db: DbSession, instance_id: int, step_order: int
) -> HTMLResponse:
    """One rendered step row — swapped in place when a step changes remotely
    (spatial stability: the row updates, the document never reflows)."""
    instance = db.query(ProcedureInstance).filter(ProcedureInstance.id == instance_id).first()
    if not instance:
        return HTMLResponse("", status_code=404)
    context = _execution_detail_context(request, db, instance)

    for op_data in context["ops"] + context["contingency_ops"]:
        if op_data["step"]["order"] == step_order and not op_data["sub_steps"]:
            context["op_data"] = op_data
            context["step"] = op_data["step"]
            context["row_is_op"] = True
            break
        for sub in op_data["sub_steps"]:
            if sub["order"] == step_order:
                context["op_data"] = op_data
                context["step"] = sub
                context["row_is_op"] = False
                break
        else:
            continue
        break
    else:
        return HTMLResponse("", status_code=404)

    return templates.TemplateResponse("executions/_step_row.html", context)


@router.get("/executions/{instance_id}/report", response_class=HTMLResponse)
def executions_report(request: Request, db: DbSession, instance_id: int) -> HTMLResponse:
    """Standalone, printable build report for a completed work order."""
    import base64
    import io
    from datetime import UTC, datetime

    import segno

    from opal.db.models.attachment import Attachment
    from opal.db.models.inventory import InventoryProduction
    from opal.db.models.procedure import ProcedureOutput

    instance = db.query(ProcedureInstance).filter(ProcedureInstance.id == instance_id).first()
    if not instance:
        return templates.TemplateResponse(
            "errors/404.html",
            {"request": request, "message": f"Execution {instance_id} not found"},
            status_code=404,
        )

    inst_status = instance.status.value if hasattr(instance.status, "value") else instance.status
    if inst_status != "completed":
        return HTMLResponse(
            f"<h1>Build report unavailable</h1>"
            f"<p>Work order is currently <b>{inst_status.upper()}</b>. "
            f"Reports are only generated for COMPLETED work orders.</p>"
            f'<p><a href="/executions/{instance_id}">Back to execution</a></p>',
            status_code=400,
        )

    version = db.query(ProcedureVersion).filter(ProcedureVersion.id == instance.version_id).first()
    procedure = (
        db.query(MasterProcedure).filter(MasterProcedure.id == instance.procedure_id).first()
    )

    # QR back to the execution detail page.
    url = f"{request.base_url}executions/{instance_id}"
    qr = segno.make(url)
    qr_buf = io.BytesIO()
    qr.save(qr_buf, kind="svg", scale=3, border=1)
    qr_data_uri = "data:image/svg+xml;base64," + base64.b64encode(qr_buf.getvalue()).decode()

    # End items: ProcedureOutput defines what this procedure produces; productions
    # are the actual produced units (serial + OPAL number).
    output_items = (
        db.query(ProcedureOutput)
        .filter(ProcedureOutput.procedure_id == instance.procedure_id)
        .all()
    )
    productions = (
        db.query(InventoryProduction)
        .filter(InventoryProduction.procedure_instance_id == instance_id)
        .all()
    )

    # Map step_number -> version step (for human-readable data labels).
    version_steps = version.content.get("steps", []) if version else []
    version_steps_by_order = {s["order"]: s for s in version_steps}

    # Sorted step executions for the operations table + data collects.
    step_execs = sorted(instance.step_executions, key=lambda se: se.step_number)

    def _se_status(se) -> str:
        return se.status.value if hasattr(se.status, "value") else se.status

    ops_summary = []
    for se in step_execs:
        vs = version_steps_by_order.get(se.step_number)
        title = se.title or (vs.get("title") if vs else None) or "(untitled)"
        ops_summary.append(
            {
                "step_number": se.step_number_str or str(se.step_number),
                "title": title,
                "status": _se_status(se),
                "started_at": se.started_at,
                "completed_at": se.completed_at,
                "operator": se.completed_by_user.name if se.completed_by_user else None,
                "signoff": se.signed_off_by_user.name if se.signed_off_by_user else None,
                "signoff_at": se.signed_off_at,
            }
        )

    # Data collects: per step, resolve field name -> human label from the schema.
    data_collects = []
    for se in step_execs:
        if not se.data_captured:
            continue
        vs = version_steps_by_order.get(se.step_number)
        schema = se.required_data_schema or (vs.get("required_data_schema") if vs else None) or {}
        field_defs = {f["name"]: f for f in schema.get("fields", []) if "name" in f}

        rows = []
        for field_name, value in se.data_captured.items():
            field_def = field_defs.get(field_name, {})
            label = field_def.get("label") or field_name
            unit = field_def.get("unit")
            if isinstance(value, bool):
                display = "YES" if value else "NO"
            elif value is None or value == "":
                display = "-"
            elif isinstance(value, list):
                if value:
                    display = f"{len(value)} image(s) (" + ", ".join(f"#{v}" for v in value) + ")"
                else:
                    display = "-"
            else:
                display = str(value)
            rows.append({"label": label, "value": display, "unit": unit})

        if rows:
            data_collects.append(
                {
                    "step_number": se.step_number_str or str(se.step_number),
                    "step_title": se.title or (vs.get("title") if vs else None) or "(untitled)",
                    "rows": rows,
                }
            )

    # Datasets with chart-enabled fields whose points are tied to this WO.
    step_exec_ids = {se.id for se in step_execs}
    chart_datasets: list[dict] = []
    if step_exec_ids:
        points = (
            db.query(DataPoint)
            .filter(DataPoint.step_execution_id.in_(step_exec_ids))
            .order_by(DataPoint.recorded_at.asc())
            .all()
        )
        points_by_ds: dict[int, list[DataPoint]] = {}
        for p in points:
            points_by_ds.setdefault(p.dataset_id, []).append(p)

        if points_by_ds:
            datasets = (
                db.query(Dataset)
                .filter(Dataset.id.in_(points_by_ds.keys()), Dataset.deleted_at.is_(None))
                .all()
            )
            for ds in datasets:
                fields = (ds.schema or {}).get("fields", []) or []
                chart_fields = [
                    f
                    for f in fields
                    if f.get("chart") is True and f.get("type") == "number" and f.get("name")
                ]
                if not chart_fields:
                    continue
                points_for_ds = points_by_ds.get(ds.id, [])
                points_json = [
                    {"recorded_at": p.recorded_at.isoformat(), "values": p.values}
                    for p in points_for_ds
                ]
                chart_datasets.append(
                    {
                        "dataset": ds,
                        "chart_fields": chart_fields,
                        "all_fields": fields,
                        "points": points_for_ds,
                        "points_json": points_json,
                    }
                )

    # Linked issues on this WO.
    issues = (
        db.query(Issue)
        .filter(Issue.procedure_instance_id == instance.id, Issue.deleted_at.is_(None))
        .order_by(Issue.created_at.asc())
        .all()
    )

    # Closeout photos only.
    closeout_attachments = (
        db.query(Attachment)
        .filter(
            Attachment.procedure_instance_id == instance.id,
            Attachment.kind == "closeout",
        )
        .order_by(Attachment.created_at.asc())
        .all()
    )

    return templates.TemplateResponse(
        "executions/report.html",
        {
            "request": request,
            "instance": instance,
            "version": version,
            "procedure": procedure,
            "qr_data_uri": qr_data_uri,
            "output_items": output_items,
            "productions": productions,
            "ops_summary": ops_summary,
            "data_collects": data_collects,
            "chart_datasets": chart_datasets,
            "issues": issues,
            "closeout_attachments": closeout_attachments,
            "generated_at": datetime.now(UTC),
        },
    )


# ============ ISSUES ============


@router.get("/issues", response_class=HTMLResponse)
def issues_list(request: Request, db: DbSession, state: str | None = Query(None)) -> HTMLResponse:
    """Issues list page. `?state=` deep-links a STATE filter preselection."""
    context = get_base_context(request, db, "Issues - OPAL")
    context["types"] = [t.value for t in IssueType]
    context["states"] = ["open", "undispositioned", "dispositioned", "closed"]
    context["priorities"] = [p.value for p in IssuePriority]
    context["state_selected"] = state if state in context["states"] else None
    return templates.TemplateResponse("issues/list.html", context)


ISSUE_TYPE_ABBREV = {
    "non_conformance": "NC",
    "bug": "BUG",
    "task": "TASK",
    "improvement": "IMPR",
}


@router.get("/issues/table", response_class=HTMLResponse)
def issues_table(
    request: Request,
    db: DbSession,
    search: str | None = Query(None),
    issue_type: str | None = Query(None),
    state: str | None = Query(None),
    priority: str | None = Query(None),
    page: int = Query(1, ge=1),
) -> HTMLResponse:
    """Issues table rows (HTMX partial)."""
    query = db.query(Issue).filter(Issue.deleted_at.is_(None))

    if search:
        search_term = f"%{search}%"
        query = query.filter(Issue.title.ilike(search_term))
    if issue_type:
        query = query.filter(Issue.issue_type == issue_type)
    if priority:
        query = query.filter(Issue.priority == priority)

    # Four-value STATE filter, matching what the column renders: open =
    # advisory-open; undispositioned / dispositioned = containment-bearing only.
    signed = (Issue.disposition_type.isnot(None)) & (Issue.dispositioned_at.isnot(None))
    bearing = Issue.containment != Containment.ADVISORY
    if state == "closed":
        query = query.filter(Issue.status == IssueStatus.CLOSED)
    elif state == "open":
        query = query.filter(
            Issue.status != IssueStatus.CLOSED, Issue.containment == Containment.ADVISORY
        )
    elif state == "dispositioned":
        query = query.filter(Issue.status != IssueStatus.CLOSED, bearing, signed)
    elif state == "undispositioned":
        query = query.filter(Issue.status != IssueStatus.CLOSED, bearing, ~signed)

    # Undispositioned-with-containment sorts first — the only warning-weight
    # on the page.
    blocking = (Issue.status != IssueStatus.CLOSED) & bearing & ~signed
    query = query.order_by(case((blocking, 0), else_=1), Issue.id.desc())

    issues, pagination = paginate_query(request, query, page, colspan=6)

    def get_val(obj, attr):
        val = getattr(obj, attr)
        return val.value if hasattr(val, "value") else val

    def age(dt: datetime) -> str:
        """Dense relative age for index rows; full ISO 8601 in the tooltip."""
        aware = dt.replace(tzinfo=UTC) if dt.tzinfo is None else dt
        delta = datetime.now(UTC) - aware
        if delta.days >= 1:
            return f"{delta.days}d"
        hours = delta.seconds // 3600
        if hours:
            return f"{hours}h"
        return f"{max(delta.seconds // 60, 0)}m"

    issues_data = [
        {
            "id": i.id,
            "issue_number": i.issue_number,
            "title": i.title,
            "issue_type": ISSUE_TYPE_ABBREV.get(get_val(i, "issue_type"), get_val(i, "issue_type")),
            "disp_state": i.disp_state,
            "priority": get_val(i, "priority"),
            "created_at": i.created_at,
            "age": age(i.created_at),
        }
        for i in issues
    ]

    return templates.TemplateResponse(
        "issues/table_rows.html",
        {"request": request, "issues": issues_data, "pagination": pagination},
    )


@router.get("/issues/new", response_class=HTMLResponse)
def issues_new(
    request: Request,
    db: DbSession,
    procedure_instance_id: int | None = Query(None),
    execution: int | None = Query(None),
) -> HTMLResponse:
    """New issue form page. Context pre-fill: ?execution= (or the older
    ?procedure_instance_id=) pre-selects the work-order link."""
    context = get_base_context(request, db, "New Issue - OPAL")
    context["types"] = [t.value for t in IssueType]
    context["priorities"] = [p.value for p in IssuePriority]
    context["containments"] = [c.value for c in Containment]
    context["procedure_instance_id"] = (
        procedure_instance_id if procedure_instance_id is not None else execution
    )

    # Get procedures, executions and users for linking (parts use the search
    # typeahead). The EXECUTION select mirrors the issue page's LINKS panel.
    procedures = (
        db.query(MasterProcedure)
        .filter(MasterProcedure.deleted_at.is_(None))
        .order_by(MasterProcedure.name)
        .all()
    )
    from opal.db.models.user import User

    users = db.query(User).filter(User.is_active == True).order_by(User.name).all()  # noqa: E712
    context["procedures"] = procedures
    context["instances"] = db.query(ProcedureInstance).order_by(ProcedureInstance.id.desc()).all()
    context["users"] = users

    return templates.TemplateResponse("issues/new.html", context)


@router.get("/issues/{issue_id}", response_class=HTMLResponse)
def issues_detail(
    request: Request, db: DbSession, issue_id: int, edit: bool = Query(False)
) -> HTMLResponse:
    """Issue detail page. Opens read-only; ?edit=1 renders the in-place
    editors, DONE returns to view."""
    issue = db.query(Issue).filter(Issue.id == issue_id, Issue.deleted_at.is_(None)).first()
    if not issue:
        return templates.TemplateResponse(
            "errors/404.html",
            {"request": request, "message": f"Issue {issue_id} not found"},
            status_code=404,
        )

    context = get_base_context(request, db, f"Issue {issue.issue_number} - OPAL")
    context["issue"] = issue
    context["editing"] = edit
    context["types"] = [t.value for t in IssueType]
    context["priorities"] = [p.value for p in IssuePriority]
    context["containments"] = [c.value for c in Containment]

    from opal.db.models.attachment import Attachment
    from opal.db.models.issue import DispositionType
    from opal.db.models.issue_comment import IssueComment
    from opal.db.models.user import User

    comments = (
        db.query(IssueComment)
        .filter(IssueComment.issue_id == issue.id)
        .order_by(IssueComment.created_at)
        .all()
    )
    attachments = db.query(Attachment).filter(Attachment.issue_id == issue.id).all()
    users = db.query(User).filter(User.is_active == True).order_by(User.name).all()  # noqa: E712

    context["comments"] = comments
    context["attachments"] = attachments
    context["users"] = users
    context["disposition_types"] = [d.value for d in DispositionType]
    # HOLDING — the consequence readout: what this issue is stopping.
    context["holding"] = holding_readout(db, issue)

    # Spawn-redline target: the op (level-0 order) hosting the raised step.
    redline_op_order = None
    if issue.raised_step is not None and issue.procedure_instance_id is not None:
        raised = issue.raised_step
        redline_op_order = raised.step_number if raised.level == 0 else raised.parent_step_order
    context["redline_op_order"] = redline_op_order

    # RAISED AT is scope-named, never a bare number ("OP 4" / "4.1").
    context["raised_at_label"] = scope_label(issue.raised_step) if issue.raised_step else None

    # Linking goes both directions: the LINKS panel can attach a work order
    # and a containment boundary step from the issue side.
    from opal.db.models.execution import StepExecution

    context["instances"] = db.query(ProcedureInstance).order_by(ProcedureInstance.id.desc()).all()
    instance_steps = []
    if issue.procedure_instance_id is not None:
        steps = (
            db.query(StepExecution)
            .filter(StepExecution.instance_id == issue.procedure_instance_id)
            .order_by(StepExecution.step_number)
            .all()
        )
        instance_steps = [{"id": s.id, "label": scope_label(s), "title": s.title} for s in steps]
    context["instance_steps"] = instance_steps
    context["containment_step_label"] = (
        scope_label(issue.containment_step) if issue.containment_step else None
    )

    return templates.TemplateResponse("issues/detail.html", context)


# ============ RISKS ============

#: Functional palette for disposition badges (ok.status variants).
DISPOSITION_BADGES: dict[str, str] = {
    "open": "draft",
    "mitigate": "warn",
    "watch": "info",
    "research": "info",
    "accepted": "ok",
    "closed": "ok",
    "realized": "error",
}


def _risk_or_404(db: DbSession, risk_id: int) -> Risk | None:
    return db.query(Risk).filter(Risk.id == risk_id, Risk.deleted_at.is_(None)).first()


@router.get("/risks", response_class=HTMLResponse)
def risks_list(request: Request, db: DbSession) -> HTMLResponse:
    """Risk register page."""
    context = get_base_context(request, db, "Risks - OPAL")
    context["dispositions"] = [d.value for d in RiskDisposition]
    return templates.TemplateResponse("risks/list.html", context)


@router.get("/risks/table", response_class=HTMLResponse)
def risks_table(
    request: Request,
    db: DbSession,
    search: str | None = Query(None),
    disposition: str | None = Query(None),
    severity: str | None = Query(None),
    page: int = Query(1, ge=1),
) -> HTMLResponse:
    """Risk register rows (HTMX partial)."""
    query = db.query(Risk).filter(Risk.deleted_at.is_(None))

    if search:
        search_term = f"%{search}%"
        query = query.filter(Risk.title.ilike(search_term) | Risk.risk_number.ilike(search_term))
    if disposition:
        query = query.filter(Risk.disposition == disposition)
    if severity:
        # Mirror Risk.severity thresholds in SQL so the filter applies before
        # pagination instead of only to the fetched page
        score = Risk.probability * Risk.impact
        if severity == "low":
            query = query.filter(score <= 5)
        elif severity == "medium":
            query = query.filter(score > 5, score <= 12)
        elif severity == "high":
            query = query.filter(score > 12)

    from sqlalchemy.orm import selectinload

    query = query.options(selectinload(Risk.owner))
    risks, pagination = paginate_query(request, query.order_by(Risk.id.desc()), page, colspan=6)

    rows = [
        {
            "risk": r,
            "reviewed_age": _relative_age(r.last_reviewed_at) if r.last_reviewed_at else "—",
            "reviewed_iso": r.last_reviewed_at.strftime("%Y-%m-%dT%H:%M:%SZ")
            if r.last_reviewed_at
            else "never reviewed",
        }
        for r in risks
    ]
    return templates.TemplateResponse(
        "risks/table_rows.html",
        {"request": request, "rows": rows, "pagination": pagination},
    )


@router.get("/risks/matrix", response_class=HTMLResponse)
def risks_matrix(request: Request, db: DbSession) -> HTMLResponse:
    """Risk matrix page — current (solid) and residual (hollow) markers."""

    context = get_base_context(request, db, "Risk Matrix - OPAL")

    risks = (
        db.query(Risk)
        .filter(Risk.deleted_at.is_(None))
        .filter(Risk.disposition.in_(OPEN_DISPOSITIONS))
        .all()
    )

    matrix = [[0 for _ in range(5)] for _ in range(5)]
    residual_matrix = [[0 for _ in range(5)] for _ in range(5)]
    for risk in risks:
        matrix[risk.probability - 1][risk.impact - 1] += 1
        if risk.residual_probability is not None and risk.residual_impact is not None:
            residual_matrix[risk.residual_probability - 1][risk.residual_impact - 1] += 1

    context["matrix"] = matrix
    context["residual_matrix"] = residual_matrix
    context["total_risks"] = len(risks)
    context["high_count"] = sum(1 for r in risks if r.severity == "high")
    context["medium_count"] = sum(1 for r in risks if r.severity == "medium")
    context["low_count"] = sum(1 for r in risks if r.severity == "low")

    # Rendered with | tojson in the template — json.dumps + | safe would let
    # a title containing </script> break out of the inline script block.
    context["risks_data"] = [
        {
            "id": r.id,
            "risk_number": r.risk_number,
            "title": r.title,
            "probability": r.probability,
            "impact": r.impact,
            "residual_probability": r.residual_probability,
            "residual_impact": r.residual_impact,
        }
        for r in risks
    ]

    return templates.TemplateResponse("risks/matrix.html", context)


@router.get("/risks/new", response_class=HTMLResponse)
def risks_new(request: Request, db: DbSession) -> HTMLResponse:
    """New risk form page — the four scenario phrases, never a paragraph."""
    context = get_base_context(request, db, "New Risk - OPAL")
    context["users"] = db.query(User).filter(User.is_active == True).order_by(User.name).all()  # noqa: E712
    context["parts"] = (
        db.query(Part).filter(Part.deleted_at.is_(None)).order_by(Part.name).limit(200).all()
    )
    return templates.TemplateResponse("risks/new.html", context)


@router.get("/risks/{risk_id}", response_class=HTMLResponse)
def risks_detail(
    request: Request, db: DbSession, risk_id: int, edit: bool = Query(False)
) -> HTMLResponse:
    """Risk detail page — the generated statement is the masthead. Opens
    read-only; ?edit=1 renders the in-place editors, DONE returns to view."""
    from opal.risks.lint import lint_risk_row
    from opal.risks.readiness import readiness
    from opal.web.lint_markup import statement_lint_html

    risk = _risk_or_404(db, risk_id)
    if not risk:
        return templates.TemplateResponse(
            "errors/404.html",
            {"request": request, "message": f"Risk {risk_id} not found"},
            status_code=404,
        )

    findings = lint_risk_row(risk)
    linked_issue_ids = [link.issue_id for link in risk.issue_links]

    parts = db.query(Part).filter(Part.deleted_at.is_(None)).order_by(Part.name).limit(200).all()
    # The dropdown is capped; the set asset must still render as selected.
    if risk.asset_part is not None and risk.asset_part not in parts:
        parts.append(risk.asset_part)

    context = get_base_context(request, db, f"{risk.risk_number} - OPAL")
    context["risk"] = risk
    context["editing"] = edit
    context["badge"] = DISPOSITION_BADGES.get(risk.disposition, "draft")
    context["dispositions"] = [d.value for d in RiskDisposition]
    context["roles"] = [r.value for r in RiskIssueRole]
    context["readiness"] = readiness(db, risk)
    context["lint_html"] = {
        field: statement_lint_html(getattr(risk, field) or "", field_findings)
        for field, field_findings in findings.items()
    }
    context["users"] = db.query(User).filter(User.is_active == True).order_by(User.name).all()  # noqa: E712
    context["parts"] = parts
    context["linkable_issues"] = (
        db.query(Issue)
        .filter(Issue.deleted_at.is_(None), Issue.id.notin_(linked_issue_ids))
        .order_by(Issue.id.desc())
        .limit(100)
        .all()
    )
    return templates.TemplateResponse("risks/detail.html", context)


@router.get("/risks/{risk_id}/acceptance-panel", response_class=HTMLResponse)
def risks_acceptance_panel(
    request: Request, db: DbSession, risk_id: int, edit: bool = Query(False)
) -> HTMLResponse:
    """Acceptance panel partial — re-fetched after field saves."""
    from opal.risks.readiness import readiness

    risk = _risk_or_404(db, risk_id)
    if not risk:
        return HTMLResponse("", status_code=404)
    return templates.TemplateResponse(
        "risks/_acceptance_panel.html",
        {
            "request": request,
            "risk": risk,
            "editing": edit,
            "readiness": readiness(db, risk),
            "current_user": _get_current_user(request, db),
        },
    )


@router.get("/risks/{risk_id}/disposition-panel", response_class=HTMLResponse)
def risks_disposition_panel(
    request: Request,
    db: DbSession,
    risk_id: int,
    target: str = Query(...),
) -> HTMLResponse:
    """Disposition panel partial for one target state.

    Per-disposition required fields are rendered only for the selected
    target — unselected dispositions' fields don't exist in the DOM.
    """
    from opal.risks.dispositions import disposition_blockers, open_links

    risk = _risk_or_404(db, risk_id)
    if not risk:
        return HTMLResponse("", status_code=404)
    # note="pending": the panel renders its own note input, so note-required
    # rules don't belong in the pre-flight blocker list — the POST enforces them.
    return templates.TemplateResponse(
        "risks/_disposition_panel.html",
        {
            "request": request,
            "risk": risk,
            "target": target,
            "blockers": disposition_blockers(db, risk, target, note="pending"),
            "open_mitigations": len(open_links(risk, RiskIssueRole.MITIGATION.value)),
            "open_research": len(open_links(risk, RiskIssueRole.RESEARCH.value)),
        },
    )


# ============ REQUIREMENTS ============


def _relative_age(dt) -> str:
    """Dense relative age ('2d') for index rows; full ISO 8601 goes in the tooltip."""
    if not dt:
        return "—"
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=UTC)
    seconds = (datetime.now(UTC) - dt).total_seconds()
    if seconds < 60:
        return "now"
    minutes = seconds / 60
    if minutes < 60:
        return f"{int(minutes)}m"
    hours = minutes / 60
    if hours < 24:
        return f"{int(hours)}h"
    days = hours / 24
    if days < 14:
        return f"{int(days)}d"
    if days < 60:
        return f"{int(days / 7)}w"
    if days < 365:
        return f"{int(days / 30)}mo"
    return f"{int(days / 365)}y"


def _requirement_tree(db: DbSession, root_id: int | None = None) -> tuple[list[dict], int]:
    """Nested node dicts for the tree page; orphans surface as roots.

    Mirrors the MCP _flowdown_tree children-map logic. Draft/preliminary rows
    get server-rendered lint underlines (regex lint over the full set is
    negligible at this scale). With root_id, returns that requirement's
    children subtrees (the dossier flow-down section).
    """
    from opal.db.base import LifecycleState
    from opal.db.models import PartRequirement
    from opal.se.lint import lint_statement
    from opal.web.lint_markup import statement_lint_html

    rows = (
        db.query(Requirement)
        .filter(
            Requirement.deleted_at.is_(None),
            Requirement.lifecycle_state != LifecycleState.SUPERSEDED.value,
        )
        .order_by(Requirement.req_number, Requirement.revision)
        .all()
    )
    ids = {r.id for r in rows}
    by_parent: dict[int | None, list[Requirement]] = {}
    for r in rows:
        effective_parent = r.parent_id if r.parent_id in ids else None
        by_parent.setdefault(effective_parent, []).append(r)

    alloc_map: dict[int, list[str]] = {}
    alloc_rows = (
        db.query(PartRequirement.requirement_ref_id, Part.name)
        .join(Part, PartRequirement.part_id == Part.id)
        .filter(PartRequirement.requirement_ref_id.isnot(None))
        .order_by(Part.name)
        .all()
    )
    for ref_id, part_name in alloc_rows:
        alloc_map.setdefault(ref_id, []).append(part_name)

    def node(r: Requirement, seen: frozenset[int]) -> dict:
        statement_html = None
        if r.is_mutable:
            statement_html = statement_lint_html(r.statement, lint_statement(r.statement))
        return {
            "req": r,
            "statement_html": statement_html,
            "alloc": alloc_map.get(r.id, []),
            "age": _relative_age(r.updated_at),
            "iso": r.updated_at.strftime("%Y-%m-%dT%H:%M:%SZ") if r.updated_at else "",
            "children": [
                node(c, seen | {r.id}) for c in by_parent.get(r.id, []) if c.id not in seen
            ],
        }

    if root_id is not None:
        children = [c for c in by_parent.get(root_id, [])]
        return [node(c, frozenset({root_id, c.id})) for c in children], len(rows)
    return [node(r, frozenset({r.id})) for r in by_parent.get(None, [])], len(rows)


@router.get("/requirements", response_class=HTMLResponse)
def requirements_tree(request: Request, db: DbSession) -> HTMLResponse:
    """Requirements tree — the front door for the spec."""
    from opal.db.base import LifecycleState
    from opal.se.readiness import ready_requirement_ids

    context = get_base_context(request, db, "Requirements - OPAL")
    context["tree"], context["total"] = _requirement_tree(db)
    context["states"] = [s.value for s in LifecycleState]
    context["queue_count"] = len(ready_requirement_ids(db))
    return templates.TemplateResponse("requirements/tree.html", context)


@router.get("/requirements/list", response_class=HTMLResponse)
def requirements_list(request: Request, db: DbSession) -> HTMLResponse:
    """Requirements list page (secondary lens; the tree is the front door)."""
    from opal.db.base import LifecycleState

    context = get_base_context(request, db, "Requirements - OPAL")
    context["states"] = [s.value for s in LifecycleState]
    return templates.TemplateResponse("requirements/list.html", context)


@router.get("/requirements/table", response_class=HTMLResponse)
def requirements_table(
    request: Request,
    db: DbSession,
    search: str | None = Query(None),
    state: str | None = Query(None),
    level: str | None = Query(None),
    show_superseded: str | None = Query(None),
) -> HTMLResponse:
    """Requirements table rows (HTMX partial).

    level is str: the filter selects submit level= (empty) for "all", which
    FastAPI rejects as int | None with a 422.
    """
    from opal.db.base import LifecycleState

    query = db.query(Requirement).filter(Requirement.deleted_at.is_(None))
    if not show_superseded:
        query = query.filter(Requirement.lifecycle_state != LifecycleState.SUPERSEDED.value)
    if state:
        query = query.filter(Requirement.lifecycle_state == state)
    if level and level.lstrip("-").isdigit():
        query = query.filter(Requirement.level == int(level))
    if search:
        term = f"%{search}%"
        query = query.filter(
            Requirement.req_number.ilike(term)
            | Requirement.title.ilike(term)
            | Requirement.statement.ilike(term)
        )

    requirements = query.order_by(Requirement.req_number, Requirement.revision).limit(200).all()
    return templates.TemplateResponse(
        "requirements/table_rows.html",
        {"request": request, "requirements": requirements},
    )


@router.get("/requirements/new", response_class=HTMLResponse)
def requirements_new(request: Request, db: DbSession) -> HTMLResponse:
    """New requirement form page."""
    from opal.db.base import LifecycleState

    context = get_base_context(request, db, "New Requirement - OPAL")
    context["parents"] = (
        db.query(Requirement)
        .filter(
            Requirement.deleted_at.is_(None),
            Requirement.lifecycle_state.notin_(
                [LifecycleState.SUPERSEDED.value, LifecycleState.CANCELLED.value]
            ),
        )
        .order_by(Requirement.req_number)
        .all()
    )
    return templates.TemplateResponse("requirements/new.html", context)


@router.get("/requirements/queue", response_class=HTMLResponse)
def requirements_queue(request: Request, db: DbSession) -> HTMLResponse:
    """Baseline queue review session — one ready requirement per screen."""
    from opal.db.models import PartRequirement
    from opal.se.readiness import ready_requirement_ids

    ids = ready_requirement_ids(db)
    rows = db.query(Requirement).filter(Requirement.id.in_(ids)).all() if ids else []
    rows.sort(key=lambda r: (r.level, r.req_number))
    by_id = {r.id: r for r in db.query(Requirement).filter(Requirement.deleted_at.is_(None))}

    def root_chain(r: Requirement) -> list[str]:
        chain: list[str] = []
        seen = {r.id}
        cursor = by_id.get(r.parent_id) if r.parent_id else None
        while cursor is not None and cursor.id not in seen:
            chain.append(f"{cursor.req_number} {cursor.title}")
            seen.add(cursor.id)
            cursor = by_id.get(cursor.parent_id) if cursor.parent_id else None
        return list(reversed(chain))

    items = []
    for r in rows:
        children_count = (
            db.query(Requirement)
            .filter(Requirement.parent_id == r.id, Requirement.deleted_at.is_(None))
            .count()
        )
        alloc = (
            db.query(Part.name)
            .join(PartRequirement, PartRequirement.part_id == Part.id)
            .filter(PartRequirement.requirement_ref_id == r.id)
            .all()
        )
        items.append(
            {
                "id": r.id,
                "req_number": r.req_number,
                "revision": r.revision,
                "title": r.title,
                "statement": r.statement,
                "rationale": r.rationale or "",
                "level": r.level,
                "verification_method": r.verification_method or "—",
                "children_count": children_count,
                "allocated": [name for (name,) in alloc],
                "root_chain": root_chain(r),
            }
        )

    context = get_base_context(request, db, "Baseline Queue - OPAL")
    context["queue_items"] = items
    return templates.TemplateResponse("requirements/queue.html", context)


@router.get("/requirements/baselines", response_class=HTMLResponse)
def requirements_baselines(request: Request, db: DbSession) -> HTMLResponse:
    """Baseline events history, newest first."""
    from opal.db.models import BaselineEvent

    events = db.query(BaselineEvent).order_by(BaselineEvent.created_at.desc()).all()
    context = get_base_context(request, db, "Baselines - OPAL")
    context["events"] = events
    return templates.TemplateResponse("requirements/baselines.html", context)


@router.get("/requirements/baselines/{event_id}", response_class=HTMLResponse)
def requirements_baseline_event(request: Request, db: DbSession, event_id: int) -> HTMLResponse:
    """One baseline event: the locked revision set."""
    from opal.db.models import BaselineEvent

    event = db.query(BaselineEvent).filter(BaselineEvent.id == event_id).first()
    if not event:
        return templates.TemplateResponse(
            "errors/404.html",
            {"request": request, "message": f"Baseline event {event_id} not found"},
            status_code=404,
        )
    context = get_base_context(request, db, f"Baseline event {event_id} - OPAL")
    context["event"] = event
    return templates.TemplateResponse("requirements/baseline_event.html", context)


@router.get("/requirements/{req_id}", response_class=HTMLResponse)
def requirements_detail(request: Request, db: DbSession, req_id: int) -> HTMLResponse:
    """Requirement detail page."""
    from opal.db.models import PartRequirement

    req = (
        db.query(Requirement)
        .filter(Requirement.id == req_id, Requirement.deleted_at.is_(None))
        .first()
    )
    if not req:
        return templates.TemplateResponse(
            "errors/404.html",
            {"request": request, "message": f"Requirement {req_id} not found"},
            status_code=404,
        )

    from opal.se.readiness import readiness

    context = get_base_context(request, db, f"{req.req_number} - OPAL")
    context["req"] = req
    context["parent"] = req.parent

    # Breadcrumb chain up to the L0 root, root first; cycle-guarded.
    chain: list[Requirement] = []
    seen: set[int] = {req.id}
    cursor = req.parent
    while cursor is not None and cursor.id not in seen:
        chain.append(cursor)
        seen.add(cursor.id)
        cursor = cursor.parent
    context["parent_chain"] = list(reversed(chain))

    context["baselined_by"] = (
        db.query(User).filter(User.id == req.baselined_by_id).first()
        if req.baselined_by_id
        else None
    )
    context["children_nodes"], _ = _requirement_tree(db, root_id=req.id)
    context["readiness"] = readiness(db, req)
    context["allocations"] = (
        db.query(PartRequirement).filter(PartRequirement.requirement_ref_id == req.id).all()
    )
    context["revisions"] = (
        db.query(Requirement)
        .filter(Requirement.req_number == req.req_number, Requirement.deleted_at.is_(None))
        .order_by(Requirement.revision)
        .all()
    )
    return templates.TemplateResponse("requirements/detail.html", context)


@router.get("/requirements/{req_id}/redline", response_class=HTMLResponse)
def requirements_redline(
    request: Request,
    db: DbSession,
    req_id: int,
    rev_a: int | None = Query(None),
    rev_b: int | None = Query(None),
) -> HTMLResponse:
    """Word-diff partial between two revisions of this requirement's number.

    Defaults to this revision vs the one it supersedes.
    """
    from opal.se.redline import redline_html

    req = (
        db.query(Requirement)
        .filter(Requirement.id == req_id, Requirement.deleted_at.is_(None))
        .first()
    )
    if not req:
        return HTMLResponse("", status_code=404)

    revisions = {
        r.revision: r
        for r in db.query(Requirement)
        .filter(Requirement.req_number == req.req_number, Requirement.deleted_at.is_(None))
        .all()
    }
    if rev_b is None:
        rev_b = req.revision
    if rev_a is None:
        predecessor = db.get(Requirement, req.supersedes_id) if req.supersedes_id else None
        rev_a = predecessor.revision if predecessor else rev_b
    old = revisions.get(rev_a)
    new = revisions.get(rev_b)
    if not old or not new:
        return HTMLResponse(
            '<div class="text-muted mono">revision not found</div>', status_code=404
        )
    return templates.TemplateResponse(
        "requirements/_redline.html",
        {
            "request": request,
            "rev_a": old,
            "rev_b": new,
            "statement_diff": redline_html(old.statement, new.statement),
            "rationale_diff": redline_html(old.rationale or "", new.rationale or ""),
        },
    )


@router.get("/requirements/{req_id}/baseline-panel", response_class=HTMLResponse)
def requirements_baseline_panel(request: Request, db: DbSession, req_id: int) -> HTMLResponse:
    """Baseline panel partial — re-fetched by the dossier after field saves."""
    from opal.se.readiness import readiness

    req = (
        db.query(Requirement)
        .filter(Requirement.id == req_id, Requirement.deleted_at.is_(None))
        .first()
    )
    if not req:
        return HTMLResponse("", status_code=404)
    return templates.TemplateResponse(
        "requirements/_baseline_panel.html",
        {
            "request": request,
            "req": req,
            "readiness": readiness(db, req),
            "current_user": _get_current_user(request, db),
        },
    )


# ============ DATASETS ============


@router.get("/datasets", response_class=HTMLResponse)
def datasets_list(request: Request, db: DbSession) -> HTMLResponse:
    """Datasets list page."""
    context = get_base_context(request, db, "Datasets - OPAL")

    # Get procedures for filter
    procedures = (
        db.query(MasterProcedure)
        .filter(MasterProcedure.deleted_at.is_(None))
        .order_by(MasterProcedure.name)
        .all()
    )
    context["procedures"] = procedures

    return templates.TemplateResponse("datasets/list.html", context)


@router.get("/datasets/table", response_class=HTMLResponse)
def datasets_table(
    request: Request,
    db: DbSession,
    search: str | None = Query(None),
    procedure_id: int | None = Query(None),
    page: int = Query(1, ge=1),
) -> HTMLResponse:
    """Datasets table rows (HTMX partial)."""
    query = db.query(Dataset).filter(Dataset.deleted_at.is_(None))

    if search:
        search_term = f"%{search}%"
        query = query.filter(Dataset.name.ilike(search_term))
    if procedure_id:
        query = query.filter(Dataset.procedure_id == procedure_id)

    datasets, pagination = paginate_query(
        request, query.order_by(Dataset.id.desc()), page, colspan=5
    )

    return templates.TemplateResponse(
        "datasets/table_rows.html",
        {"request": request, "datasets": datasets, "pagination": pagination},
    )


@router.get("/datasets/new", response_class=HTMLResponse)
def datasets_new(request: Request, db: DbSession) -> HTMLResponse:
    """New dataset form page."""
    context = get_base_context(request, db, "New Dataset - OPAL")

    # Get procedures for linking
    procedures = (
        db.query(MasterProcedure)
        .filter(MasterProcedure.deleted_at.is_(None))
        .order_by(MasterProcedure.name)
        .all()
    )
    context["procedures"] = procedures

    return templates.TemplateResponse("datasets/new.html", context)


@router.get("/datasets/{dataset_id}", response_class=HTMLResponse)
def datasets_detail(request: Request, db: DbSession, dataset_id: int) -> HTMLResponse:
    """Dataset detail page with chart."""

    dataset = (
        db.query(Dataset).filter(Dataset.id == dataset_id, Dataset.deleted_at.is_(None)).first()
    )
    if not dataset:
        return templates.TemplateResponse(
            "errors/404.html",
            {"request": request, "message": f"Dataset {dataset_id} not found"},
            status_code=404,
        )

    context = get_base_context(request, db, f"{dataset.name} - OPAL")
    context["dataset"] = dataset

    # Get data points
    data_points = (
        db.query(DataPoint)
        .filter(DataPoint.dataset_id == dataset_id)
        .order_by(DataPoint.recorded_at.asc())
        .limit(1000)
        .all()
    )
    context["data_points"] = data_points

    # Chart payload. Rendered in the template via the `tojson` filter, which
    # HTML-escapes `<`, `>`, `&` — never `json.dumps` + `| safe`, which would
    # let a data point's `values` break out of the <script> block (stored XSS).
    context["data_points_json"] = [
        {
            "id": p.id,
            "recorded_at": p.recorded_at.isoformat(),
            "values": p.values,
        }
        for p in data_points
    ]

    return templates.TemplateResponse("datasets/detail.html", context)


# ============ SUPPLIERS ============


@router.get("/suppliers", response_class=HTMLResponse)
def suppliers_list(request: Request, db: DbSession) -> HTMLResponse:
    """Suppliers list page."""
    context = get_base_context(request, db, "Suppliers - OPAL")
    return templates.TemplateResponse("suppliers/list.html", context)


@router.get("/suppliers/table", response_class=HTMLResponse)
def suppliers_table(
    request: Request,
    db: DbSession,
    search: str | None = None,
    is_active: str | None = None,
    page: int = Query(1, ge=1),
) -> HTMLResponse:
    """Suppliers table rows (HTMX partial)."""
    # Join purchase counts in one query instead of lazy-loading each
    # supplier's purchases just to count them
    purchase_count_subq = (
        db.query(
            Purchase.supplier_id.label("supplier_id"),
            func.count(Purchase.id).label("purchase_count"),
        )
        .group_by(Purchase.supplier_id)
        .subquery()
    )
    query = (
        db.query(Supplier, func.coalesce(purchase_count_subq.c.purchase_count, 0))
        .outerjoin(purchase_count_subq, purchase_count_subq.c.supplier_id == Supplier.id)
        .filter(Supplier.deleted_at.is_(None))
    )

    if search:
        search_term = f"%{search}%"
        query = query.filter(
            or_(
                Supplier.name.ilike(search_term),
                Supplier.code.ilike(search_term),
                Supplier.email.ilike(search_term),
            )
        )

    if is_active == "true":
        query = query.filter(Supplier.is_active == True)  # noqa: E712
    elif is_active == "false":
        query = query.filter(Supplier.is_active == False)  # noqa: E712

    rows, pagination = paginate_query(request, query.order_by(Supplier.name), page, colspan=7)

    supplier_data = []
    for s, purchase_count in rows:
        supplier_data.append(
            {
                "id": s.id,
                "code": s.code,
                "name": s.name,
                "email": s.email,
                "phone": s.phone,
                "is_active": s.is_active,
                "purchase_count": purchase_count,
            }
        )

    return templates.TemplateResponse(
        "suppliers/table_rows.html",
        {"request": request, "suppliers": supplier_data, "pagination": pagination},
    )


@router.get("/suppliers/new", response_class=HTMLResponse)
def suppliers_new(request: Request, db: DbSession) -> HTMLResponse:
    """New supplier form page."""
    context = get_base_context(request, db, "New Supplier - OPAL")
    return templates.TemplateResponse("suppliers/new.html", context)


@router.get("/suppliers/{supplier_id}", response_class=HTMLResponse)
def suppliers_detail(request: Request, db: DbSession, supplier_id: int) -> HTMLResponse:
    """Supplier detail page."""
    supplier = (
        db.query(Supplier).filter(Supplier.id == supplier_id, Supplier.deleted_at.is_(None)).first()
    )
    if not supplier:
        return templates.TemplateResponse(
            "errors/404.html",
            {"request": request, "message": f"Supplier {supplier_id} not found"},
            status_code=404,
        )

    context = get_base_context(request, db, f"{supplier.name} - OPAL")
    context["supplier"] = supplier
    context["purchases"] = supplier.purchases
    context["catalog_entries"] = [
        sp for sp in supplier.catalog_entries if sp.part.deleted_at is None
    ]

    return templates.TemplateResponse("suppliers/detail.html", context)


@router.get("/suppliers/{supplier_id}/edit", response_class=HTMLResponse)
def suppliers_edit(request: Request, db: DbSession, supplier_id: int) -> HTMLResponse:
    """Supplier edit page."""
    supplier = (
        db.query(Supplier).filter(Supplier.id == supplier_id, Supplier.deleted_at.is_(None)).first()
    )
    if not supplier:
        return templates.TemplateResponse(
            "errors/404.html",
            {"request": request, "message": f"Supplier {supplier_id} not found"},
            status_code=404,
        )

    context = get_base_context(request, db, f"Edit {supplier.name} - OPAL")
    context["supplier"] = supplier

    return templates.TemplateResponse("suppliers/edit.html", context)


# ============ WORKCENTERS ============


@router.get("/workcenters", response_class=HTMLResponse)
def workcenters_list(request: Request, db: DbSession) -> HTMLResponse:
    """Workcenters list page."""
    context = get_base_context(request, db, "Workcenters - OPAL")
    return templates.TemplateResponse("workcenters/list.html", context)


@router.get("/workcenters/table", response_class=HTMLResponse)
def workcenters_table(
    request: Request,
    db: DbSession,
    search: str | None = None,
    is_active: str | None = None,
    page: int = Query(1, ge=1),
) -> HTMLResponse:
    """Workcenters table rows (HTMX partial)."""
    query = db.query(Workcenter)

    if search:
        search_term = f"%{search}%"
        query = query.filter(
            or_(
                Workcenter.name.ilike(search_term),
                Workcenter.code.ilike(search_term),
                Workcenter.location.ilike(search_term),
            )
        )

    if is_active == "true":
        query = query.filter(Workcenter.is_active == True)  # noqa: E712
    elif is_active == "false":
        query = query.filter(Workcenter.is_active == False)  # noqa: E712

    workcenters, pagination = paginate_query(
        request, query.order_by(Workcenter.code), page, colspan=5
    )

    return templates.TemplateResponse(
        "workcenters/table_rows.html",
        {"request": request, "workcenters": workcenters, "pagination": pagination},
    )


@router.get("/workcenters/new", response_class=HTMLResponse)
def workcenters_new(request: Request, db: DbSession) -> HTMLResponse:
    """New workcenter form page."""
    context = get_base_context(request, db, "New Workcenter - OPAL")
    return templates.TemplateResponse("workcenters/new.html", context)


@router.get("/workcenters/{workcenter_id}", response_class=HTMLResponse)
def workcenters_detail(request: Request, db: DbSession, workcenter_id: int) -> HTMLResponse:
    """Workcenter detail page."""
    workcenter = db.query(Workcenter).filter(Workcenter.id == workcenter_id).first()
    if not workcenter:
        return templates.TemplateResponse(
            "errors/404.html",
            {"request": request, "message": f"Workcenter {workcenter_id} not found"},
            status_code=404,
        )

    context = get_base_context(request, db, f"{workcenter.code} - OPAL")
    context["workcenter"] = workcenter

    return templates.TemplateResponse("workcenters/detail.html", context)


@router.get("/workcenters/{workcenter_id}/edit", response_class=HTMLResponse)
def workcenters_edit(request: Request, db: DbSession, workcenter_id: int) -> HTMLResponse:
    """Workcenter edit page."""
    workcenter = db.query(Workcenter).filter(Workcenter.id == workcenter_id).first()
    if not workcenter:
        return templates.TemplateResponse(
            "errors/404.html",
            {"request": request, "message": f"Workcenter {workcenter_id} not found"},
            status_code=404,
        )

    context = get_base_context(request, db, f"Edit {workcenter.code} - OPAL")
    context["workcenter"] = workcenter

    return templates.TemplateResponse("workcenters/edit.html", context)


# ============ USERS ============


@router.get("/users")
def users_list(request: Request, db: DbSession):
    """Redirect to settings page (user management is now on /settings)."""
    return RedirectResponse(url="/settings", status_code=302)


@router.get("/users/table", response_class=HTMLResponse)
def users_table(
    request: Request,
    db: DbSession,
    search: str | None = None,
    is_active: str | None = None,
    page: int = Query(1, ge=1),
) -> HTMLResponse:
    """Users table rows (HTMX partial)."""
    query = db.query(User)

    if search:
        search_term = f"%{search}%"
        query = query.filter(
            or_(
                User.name.ilike(search_term),
                User.email.ilike(search_term),
            )
        )

    if is_active == "true":
        query = query.filter(User.is_active == True)  # noqa: E712
    elif is_active == "false":
        query = query.filter(User.is_active == False)  # noqa: E712

    users, pagination = paginate_query(request, query.order_by(User.name), page, colspan=6)

    return templates.TemplateResponse(
        "users/table_rows.html",
        {"request": request, "users_list": users, "pagination": pagination},
    )


@router.get("/users/new", response_class=HTMLResponse)
def users_new(request: Request, db: DbSession) -> HTMLResponse:
    """New user form page. Admin only."""
    redirect = _require_admin_web(request, db)
    if redirect:
        return redirect
    context = get_base_context(request, db, "New User - OPAL")
    return templates.TemplateResponse("users/new.html", context)


@router.get("/users/{user_id}", response_class=HTMLResponse)
def users_detail(request: Request, db: DbSession, user_id: int) -> HTMLResponse:
    """User detail page. Self-view for all, admin can view anyone."""
    current_user = _get_current_user(request, db)
    is_own_profile = current_user and current_user.id == user_id

    # Non-admins can only view their own profile
    if not is_own_profile and (not current_user or not current_user.is_admin):
        return RedirectResponse(url="/", status_code=302)

    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        return templates.TemplateResponse(
            "errors/404.html",
            {"request": request, "message": f"User {user_id} not found"},
            status_code=404,
        )

    context = get_base_context(request, db, f"{user.name} - OPAL")
    context["user"] = user
    context["is_own_profile"] = is_own_profile
    # An admin viewing a passwordless account can hand its owner an out-of-band
    # claim link (self-claim from the login form was removed — see /claim).
    context["user_needs_claim"] = bool(
        current_user
        and current_user.is_admin
        and not is_own_profile
        and user.is_active
        and user.password_hash is None
    )

    return templates.TemplateResponse("users/detail.html", context)


@router.get("/users/{user_id}/edit", response_class=HTMLResponse)
def users_edit(request: Request, db: DbSession, user_id: int) -> HTMLResponse:
    """User edit page. Self-edit for all, admin can edit anyone."""
    current_user = _get_current_user(request, db)
    is_own_profile = current_user and current_user.id == user_id

    # Non-admins can only edit their own profile
    if not is_own_profile and (not current_user or not current_user.is_admin):
        return RedirectResponse(url="/", status_code=302)

    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        return templates.TemplateResponse(
            "errors/404.html",
            {"request": request, "message": f"User {user_id} not found"},
            status_code=404,
        )

    context = get_base_context(request, db, f"Edit {user.name} - OPAL")
    context["user"] = user

    return templates.TemplateResponse("users/edit.html", context)


_CLAIM_LINK_TTL = timedelta(days=7)


@router.post("/users/{user_id}/claim-link", response_class=HTMLResponse)
def users_issue_claim_link(request: Request, db: DbSession, user_id: int) -> HTMLResponse:
    """Mint an out-of-band account-claim link for a passwordless user. Admin only.

    Replaces trust-on-first-use claiming: instead of letting whoever reaches
    the login form seize a migrated account, an admin generates this
    time-limited link and delivers it to the real person over a trusted
    channel. Valid only while the target account still has no password.
    """
    if _require_admin_web(request, db) is not None:
        return HTMLResponse("Forbidden", status_code=403)
    user = db.query(User).filter(User.id == user_id).first()
    if user is None:
        return HTMLResponse("User not found", status_code=404)
    if not user.is_active or user.password_hash is not None:
        return HTMLResponse(
            '<div class="text-muted mono" style="font-size:0.75rem;">'
            "This account already has a password — no claim link is needed.</div>",
            status_code=400,
        )
    token = sign_payload({"kind": "account-claim", "uid": user.id}, max_age=_CLAIM_LINK_TTL)
    claim_url = f"{request.base_url}claim?token={token}"
    expires_at = datetime.now(UTC) + _CLAIM_LINK_TTL
    return templates.TemplateResponse(
        "users/_claim_link.html",
        {"request": request, "claim_url": claim_url, "expires_at": expires_at},
    )


# ============ LABEL PRINT ============


@router.get("/label", response_class=HTMLResponse)
def label_print(
    request: Request,
    db: DbSession,
    type: str = Query(...),
    id: int = Query(...),
) -> HTMLResponse:
    """Print label with QR code for a part or inventory record."""
    if type == "inventory":
        record = (
            db.query(InventoryRecord)
            .join(Part)
            .filter(InventoryRecord.id == id, Part.deleted_at.is_(None))
            .first()
        )
        if not record:
            return HTMLResponse("Not found", status_code=404)
        return templates.TemplateResponse(
            "label_print.html",
            {
                "request": request,
                "entity_type": "inventory",
                "entity_id": record.id,
                "identifier": record.opal_number or f"INV-{record.id}",
                "name": record.part.name,
                "location": record.location,
            },
        )
    elif type == "part":
        from opal.config import get_active_project

        part = db.query(Part).filter(Part.id == id, Part.deleted_at.is_(None)).first()
        if not part:
            return HTMLResponse("Not found", status_code=404)
        # The label IS the tag component in print mode — one identity,
        # one rendering, everywhere
        project = get_active_project()
        tier_config = project.get_tier(part.tier) if project else None
        return templates.TemplateResponse(
            "parts/label.html",
            {
                "request": request,
                "part": part,
                "tier_name": tier_config.name if tier_config else None,
                "pn_segments": _pn_segments(
                    part.internal_pn, tier_config.code if tier_config else str(part.tier)
                ),
            },
        )
    return HTMLResponse("Invalid type", status_code=400)


# ============ DOCUMENTATION ============


@router.get("/docs", response_class=HTMLResponse)
def docs(request: Request, db: DbSession) -> HTMLResponse:
    """Documentation page."""
    context = get_base_context(request, db, "Documentation - OPAL")
    return templates.TemplateResponse("docs.html", context)


# ============ PROJECT CONFIGURATION ============


@router.get("/project/new", response_class=HTMLResponse)
def project_new(request: Request, db: DbSession) -> HTMLResponse:
    """New project wizard page. Admin only."""
    redirect = _require_admin_web(request, db)
    if redirect:
        return redirect

    context = get_base_context(request, db, "New Project - OPAL")
    context["existing_config"] = None
    context["tiers"] = DEFAULT_TIERS
    context["categories"] = []

    return templates.TemplateResponse("project/wizard.html", context)


@router.get("/project/edit", response_class=HTMLResponse)
def project_edit(request: Request, db: DbSession) -> HTMLResponse:
    """Edit existing project configuration. Admin only."""
    from opal.config import get_active_project

    redirect = _require_admin_web(request, db)
    if redirect:
        return redirect

    project = get_active_project()
    if not project:
        # No existing project, redirect to new
        return RedirectResponse(url="/project/new", status_code=302)

    context = get_base_context(request, db, "Edit Project - OPAL")
    context["existing_config"] = project
    context["tiers"] = project.tiers
    context["categories"] = project.categories

    return templates.TemplateResponse("project/wizard.html", context)


# ============ SETTINGS ============


def _human_bytes(value: int) -> str:
    """Size limits, rendered the way the settings tables show them."""
    if value < 1024 * 1024:
        return f"{value / 1024:.0f} KB"
    return f"{value / (1024 * 1024):.0f} MB"


@router.get("/settings", response_class=HTMLResponse)
def settings_page(request: Request, db: DbSession) -> HTMLResponse:
    """System settings page."""
    import platform

    from opal.config import get_active_project, get_active_settings, get_default_data_dir

    context = get_base_context(request, db, "Settings - OPAL")
    project = get_active_project()
    settings = get_active_settings()

    # Compute database size
    db_path = settings.database_url.replace("sqlite:///", "")
    db_size = "-"
    try:
        size_bytes = Path(db_path).stat().st_size
        if size_bytes < 1024:
            db_size = f"{size_bytes} B"
        elif size_bytes < 1024 * 1024:
            db_size = f"{size_bytes / 1024:.1f} KB"
        else:
            db_size = f"{size_bytes / (1024 * 1024):.1f} MB"
    except OSError:
        pass

    max_upload = _human_bytes(settings.max_upload_size)

    context["project"] = project

    # Extensions: names and states only — each extension's configuration and
    # content live on its own page under /settings/extensions.
    context["extensions"] = _extension_summaries(db)

    context["sys_info"] = {
        "opal_version": context["opal_version"],
        "python_version": platform.python_version(),
        "platform": f"{platform.system()} {platform.release()} ({platform.machine()})",
        "server": f"{settings.host}:{settings.port}",
        "debug": settings.debug,
        "data_dir": str(get_default_data_dir()),
        "db_path": db_path,
        "db_size": db_size,
        "upload_dir": str(settings.upload_dir),
        "max_upload_size": max_upload,
    }

    # Sign-in methods, as facts rather than a mode name
    from opal.core import oidc

    context["auth_summary"] = {
        "password": settings.password_login_enabled,
        "passkeys": settings.passkeys_enabled,
        "oidc": oidc.is_enabled(),
        "oidc_issuer": settings.oidc_issuer or None,
        "oidc_provider_name": settings.oidc_provider_name,
    }

    # Instance lifecycle: demo + danger zone
    from opal.core import lifecycle

    context["demo_active"] = lifecycle.is_demo_active()
    context["demo_file_exists"] = lifecycle.demo_file_exists()
    context["demo_db_path"] = str(lifecycle.demo_db_path())

    # MCP agent part-activation opt-in (default off); value is the authorizing operator's id.
    from opal.config import get_app_setting

    activation_raw = get_app_setting(db, "mcp_agent_activation_operator_id")
    activation_operator = None
    if activation_raw and activation_raw.isdigit():
        activation_operator = db.query(User).filter(User.id == int(activation_raw)).first()
    context["agent_activation_enabled"] = activation_operator is not None
    context["agent_activation_operator"] = activation_operator

    return templates.TemplateResponse("settings/index.html", context)


def _auth_form_context(request: Request, db: DbSession, **extra: Any) -> dict[str, Any]:
    """Current sign-in configuration for the settings form.

    Secrets are reported as presence, never echoed back into the form.
    """
    from opal.config import get_active_settings
    from opal.core import oidc

    s = get_active_settings()
    context = get_base_context(request, db, "Authentication - OPAL")
    context["auth"] = {
        "password_login_enabled": s.password_login_enabled,
        "passkeys_enabled": s.passkeys_enabled,
        "oidc_enabled": s.oidc_enabled,
        "oidc_issuer": s.oidc_issuer,
        "oidc_client_id": s.oidc_client_id,
        "has_client_secret": bool(s.oidc_client_secret),
        "oidc_scopes": s.oidc_scopes,
        "oidc_provider_name": s.oidc_provider_name,
        "oidc_groups_claim": s.oidc_groups_claim,
        "oidc_admin_group": s.oidc_admin_group,
        "oidc_auto_create_users": s.oidc_auto_create_users,
        "oidc_redirect_base_url": s.oidc_redirect_base_url,
    }
    # The exact string that must be registered with the provider — the single
    # most common misconfiguration, so it is shown rather than described.
    context["oidc_callback_url"] = oidc.redirect_uri(str(request.base_url), oidc.get_config())
    context["save_result"] = None
    context["test_result"] = None
    context.update(extra)
    return context


@router.get("/settings/auth", response_class=HTMLResponse, response_model=None)
def settings_auth_form(request: Request, db: DbSession) -> HTMLResponse | RedirectResponse:
    """Admin-only authentication settings."""
    if redirect := _require_admin_web(request, db):
        return redirect
    return templates.TemplateResponse("settings/auth.html", _auth_form_context(request, db))


@router.post("/settings/auth", response_class=HTMLResponse, response_model=None)
def settings_auth_save(
    request: Request,
    db: DbSession,
    password_login_enabled: bool = Form(default=False),
    passkeys_enabled: bool = Form(default=False),
    oidc_enabled: bool = Form(default=False),
    oidc_issuer: str = Form(default=""),
    oidc_client_id: str = Form(default=""),
    oidc_client_secret: str = Form(default=""),
    clear_client_secret: bool = Form(default=False),
    oidc_scopes: str = Form(default="openid profile email groups"),
    oidc_provider_name: str = Form(default="SSO"),
    oidc_groups_claim: str = Form(default="groups"),
    oidc_admin_group: str = Form(default=""),
    oidc_auto_create_users: bool = Form(default=False),
    oidc_redirect_base_url: str = Form(default=""),
) -> HTMLResponse | RedirectResponse:
    """Persist authentication settings to the DB overlay. Admin only."""
    if redirect := _require_admin_web(request, db):
        return redirect

    from opal.config import apply_db_overlay, get_active_settings, set_app_setting
    from opal.core import oidc

    current = get_active_settings()

    def _reject(message: str) -> HTMLResponse:
        return templates.TemplateResponse(
            "settings/auth.html",
            _auth_form_context(request, db, save_result={"ok": False, "message": message}),
            status_code=400,
        )

    issuer = oidc_issuer.strip().rstrip("/")

    if oidc_enabled:
        if not issuer or not oidc_client_id.strip():
            return _reject("An issuer URL and client id are required to enable OIDC.")
        # Every token exchange posts the client credential to this host, so it
        # must be https — the one exception is a loopback issuer in development.
        if not issuer.startswith("https://") and not (
            issuer.startswith("http://localhost") or issuer.startswith("http://127.0.0.1")
        ):
            return _reject("The issuer URL must be https:// (or a localhost URL for development).")
        if "openid" not in oidc_scopes.split():
            return _reject("The scopes must include 'openid'.")

    # Locking out every interactive sign-in leaves only API tokens, which
    # cannot reach the web UI — refuse rather than strand the operator.
    if not password_login_enabled and not (oidc_enabled and issuer):
        return _reject(
            "Disabling password sign-in requires a working OIDC provider — "
            "otherwise nobody can reach the web UI."
        )

    new_secret: str
    if clear_client_secret:
        new_secret = ""
    elif oidc_client_secret:
        new_secret = oidc_client_secret
    else:
        new_secret = current.oidc_client_secret

    set_app_setting(db, "password_login_enabled", "true" if password_login_enabled else "false")
    set_app_setting(db, "passkeys_enabled", "true" if passkeys_enabled else "false")
    set_app_setting(db, "oidc_enabled", "true" if oidc_enabled else "false")
    set_app_setting(db, "oidc_issuer", issuer)
    set_app_setting(db, "oidc_client_id", oidc_client_id.strip())
    set_app_setting(db, "oidc_client_secret", new_secret)
    set_app_setting(db, "oidc_scopes", oidc_scopes.strip() or "openid profile email")
    set_app_setting(db, "oidc_provider_name", oidc_provider_name.strip() or "SSO")
    set_app_setting(db, "oidc_groups_claim", oidc_groups_claim.strip() or "groups")
    set_app_setting(db, "oidc_admin_group", oidc_admin_group.strip())
    set_app_setting(db, "oidc_auto_create_users", "true" if oidc_auto_create_users else "false")
    set_app_setting(db, "oidc_redirect_base_url", oidc_redirect_base_url.strip().rstrip("/"))
    db.commit()
    apply_db_overlay(db)
    # Metadata is cached per issuer; a settings change must not be served stale.
    oidc.reset_discovery_cache()

    return templates.TemplateResponse(
        "settings/auth.html",
        _auth_form_context(
            request, db, save_result={"ok": True, "message": "Authentication settings saved."}
        ),
    )


@router.post("/settings/auth/test", response_class=HTMLResponse, response_model=None)
def settings_auth_test(request: Request, db: DbSession) -> HTMLResponse | RedirectResponse:
    """Fetch the provider's discovery document and report what it advertises."""
    if redirect := _require_admin_web(request, db):
        return redirect

    from opal.core import oidc

    config = oidc.get_config()
    if not config.is_configured:
        return templates.TemplateResponse(
            "settings/auth.html",
            _auth_form_context(
                request,
                db,
                test_result={"ok": False, "message": "Set an issuer URL and client id first."},
            ),
        )

    try:
        metadata = oidc.discover(config.issuer, force=True)
    except oidc.OidcError as exc:
        return templates.TemplateResponse(
            "settings/auth.html",
            _auth_form_context(request, db, test_result={"ok": False, "message": str(exc)}),
        )

    scopes = metadata.get("scopes_supported") or []
    missing = [s for s in config.scopes.split() if scopes and s not in scopes]
    message = f"Reached {metadata.get('issuer', config.issuer)}."
    if missing:
        message += " Provider does not advertise scope(s): " + ", ".join(missing) + "."
    return templates.TemplateResponse(
        "settings/auth.html",
        _auth_form_context(
            request,
            db,
            test_result={
                "ok": not missing,
                "message": message,
                "authorization_endpoint": metadata.get("authorization_endpoint"),
                "token_endpoint": metadata.get("token_endpoint"),
                "userinfo_endpoint": metadata.get("userinfo_endpoint"),
                "jwks_uri": metadata.get("jwks_uri"),
            },
        ),
    )


@router.post("/settings/agent-activation", response_class=HTMLResponse, response_model=None)
def settings_agent_activation_save(
    request: Request, db: DbSession, enabled: bool = Form(default=False)
) -> RedirectResponse:
    """Toggle the MCP-agent part-activation opt-in. Admin only.

    Enabling records the acting admin as the authorizing operator; agent
    activations then attribute to them (see opal/mcp/server.py). Sign-offs stay
    human-only regardless. Default off."""
    if redirect := _require_admin_web(request, db):
        return redirect
    from opal.config import set_app_setting

    if enabled:
        current_user = _get_current_user(request, db)
        value = str(current_user.id) if current_user else None
        set_app_setting(db, "mcp_agent_activation_operator_id", value)
    else:
        set_app_setting(db, "mcp_agent_activation_operator_id", None)
    db.commit()
    return RedirectResponse(url="/settings", status_code=302)


# ============ EXTENSIONS ============
#
# The filesystem says what exists; the extension table says what the operator
# decided. Every read reconciles the two (registry.sync) so a directory added
# or removed by hand is reflected without a restart.
#
# Mutations render their result page directly rather than redirecting, the
# same way the Onshape credential form does — the outcome of an install is
# too specific to survive a redirect.


def _extension_summaries(db: DbSession) -> list[dict[str, Any]]:
    """Registry rows joined with what is on disk, for list rendering."""
    from opal.db.models.extension import Extension as ExtensionModel
    from opal.extensions import registry
    from opal.extensions.manifest import CAPABILITIES

    try:
        rows = {row.id: row for row in registry.sync(db)}
        db.commit()
    except Exception:
        logging.getLogger("opal.web").warning("Extension registry sync failed", exc_info=True)
        db.rollback()
        rows = {row.id: row for row in db.query(ExtensionModel).all()}

    found, _ = registry.discover()
    summaries: list[dict[str, Any]] = []
    for ext in found:
        row = rows.get(ext.id)
        provides = ext.manifest.provides
        counts = [
            f"{len(getattr(provides, name))} {name}"
            for name in CAPABILITIES
            if getattr(provides, name)
        ]
        if ext.manifest.code is not None:
            counts.insert(0, "integration")
        summaries.append(
            {
                "id": ext.id,
                "name": ext.manifest.name,
                "version": ext.manifest.version,
                "origin": ext.origin,
                "enabled": row.enabled if row is not None else True,
                "compatible": ext.manifest.compatible_with(),
                "provides_summary": ", ".join(counts) or "-",
            }
        )
    return summaries


def _extension_detail(db: DbSession, ext_id: str) -> dict[str, Any] | None:
    """Full view of one extension, including the content it provides."""
    from opal.extensions import registry
    from opal.extensions.content import load_content
    from opal.extensions.manifest import CAPABILITIES

    ext = registry.find(ext_id)
    if ext is None:
        return None

    registry.sync(db)
    db.commit()
    row = registry.get_row(db, ext_id)
    manifest = ext.manifest

    return {
        "id": ext.id,
        "name": manifest.name,
        "version": manifest.version,
        "summary": manifest.summary,
        "author": manifest.author,
        "license": manifest.license,
        "homepage": manifest.homepage,
        "requires": manifest.opal,
        "origin": ext.origin,
        "is_bundled": ext.is_bundled,
        "enabled": row.enabled if row is not None else True,
        "compatible": manifest.compatible_with(),
        "checksum": row.checksum if row is not None else None,
        "installed_at": row.installed_at if row is not None else None,
        "path": str(ext.root),
        "declares": {name: bool(getattr(manifest.provides, name)) for name in CAPABILITIES},
        "content": load_content(ext),
    }


def _render_extensions_page(
    request: Request, db: DbSession, install_result: dict[str, Any] | None = None
) -> HTMLResponse:
    from opal.config import get_active_settings
    from opal.extensions import registry

    settings = get_active_settings()
    context = get_base_context(request, db, "Extensions - OPAL")
    context["extensions"] = _extension_summaries(db)
    context["broken"] = registry.discover()[1]
    context["extension_dir"] = str(registry.installed_root())
    context["max_archive_size"] = _human_bytes(settings.max_extension_size)
    context["install_result"] = install_result
    return templates.TemplateResponse("settings/extensions.html", context)


def _render_extension_detail(
    request: Request, db: DbSession, ext_id: str, action_result: dict[str, Any] | None = None
) -> HTMLResponse | RedirectResponse:
    from opal.integrations.onshape.extension import EXTENSION_ID as ONSHAPE_EXTENSION_ID

    detail = _extension_detail(db, ext_id)
    if detail is None:
        return RedirectResponse(url="/settings/extensions", status_code=302)

    context = get_base_context(request, db, f"{detail['name']} - OPAL")
    context["ext"] = detail
    context["action_result"] = action_result
    if ext_id == ONSHAPE_EXTENSION_ID:
        _onshape_panel_context(context)
    return templates.TemplateResponse("settings/extension_detail.html", context)


def _onshape_panel_context(context: dict[str, Any]) -> None:
    """Add the live Onshape state the extension detail page renders."""
    from opal.config import get_active_project, get_active_settings

    settings = get_active_settings()
    project = get_active_project()
    context["onshape_enabled"] = settings.onshape_enabled
    context["onshape_poll_interval"] = settings.onshape_poll_interval_minutes
    context["onshape_documents"] = []
    context["onshape_connected"] = False
    if settings.onshape_enabled and project and project.onshape.documents:
        context["onshape_connected"] = True
        context["onshape_documents"] = project.onshape.documents


@router.get("/settings/extensions", response_class=HTMLResponse)
def settings_extensions(request: Request, db: DbSession) -> HTMLResponse:
    """Extension registry: what is installed, and what state it is in."""
    return _render_extensions_page(request, db)


@router.get("/settings/extensions/{ext_id}", response_class=HTMLResponse, response_model=None)
def settings_extension_detail(
    request: Request, db: DbSession, ext_id: str
) -> HTMLResponse | RedirectResponse:
    """One extension: its manifest, its state, and the content it offers."""
    return _render_extension_detail(request, db, ext_id)


@router.post("/settings/extensions/install", response_class=HTMLResponse, response_model=None)
async def settings_extension_install(
    request: Request, db: DbSession
) -> HTMLResponse | RedirectResponse:
    """Install an extension from an uploaded ZIP archive. Admin only."""
    if redirect := _require_admin_web(request, db):
        return redirect

    from opal.extensions.install import InstallError, install_archive

    current_user = _get_current_user(request, db)
    form = await request.form()
    upload = form.get("archive")

    try:
        if upload is None or not hasattr(upload, "read"):
            raise InstallError("no file was uploaded")
        data = await upload.read()
        row = install_archive(db, data, user_id=current_user.id if current_user else None)
        db.commit()
        result = {"ok": True, "message": f"Installed {row.id} {row.version}."}
    except InstallError as err:
        db.rollback()
        result = {"ok": False, "message": str(err)}
    except Exception:
        db.rollback()
        logging.getLogger("opal.web").warning("Extension install failed", exc_info=True)
        result = {"ok": False, "message": "Install failed — see the server log."}

    return _render_extensions_page(request, db, install_result=result)


@router.post(
    "/settings/extensions/{ext_id}/enable", response_class=HTMLResponse, response_model=None
)
def settings_extension_enable(
    request: Request, db: DbSession, ext_id: str
) -> HTMLResponse | RedirectResponse:
    """Switch an extension on. Admin only."""
    return _set_extension_state(request, db, ext_id, enabled=True)


@router.post(
    "/settings/extensions/{ext_id}/disable", response_class=HTMLResponse, response_model=None
)
def settings_extension_disable(
    request: Request, db: DbSession, ext_id: str
) -> HTMLResponse | RedirectResponse:
    """Switch an extension off. Admin only."""
    return _set_extension_state(request, db, ext_id, enabled=False)


def _set_extension_state(
    request: Request, db: DbSession, ext_id: str, *, enabled: bool
) -> HTMLResponse | RedirectResponse:
    if redirect := _require_admin_web(request, db):
        return redirect

    from opal.extensions import registry
    from opal.extensions.loader import activate as activate_extensions

    current_user = _get_current_user(request, db)
    try:
        registry.sync(db)
        registry.set_enabled(db, ext_id, enabled, user_id=current_user.id if current_user else None)
        db.commit()
    except LookupError:
        db.rollback()
        return RedirectResponse(url="/settings/extensions", status_code=302)

    # Background work owned by a code extension follows its state immediately.
    activate_extensions(request.app)

    state = "enabled" if enabled else "disabled"
    return _render_extension_detail(
        request, db, ext_id, action_result={"ok": True, "message": f"{ext_id} {state}."}
    )


@router.post(
    "/settings/extensions/{ext_id}/uninstall", response_class=HTMLResponse, response_model=None
)
def settings_extension_uninstall(
    request: Request, db: DbSession, ext_id: str
) -> HTMLResponse | RedirectResponse:
    """Delete an installed extension's files and registry row. Admin only."""
    if redirect := _require_admin_web(request, db):
        return redirect

    from opal.extensions.install import InstallError, uninstall

    current_user = _get_current_user(request, db)
    try:
        uninstall(db, ext_id, user_id=current_user.id if current_user else None)
        db.commit()
    except LookupError:
        db.rollback()
        return RedirectResponse(url="/settings/extensions", status_code=302)
    except InstallError as err:
        db.rollback()
        return _render_extension_detail(
            request, db, ext_id, action_result={"ok": False, "message": str(err)}
        )

    return _render_extensions_page(
        request, db, install_result={"ok": True, "message": f"Uninstalled {ext_id}."}
    )


@router.post(
    "/settings/extensions/{ext_id}/import/{kind}/{key}",
    response_class=HTMLResponse,
    response_model=None,
)
def settings_extension_import(
    request: Request, db: DbSession, ext_id: str, kind: str, key: str
) -> HTMLResponse | RedirectResponse:
    """Import one template into the project as ordinary project data. Admin only."""
    if redirect := _require_admin_web(request, db):
        return redirect

    from opal.extensions import registry
    from opal.extensions.content import IMPORTERS, ContentError

    current_user = _get_current_user(request, db)
    ext = registry.find(ext_id)
    importer = IMPORTERS.get(kind)

    if ext is None or importer is None:
        return RedirectResponse(url="/settings/extensions", status_code=302)
    if not registry.is_enabled(db, ext_id):
        return _render_extension_detail(
            request,
            db,
            ext_id,
            action_result={"ok": False, "message": "Enable this extension before importing."},
        )

    try:
        created = importer(db, ext, key, user_id=current_user.id if current_user else None)
        db.commit()
        result = {"ok": True, "message": f"Imported {created.name}."}
    except ContentError as err:
        db.rollback()
        result = {"ok": False, "message": str(err)}
    except Exception:
        db.rollback()
        logging.getLogger("opal.web").warning("Extension import failed", exc_info=True)
        result = {"ok": False, "message": "Import failed — see the server log."}

    return _render_extension_detail(request, db, ext_id, action_result=result)


# ============ INSTANCE LIFECYCLE: DEMO DATA + FACTORY RESET ============


@router.post("/settings/demo/enter")
def settings_demo_enter(request: Request, db: DbSession) -> RedirectResponse:
    """Switch the instance to the throwaway demo database (admin only)."""
    from opal.api.routes.auth import set_session_cookie
    from opal.core import lifecycle
    from opal.core.auth import create_session
    from opal.db.base import SessionLocal
    from opal.db.models.user import User as UserModel
    from opal.extensions.loader import activate as activate_extensions

    if redirect := _require_admin_web(request, db):
        return redirect
    current_user = _get_current_user(request, db)

    demo_user_id = lifecycle.enter_demo(current_user)
    activate_extensions(request.app)

    response = RedirectResponse(url="/", status_code=302)
    if demo_user_id is not None:
        # Sessions live per-database: mint one in the demo database so the
        # operator stays logged in across the switch.
        with SessionLocal() as demo_db:
            demo_user = demo_db.query(UserModel).filter(UserModel.id == demo_user_id).first()
            if demo_user:
                token = create_session(
                    demo_db,
                    demo_user,
                    auth_method="demo",
                    user_agent=request.headers.get("user-agent"),
                    ip_address=_client_ip(request),
                )
                demo_db.commit()
                set_session_cookie(response, request, token)
    return response


@router.post("/settings/demo/exit")
def settings_demo_exit(request: Request, db: DbSession) -> RedirectResponse:
    """Exit the demo: switch back to the real database and delete the demo file."""
    from opal.api.routes.auth import clear_session_cookie
    from opal.core import lifecycle
    from opal.extensions.loader import activate as activate_extensions

    if redirect := _require_admin_web(request, db):
        return redirect

    lifecycle.exit_demo(delete=True)
    activate_extensions(request.app)

    # Demo-database sessions mean nothing in the real database.
    response = RedirectResponse(url="/login", status_code=302)
    clear_session_cookie(response)
    return response


@router.post("/settings/demo/delete")
def settings_demo_delete(request: Request, db: DbSession) -> RedirectResponse:
    """Delete an inactive demo database file."""
    from opal.core import lifecycle

    if redirect := _require_admin_web(request, db):
        return redirect

    # Demo currently active -> no-op; use exit instead
    with contextlib.suppress(RuntimeError):
        lifecycle.delete_demo_file()
    return RedirectResponse(url="/settings", status_code=302)


@router.post("/settings/factory-reset")
def settings_factory_reset(
    request: Request, db: DbSession, confirm: str = Form("")
) -> RedirectResponse:
    """Wipe the instance back to first-run state. Requires typing RESET."""
    from opal.api.routes.auth import clear_session_cookie
    from opal.core import lifecycle
    from opal.extensions.loader import activate as activate_extensions

    if redirect := _require_admin_web(request, db):
        return redirect

    if confirm.strip() != "RESET":
        return RedirectResponse(url="/settings", status_code=302)

    logging.getLogger("opal.web").warning("FACTORY RESET initiated from settings")
    lifecycle.factory_reset()
    activate_extensions(request.app)

    response = RedirectResponse(url="/setup", status_code=302)
    clear_session_cookie(response)
    return response


def _onshape_form_context(request: Request, db: DbSession) -> dict[str, Any]:
    """Build the template context for the Onshape configure form."""
    from opal.config import get_active_settings

    s = get_active_settings()
    context = get_base_context(request, db, "Onshape - OPAL")
    context["onshape_enabled"] = s.onshape_enabled
    context["form"] = {
        "access_key": s.onshape_access_key,
        "base_url": s.onshape_base_url,
        "poll_interval_minutes": s.onshape_poll_interval_minutes,
        "has_secret_key": bool(s.onshape_secret_key),
        "has_webhook_secret": bool(s.onshape_webhook_secret),
    }
    return context


@router.get("/settings/onshape/configure", response_class=HTMLResponse, response_model=None)
def settings_onshape_configure_form(
    request: Request, db: DbSession
) -> HTMLResponse | RedirectResponse:
    """Render the Onshape credentials form (admin only)."""
    if redirect := _require_admin_web(request, db):
        return redirect
    context = _onshape_form_context(request, db)
    context["save_result"] = None
    context["test_result"] = None
    return templates.TemplateResponse("settings/onshape_configure.html", context)


@router.post("/settings/onshape/configure", response_class=HTMLResponse, response_model=None)
def settings_onshape_configure_save(
    request: Request,
    db: DbSession,
    access_key: str = Form(default=""),
    secret_key: str = Form(default=""),
    base_url: str = Form(default="https://cad.onshape.com"),
    poll_interval_minutes: int = Form(default=15),
    webhook_secret: str = Form(default=""),
    clear_secret_key: bool = Form(default=False),
    clear_webhook_secret: bool = Form(default=False),
) -> HTMLResponse | RedirectResponse:
    """Persist Onshape credentials. Blank secret fields keep existing values
    unless the matching ``clear_*`` checkbox was sent."""
    if redirect := _require_admin_web(request, db):
        return redirect

    from opal.config import apply_db_overlay, get_active_settings, set_app_setting

    current = get_active_settings()

    new_secret: str | None
    if clear_secret_key:
        new_secret = ""
    elif secret_key:
        new_secret = secret_key
    else:
        new_secret = current.onshape_secret_key

    new_webhook: str | None
    if clear_webhook_secret:
        new_webhook = ""
    elif webhook_secret:
        new_webhook = webhook_secret
    else:
        new_webhook = current.onshape_webhook_secret

    # Validate the outbound base URL: every Onshape call (carrying the signed
    # credential) is made against it, so restrict it to https to keep a
    # compromised/mistyped config from pointing the credentialed client at an
    # internal http target.
    resolved_base = base_url.strip() or "https://cad.onshape.com"
    if not resolved_base.startswith("https://") or len(resolved_base) <= len("https://"):
        context = _onshape_form_context(request, db)
        context["save_result"] = {
            "ok": False,
            "message": "Base URL must be an https:// URL.",
        }
        context["test_result"] = None
        return templates.TemplateResponse("settings/onshape_configure.html", context)

    set_app_setting(db, "onshape_access_key", access_key.strip())
    set_app_setting(db, "onshape_secret_key", new_secret)
    set_app_setting(db, "onshape_base_url", resolved_base)
    set_app_setting(db, "onshape_poll_interval_minutes", str(max(0, poll_interval_minutes)))
    set_app_setting(db, "onshape_webhook_secret", new_webhook)
    db.commit()
    apply_db_overlay(db)

    context = _onshape_form_context(request, db)
    context["save_result"] = {"ok": True, "message": "Onshape settings saved."}
    context["test_result"] = None
    return templates.TemplateResponse("settings/onshape_configure.html", context)


@router.post("/settings/onshape/test", response_class=HTMLResponse)
def settings_onshape_test(request: Request, db: DbSession) -> HTMLResponse:
    """Run a credential smoke-test against the saved Onshape config.
    Returns an HTMX banner partial."""
    if redirect := _require_admin_web(request, db):
        return redirect

    from opal.config import get_active_settings
    from opal.integrations.onshape.client import OnshapeApiError, OnshapeClient

    s = get_active_settings()
    if not s.onshape_enabled:
        result = {"ok": False, "message": "Access key and secret key are required."}
    else:
        import json as _json

        try:
            client = OnshapeClient(
                access_key=s.onshape_access_key,
                secret_key=s.onshape_secret_key,
                base_url=s.onshape_base_url,
            )
            try:
                info = client.get_session_info()
            finally:
                client.close()
            name = info.get("name") or info.get("email") or "session OK"
            result = {"ok": True, "message": f"Connected as {name}."}
        except OnshapeApiError as err:
            result = {"ok": False, "message": f"Onshape API {err.status_code}: {err.detail}"}
        except _json.JSONDecodeError:
            # Onshape returns an HTML login page (HTTP 200) for bad credentials,
            # which trips the JSON decoder before we ever see a 4xx.
            result = {
                "ok": False,
                "message": "Authentication failed — check that the access and secret keys are correct.",
            }
        except Exception as err:
            result = {"ok": False, "message": f"Connection failed: {err}"}

    return templates.TemplateResponse(
        "settings/_onshape_test_banner.html",
        {"request": request, "test_result": result},
    )


@router.get("/settings/onshape/sync-log", response_class=HTMLResponse)
def settings_onshape_sync_log(request: Request, db: DbSession) -> HTMLResponse:
    """HTMX partial: recent Onshape sync log entries."""
    from opal.db.models.onshape_link import OnshapeSyncLog

    sync_logs = db.query(OnshapeSyncLog).order_by(OnshapeSyncLog.id.desc()).limit(10).all()
    return templates.TemplateResponse(
        "settings/onshape_sync_log.html",
        {"request": request, "sync_logs": sync_logs},
    )


@router.get("/settings/onshape/documents", response_class=HTMLResponse)
def settings_onshape_documents(request: Request, db: DbSession) -> HTMLResponse:
    """HTMX partial: Onshape registered documents table + add form."""
    from opal.config import get_active_project, get_active_settings

    settings = get_active_settings()
    project = get_active_project()
    documents = project.onshape.documents if project else []
    context = get_base_context(request, db, "")
    context["onshape_documents"] = documents
    context["onshape_enabled"] = settings.onshape_enabled
    context["onshape_doc_error"] = None
    context["onshape_doc_success"] = None
    return templates.TemplateResponse("settings/onshape_documents.html", context)


@router.post("/settings/onshape/documents", response_class=HTMLResponse)
async def settings_onshape_add_document(request: Request, db: DbSession) -> HTMLResponse:
    """HTMX: add an Onshape document from a pasted URL."""
    import asyncio

    from opal.config import get_active_project, get_active_settings, save_project_to_db
    from opal.integrations.onshape.client import (
        OnshapeApiError,
        OnshapeClient,
        parse_onshape_url,
    )
    from opal.project import OnshapeDocumentRef, ProjectConfig

    settings = get_active_settings()
    project = get_active_project()

    form = await request.form()
    url = str(form.get("url", "")).strip()
    name_override = str(form.get("name", "")).strip()

    documents = project.onshape.documents if project else []
    context = get_base_context(request, db, "")
    context["onshape_documents"] = documents
    context["onshape_enabled"] = settings.onshape_enabled
    context["onshape_doc_error"] = None
    context["onshape_doc_success"] = None

    if not url:
        context["onshape_doc_error"] = "URL is required"
        return templates.TemplateResponse("settings/onshape_documents.html", context)

    if not project:
        # Adding an Onshape document shouldn't require the wizard first
        project = ProjectConfig(name="OPAL")

    parsed = parse_onshape_url(url)
    if not parsed:
        context["onshape_doc_error"] = (
            "Invalid Onshape URL. Expected: https://cad.onshape.com/documents/..."
        )
        return templates.TemplateResponse("settings/onshape_documents.html", context)

    document_id, wvm_type, wvm_id, element_id = parsed

    if wvm_type != "w":
        context["onshape_doc_error"] = (
            "Only workspace URLs (/w/) are supported. Open the document in a workspace."
        )
        return templates.TemplateResponse("settings/onshape_documents.html", context)
    workspace_id = wvm_id

    # Duplicate check
    for doc in project.onshape.documents:
        if doc.document_id == document_id and doc.element_id == element_id:
            context["onshape_doc_error"] = f"Already registered as '{doc.name}'"
            return templates.TemplateResponse("settings/onshape_documents.html", context)

    # Auto-detect element type
    client = OnshapeClient(
        access_key=settings.onshape_access_key,
        secret_key=settings.onshape_secret_key,
        base_url=settings.onshape_base_url,
    )
    try:
        elements = await asyncio.to_thread(client.get_elements, document_id, workspace_id)
    except OnshapeApiError as e:
        context["onshape_doc_error"] = f"Onshape API error: {e.detail}"
        return templates.TemplateResponse("settings/onshape_documents.html", context)
    finally:
        client.close()

    matched = next((el for el in elements if el.id == element_id), None)
    if not matched:
        context["onshape_doc_error"] = "Element not found in the Onshape document"
        return templates.TemplateResponse("settings/onshape_documents.html", context)

    type_map = {"PARTSTUDIO": "part_studio", "ASSEMBLY": "assembly"}
    element_type = type_map.get(matched.element_type)
    if not element_type:
        context["onshape_doc_error"] = (
            f"Unsupported element type: {matched.element_type}. "
            "Only assemblies and part studios are supported."
        )
        return templates.TemplateResponse("settings/onshape_documents.html", context)

    doc_name = name_override if name_override else matched.name

    doc_ref = OnshapeDocumentRef(
        name=doc_name,
        document_id=document_id,
        workspace_id=workspace_id,
        element_id=element_id,
        element_type=element_type,
        auto_sync=True,
    )
    project.onshape.documents.append(doc_ref)
    save_project_to_db(db, project)
    db.commit()

    context["onshape_documents"] = project.onshape.documents
    context["onshape_doc_success"] = f"Added '{doc_name}' ({element_type.replace('_', ' ')})"
    return templates.TemplateResponse("settings/onshape_documents.html", context)


@router.post("/settings/onshape/documents/remove", response_class=HTMLResponse)
async def settings_onshape_remove_document(request: Request, db: DbSession) -> HTMLResponse:
    """HTMX: remove an Onshape document from config."""
    from opal.config import get_active_project, get_active_settings, save_project_to_db

    settings = get_active_settings()
    project = get_active_project()

    form = await request.form()
    document_id = str(form.get("document_id", ""))
    element_id = str(form.get("element_id", ""))

    context = get_base_context(request, db, "")
    context["onshape_enabled"] = settings.onshape_enabled
    context["onshape_doc_error"] = None
    context["onshape_doc_success"] = None

    if project:
        removed_name = None
        for doc in project.onshape.documents:
            if doc.document_id == document_id and doc.element_id == element_id:
                removed_name = doc.name
                break

        project.onshape.documents = [
            d
            for d in project.onshape.documents
            if not (d.document_id == document_id and d.element_id == element_id)
        ]
        save_project_to_db(db, project)
        db.commit()

        if removed_name:
            context["onshape_doc_success"] = f"Removed '{removed_name}'"

    context["onshape_documents"] = project.onshape.documents if project else []
    return templates.TemplateResponse("settings/onshape_documents.html", context)


@router.post("/settings/onshape/sync/pull", response_class=HTMLResponse)
async def settings_onshape_sync_pull(request: Request, db: DbSession) -> HTMLResponse:
    """HTMX: trigger pull sync from Onshape, return HTML result."""
    import asyncio

    from opal.config import get_active_project, get_active_settings
    from opal.db.base import SessionLocal
    from opal.db.models.onshape_link import OnshapeSyncLog
    from opal.integrations.onshape.client import OnshapeClient
    from opal.integrations.onshape.sync import pull_sync

    settings = get_active_settings()
    project = get_active_project()

    # Resolve user from cookie
    user_id = verify_user_id(request.cookies.get(AUTH_COOKIE))

    if not settings.onshape_enabled or not project or not project.onshape.documents:
        sync_logs = db.query(OnshapeSyncLog).order_by(OnshapeSyncLog.id.desc()).limit(10).all()
        return templates.TemplateResponse(
            "settings/onshape_sync_result.html",
            {
                "request": request,
                "status": "error",
                "summary": "Onshape not enabled or no documents configured",
                "error_message": None,
                "sync_logs": sync_logs,
            },
        )

    doc_refs = project.onshape.documents
    client = OnshapeClient(
        access_key=settings.onshape_access_key,
        secret_key=settings.onshape_secret_key,
        base_url=settings.onshape_base_url,
    )

    def _run_sync() -> list[dict[str, str | None]]:
        results: list[dict[str, str | None]] = []
        thread_db = SessionLocal()
        try:
            for doc_ref in doc_refs:
                sync_log = pull_sync(thread_db, client, doc_ref, user_id, "manual")
                results.append({"status": sync_log.status, "summary": sync_log.summary})
        finally:
            thread_db.close()
        return results

    try:
        results = await asyncio.to_thread(_run_sync)
    except Exception as e:
        db.commit()  # Release stale read snapshot so we see thread-committed data
        sync_logs = db.query(OnshapeSyncLog).order_by(OnshapeSyncLog.id.desc()).limit(10).all()
        return templates.TemplateResponse(
            "settings/onshape_sync_result.html",
            {
                "request": request,
                "status": "error",
                "summary": f"Pull sync failed: {e}",
                "error_message": str(e),
                "sync_logs": sync_logs,
            },
        )
    finally:
        client.close()

    # Combine results: worst status wins, summaries joined
    worst = "success"
    for r in results:
        if r["status"] == "error":
            worst = "error"
            break
        if r["status"] == "partial":
            worst = "partial"
    combined_summary = "\n".join(r["summary"] or "" for r in results)

    # Re-query sync logs — commit first to release stale read snapshot
    db.commit()
    sync_logs = db.query(OnshapeSyncLog).order_by(OnshapeSyncLog.id.desc()).limit(10).all()
    return templates.TemplateResponse(
        "settings/onshape_sync_result.html",
        {
            "request": request,
            "status": worst,
            "summary": combined_summary,
            "error_message": None,
            "sync_logs": sync_logs,
        },
    )


@router.post("/settings/onshape/sync/push", response_class=HTMLResponse)
async def settings_onshape_sync_push(request: Request, db: DbSession) -> HTMLResponse:
    """HTMX: trigger push sync to Onshape, return HTML result."""
    import asyncio

    from opal.config import get_active_project, get_active_settings
    from opal.db.base import SessionLocal
    from opal.db.models.onshape_link import OnshapeSyncLog
    from opal.integrations.onshape.client import OnshapeClient
    from opal.integrations.onshape.sync import push_sync

    settings = get_active_settings()
    project = get_active_project()

    user_id = verify_user_id(request.cookies.get(AUTH_COOKIE))

    if not settings.onshape_enabled or not project or not project.onshape.documents:
        sync_logs = db.query(OnshapeSyncLog).order_by(OnshapeSyncLog.id.desc()).limit(10).all()
        return templates.TemplateResponse(
            "settings/onshape_sync_result.html",
            {
                "request": request,
                "status": "error",
                "summary": "Onshape not enabled or no documents configured",
                "error_message": None,
                "sync_logs": sync_logs,
            },
        )

    doc_refs = project.onshape.documents
    client = OnshapeClient(
        access_key=settings.onshape_access_key,
        secret_key=settings.onshape_secret_key,
        base_url=settings.onshape_base_url,
    )

    def _run_sync() -> list[dict[str, str | None]]:
        results: list[dict[str, str | None]] = []
        thread_db = SessionLocal()
        try:
            for doc_ref in doc_refs:
                sync_log = push_sync(thread_db, client, doc_ref, user_id, "manual")
                results.append({"status": sync_log.status, "summary": sync_log.summary})
        finally:
            thread_db.close()
        return results

    try:
        results = await asyncio.to_thread(_run_sync)
    except Exception as e:
        db.commit()  # Release stale read snapshot so we see thread-committed data
        sync_logs = db.query(OnshapeSyncLog).order_by(OnshapeSyncLog.id.desc()).limit(10).all()
        return templates.TemplateResponse(
            "settings/onshape_sync_result.html",
            {
                "request": request,
                "status": "error",
                "summary": f"Push sync failed: {e}",
                "error_message": str(e),
                "sync_logs": sync_logs,
            },
        )
    finally:
        client.close()

    # Combine results: worst status wins, summaries joined
    worst = "success"
    for r in results:
        if r["status"] == "error":
            worst = "error"
            break
        if r["status"] == "partial":
            worst = "partial"
    combined_summary = "\n".join(r["summary"] or "" for r in results)

    db.commit()  # Release stale read snapshot so we see thread-committed data
    sync_logs = db.query(OnshapeSyncLog).order_by(OnshapeSyncLog.id.desc()).limit(10).all()
    return templates.TemplateResponse(
        "settings/onshape_sync_result.html",
        {
            "request": request,
            "status": worst,
            "summary": combined_summary,
            "error_message": None,
            "sync_logs": sync_logs,
        },
    )


# ============ NOTIFICATIONS ============
#
# The bell polls _bell.html; the inbox owns sorting, filtering and the read
# actions. Both read the same rows through opal.core.notifications, so the
# count in the header and the list on the page can never disagree.

#: Inbox sort orders. "recent" is the default — an inbox is a timeline first.
_NOTIFICATION_SORTS = ("recent", "priority", "unread")


@router.get("/notifications/bell", response_class=HTMLResponse)
def notifications_bell(request: Request, db: DbSession) -> HTMLResponse:
    """HTMX partial: the header bell, its unread count, and the newest eight."""
    from opal.core import notifications

    current_user = _get_current_user(request, db)
    context: dict[str, Any] = {"request": request, "notifications": [], "unread_count": 0}
    if current_user is not None:
        context["notifications"] = notifications.recent(db, current_user.id, limit=8)
        context["unread_count"] = notifications.unread_count(db, current_user.id)
    return templates.TemplateResponse("notifications/_bell.html", context)


@router.get("/notifications", response_class=HTMLResponse, response_model=None)
def notifications_inbox(
    request: Request,
    db: DbSession,
    category: str = "",
    state: str = "",
    sort: str = "recent",
) -> HTMLResponse | RedirectResponse:
    """Inbox: every notification for the reader, with filters and sorting."""
    from opal.core import notifications
    from opal.db.models.notification import Notification, NotificationCategory, category_for

    current_user = _get_current_user(request, db)
    if current_user is None:
        return RedirectResponse(url="/login", status_code=302)

    if sort not in _NOTIFICATION_SORTS:
        sort = "recent"

    query = db.query(Notification).filter(
        Notification.user_id == current_user.id, Notification.dismissed_at.is_(None)
    )
    if state == "unread":
        query = query.filter(Notification.read_at.is_(None))
    elif state == "read":
        query = query.filter(Notification.read_at.isnot(None))

    rows = query.order_by(Notification.created_at.desc(), Notification.id.desc()).all()

    # Category is derived from kind, so it is filtered in Python rather than
    # stored a second time in the table.
    if category in {c.value for c in NotificationCategory}:
        rows = [row for row in rows if category_for(row.kind).value == category]

    if sort == "priority":
        rows.sort(key=lambda row: (row.priority_rank, row.created_at), reverse=True)
    elif sort == "unread":
        rows.sort(key=lambda row: (row.read_at is None, row.created_at), reverse=True)

    context = get_base_context(request, db, "Notifications - OPAL")
    context["notifications"] = rows
    context["unread_count"] = notifications.unread_count(db, current_user.id)
    context["categories"] = [c.value for c in NotificationCategory]
    context["filter_category"] = category
    context["filter_state"] = state
    context["sort"] = sort
    return templates.TemplateResponse("notifications/index.html", context)


@router.post("/notifications/read-all", response_model=None)
def notifications_read_all(request: Request, db: DbSession) -> RedirectResponse:
    """Mark every unread notification read."""
    from opal.core import notifications

    current_user = _get_current_user(request, db)
    if current_user is None:
        return RedirectResponse(url="/login", status_code=302)
    notifications.mark_all_read(db, current_user.id)
    db.commit()
    return RedirectResponse(url="/notifications", status_code=302)


@router.post("/notifications/{notification_id}/read", response_model=None)
def notifications_mark_read(
    request: Request, db: DbSession, notification_id: int
) -> RedirectResponse:
    """Mark one notification read, then follow it to its subject."""
    from opal.core import notifications

    current_user = _get_current_user(request, db)
    if current_user is None:
        return RedirectResponse(url="/login", status_code=302)

    row = notifications.mark_read(db, current_user.id, notification_id)
    db.commit()
    # A notification is a pointer: reading it means going to the record.
    return RedirectResponse(url=row.href if row is not None else "/notifications", status_code=302)


@router.post("/notifications/{notification_id}/dismiss", response_model=None)
def notifications_dismiss(
    request: Request, db: DbSession, notification_id: int
) -> RedirectResponse:
    """Remove one notification from the inbox."""
    from opal.core import notifications

    current_user = _get_current_user(request, db)
    if current_user is None:
        return RedirectResponse(url="/login", status_code=302)
    notifications.dismiss(db, current_user.id, notification_id)
    db.commit()
    return RedirectResponse(url="/notifications", status_code=302)


# ============ AUDIT LOG ============


@router.get("/audit", response_class=HTMLResponse)
def audit_list(request: Request, db: DbSession) -> HTMLResponse:
    """Audit log list page."""
    from opal.db.models.audit import AuditLog

    context = get_base_context(request, db, "Audit Log - OPAL")

    # Get distinct table names for filter
    table_names = [
        row[0]
        for row in db.query(AuditLog.table_name).distinct().order_by(AuditLog.table_name).all()
    ]
    context["table_names"] = table_names

    return templates.TemplateResponse("audit/list.html", context)


@router.get("/audit/table", response_class=HTMLResponse)
def audit_table(
    request: Request,
    db: DbSession,
    table_name: str | None = Query(None),
    action: str | None = Query(None),
    date_from: str | None = Query(None),
    date_to: str | None = Query(None),
    page: int = Query(1, ge=1),
) -> HTMLResponse:
    """Audit log table rows (HTMX partial)."""
    from opal.db.models.audit import AuditLog

    query = db.query(AuditLog)

    if table_name:
        query = query.filter(AuditLog.table_name == table_name)
    if action:
        query = query.filter(AuditLog.action == action)
    if date_from:
        try:
            dt_from = datetime.strptime(date_from, "%Y-%m-%d").replace(tzinfo=UTC)
            query = query.filter(AuditLog.timestamp >= dt_from)
        except ValueError:
            pass
    if date_to:
        try:
            dt_to = datetime.strptime(date_to, "%Y-%m-%d").replace(tzinfo=UTC) + timedelta(days=1)
            query = query.filter(AuditLog.timestamp < dt_to)
        except ValueError:
            pass

    entries, pagination = paginate_query(
        request, query.order_by(AuditLog.timestamp.desc()), page, colspan=6, page_size=200
    )

    # Build user cache to avoid N+1
    user_ids = {e.user_id for e in entries if e.user_id}
    user_cache: dict[int, str] = {}
    if user_ids:
        users = db.query(User).filter(User.id.in_(user_ids)).all()
        user_cache = {u.id: u.name for u in users}

    # Annotate entries with helper data
    for entry in entries:
        entry._user_name = user_cache.get(entry.user_id) if entry.user_id else None
        entry._summary = _build_change_summary(entry)
        url_base = _TABLE_URL_MAP.get(entry.table_name)
        entry._url = f"{url_base}/{entry.record_id}" if url_base else None

    return templates.TemplateResponse(
        "audit/table_rows.html",
        {"request": request, "entries": entries, "pagination": pagination},
    )


# ============ STYLEGUIDE ============


@router.get("/styleguide", response_class=HTMLResponse)
def styleguide(request: Request, db: DbSession) -> HTMLResponse:
    """OPALkit component styleguide page."""
    context = get_base_context(request, db, "Styleguide - OPAL")
    return templates.TemplateResponse("opalkit/styleguide/index.html", context)
