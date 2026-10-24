"""Instance settings API: system facts, sign-in methods, Onshape credentials,
MCP agent activation, and the demo / factory-reset lifecycle.

Everything that changes configuration is admin-only. Secrets are reported as
presence (``has_*``) and never echoed back.
"""

import contextlib
import json
import logging
import platform
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, Request, Response, status
from pydantic import BaseModel, Field

from opal.api.deps import DbSession, RequiredAdmin, RequiredUser
from opal.api.net import clear_session_cookie, client_ip, set_session_cookie
from opal.db.models import User

logger = logging.getLogger("opal.settings")

router = APIRouter(prefix="/settings", tags=["settings"])


# ============ System ============


class SystemInfo(BaseModel):
    opal_version: str
    python_version: str
    platform: str
    server: str
    debug: bool
    data_dir: str
    db_path: str
    db_size_bytes: int | None
    upload_dir: str
    max_upload_bytes: int


@router.get("/system", response_model=SystemInfo)
def system_info(user: RequiredUser) -> SystemInfo:
    """Version, platform and storage facts for this instance."""
    from opal.config import get_active_settings, get_default_data_dir
    from opal.version import get_version_info

    settings = get_active_settings()
    db_path = settings.database_url.replace("sqlite:///", "")
    size: int | None = None
    with contextlib.suppress(OSError):
        size = Path(db_path).stat().st_size
    return SystemInfo(
        opal_version=get_version_info().full,
        python_version=platform.python_version(),
        platform=f"{platform.system()} {platform.release()} ({platform.machine()})",
        server=f"{settings.host}:{settings.port}",
        debug=settings.debug,
        data_dir=str(get_default_data_dir()),
        db_path=db_path,
        db_size_bytes=size,
        upload_dir=str(settings.upload_dir),
        max_upload_bytes=settings.max_upload_size,
    )


# ============ Sign-in methods ============


class AuthSettings(BaseModel):
    password_login_enabled: bool
    passkeys_enabled: bool
    oidc_enabled: bool
    oidc_issuer: str
    oidc_client_id: str
    has_client_secret: bool
    oidc_scopes: str
    oidc_provider_name: str
    oidc_groups_claim: str
    oidc_admin_group: str
    oidc_auto_create_users: bool
    oidc_redirect_base_url: str
    #: The exact redirect URI to register with the provider.
    callback_url: str


class AuthSettingsInput(BaseModel):
    password_login_enabled: bool
    passkeys_enabled: bool
    oidc_enabled: bool = False
    oidc_issuer: str = ""
    oidc_client_id: str = ""
    #: Blank keeps the stored secret.
    oidc_client_secret: str = ""
    clear_client_secret: bool = False
    oidc_scopes: str = "openid profile email groups"
    oidc_provider_name: str = "SSO"
    oidc_groups_claim: str = "groups"
    oidc_admin_group: str = ""
    oidc_auto_create_users: bool = False
    oidc_redirect_base_url: str = ""


def _auth_settings(request: Request) -> AuthSettings:
    from opal.config import get_active_settings
    from opal.core import oidc

    s = get_active_settings()
    return AuthSettings(
        password_login_enabled=s.password_login_enabled,
        passkeys_enabled=s.passkeys_enabled,
        oidc_enabled=s.oidc_enabled,
        oidc_issuer=s.oidc_issuer,
        oidc_client_id=s.oidc_client_id,
        has_client_secret=bool(s.oidc_client_secret),
        oidc_scopes=s.oidc_scopes,
        oidc_provider_name=s.oidc_provider_name,
        oidc_groups_claim=s.oidc_groups_claim,
        oidc_admin_group=s.oidc_admin_group,
        oidc_auto_create_users=s.oidc_auto_create_users,
        oidc_redirect_base_url=s.oidc_redirect_base_url,
        callback_url=oidc.redirect_uri(str(request.base_url), oidc.get_config()),
    )


@router.get("/auth", response_model=AuthSettings)
def get_auth_settings(request: Request, admin: RequiredAdmin) -> AuthSettings:
    return _auth_settings(request)


@router.put("/auth", response_model=AuthSettings)
def save_auth_settings(
    body: AuthSettingsInput, request: Request, db: DbSession, admin: RequiredAdmin
) -> AuthSettings:
    """Persist sign-in settings to the database overlay."""
    from opal.config import apply_db_overlay, get_active_settings, set_app_setting
    from opal.core import oidc

    current = get_active_settings()
    issuer = body.oidc_issuer.strip().rstrip("/")
    scopes = body.oidc_scopes.strip() or "openid profile email"

    def reject(message: str) -> HTTPException:
        return HTTPException(status.HTTP_400_BAD_REQUEST, detail=message)

    if body.oidc_enabled:
        if not issuer or not body.oidc_client_id.strip():
            raise reject("An issuer URL and client id are required to enable OIDC.")
        # Every token exchange posts the client credential to this host, so it
        # must be https; the one exception is a loopback issuer in development.
        if not issuer.startswith("https://") and not (
            issuer.startswith("http://localhost") or issuer.startswith("http://127.0.0.1")
        ):
            raise reject("The issuer URL must be https:// (or a localhost URL for development).")
        if "openid" not in scopes.split():
            raise reject("The scopes must include 'openid'.")

    # Locking out every interactive sign-in leaves only API tokens, which
    # cannot reach the web UI. Refuse rather than strand the operator.
    if not body.password_login_enabled and not (body.oidc_enabled and issuer):
        raise reject(
            "Disabling password sign-in requires a working OIDC provider; "
            "otherwise nobody can reach the web UI."
        )

    if body.clear_client_secret:
        secret = ""
    elif body.oidc_client_secret:
        secret = body.oidc_client_secret
    else:
        secret = current.oidc_client_secret

    def flag(value: bool) -> str:
        return "true" if value else "false"

    set_app_setting(db, "password_login_enabled", flag(body.password_login_enabled))
    set_app_setting(db, "passkeys_enabled", flag(body.passkeys_enabled))
    set_app_setting(db, "oidc_enabled", flag(body.oidc_enabled))
    set_app_setting(db, "oidc_issuer", issuer)
    set_app_setting(db, "oidc_client_id", body.oidc_client_id.strip())
    set_app_setting(db, "oidc_client_secret", secret)
    set_app_setting(db, "oidc_scopes", scopes)
    set_app_setting(db, "oidc_provider_name", body.oidc_provider_name.strip() or "SSO")
    set_app_setting(db, "oidc_groups_claim", body.oidc_groups_claim.strip() or "groups")
    set_app_setting(db, "oidc_admin_group", body.oidc_admin_group.strip())
    set_app_setting(db, "oidc_auto_create_users", flag(body.oidc_auto_create_users))
    set_app_setting(db, "oidc_redirect_base_url", body.oidc_redirect_base_url.strip().rstrip("/"))
    db.commit()
    apply_db_overlay(db)
    # Metadata is cached per issuer; a settings change must not be served stale.
    oidc.reset_discovery_cache()
    return _auth_settings(request)


class DiscoveryResult(BaseModel):
    ok: bool
    message: str
    authorization_endpoint: str | None = None
    token_endpoint: str | None = None
    userinfo_endpoint: str | None = None
    jwks_uri: str | None = None


@router.post("/auth/test", response_model=DiscoveryResult)
def test_auth_discovery(admin: RequiredAdmin) -> DiscoveryResult:
    """Fetch the provider's discovery document and report what it advertises."""
    from opal.core import oidc

    config = oidc.get_config()
    if not config.is_configured:
        return DiscoveryResult(ok=False, message="Set an issuer URL and client id first.")
    try:
        metadata = oidc.discover(config.issuer, force=True)
    except oidc.OidcError as exc:
        return DiscoveryResult(ok=False, message=str(exc))

    scopes = metadata.get("scopes_supported") or []
    missing = [s for s in config.scopes.split() if scopes and s not in scopes]
    message = f"Reached {metadata.get('issuer', config.issuer)}."
    if missing:
        message += " Provider does not advertise scope(s): " + ", ".join(missing) + "."
    return DiscoveryResult(
        ok=not missing,
        message=message,
        authorization_endpoint=metadata.get("authorization_endpoint"),
        token_endpoint=metadata.get("token_endpoint"),
        userinfo_endpoint=metadata.get("userinfo_endpoint"),
        jwks_uri=metadata.get("jwks_uri"),
    )


# ============ MCP agent activation ============

AGENT_ACTIVATION_KEY = "mcp_agent_activation_operator_id"


class AgentActivation(BaseModel):
    enabled: bool
    #: Display name of the admin who authorized agent activation.
    authorized_by: str | None = None


class AgentActivationInput(BaseModel):
    enabled: bool


def _agent_activation(db: DbSession) -> AgentActivation:
    from opal.config import get_app_setting

    raw = get_app_setting(db, AGENT_ACTIVATION_KEY)
    operator = None
    if raw and raw.isdigit():
        operator = db.query(User).filter(User.id == int(raw)).first()
    return AgentActivation(
        enabled=operator is not None,
        authorized_by=operator.name if operator is not None else None,
    )


@router.get("/agent-activation", response_model=AgentActivation)
def get_agent_activation(db: DbSession, user: RequiredUser) -> AgentActivation:
    return _agent_activation(db)


@router.put("/agent-activation", response_model=AgentActivation)
def set_agent_activation(
    body: AgentActivationInput, db: DbSession, admin: RequiredAdmin
) -> AgentActivation:
    """Opt the MCP agent in or out of activating parts.

    Enabling records the acting admin as the authorizing operator; agent
    activations then attribute to them (see opal/mcp/server.py). Sign-offs stay
    human-only regardless. Default off.
    """
    from opal.config import set_app_setting

    set_app_setting(db, AGENT_ACTIVATION_KEY, str(admin.id) if body.enabled else None)
    db.commit()
    return _agent_activation(db)


# ============ Onshape credentials ============


class OnshapeSettings(BaseModel):
    #: True when an access key and secret are both stored.
    configured: bool
    access_key: str
    base_url: str
    poll_interval_minutes: int
    has_secret_key: bool
    has_webhook_secret: bool


class OnshapeSettingsInput(BaseModel):
    access_key: str = ""
    #: Blank keeps the stored secret.
    secret_key: str = ""
    clear_secret_key: bool = False
    base_url: str = "https://cad.onshape.com"
    poll_interval_minutes: int = Field(default=15, ge=0)
    webhook_secret: str = ""
    clear_webhook_secret: bool = False


def _onshape_settings() -> OnshapeSettings:
    from opal.config import get_active_settings

    s = get_active_settings()
    return OnshapeSettings(
        configured=s.onshape_enabled,
        access_key=s.onshape_access_key,
        base_url=s.onshape_base_url,
        poll_interval_minutes=s.onshape_poll_interval_minutes,
        has_secret_key=bool(s.onshape_secret_key),
        has_webhook_secret=bool(s.onshape_webhook_secret),
    )


@router.get("/onshape", response_model=OnshapeSettings)
def get_onshape_settings(admin: RequiredAdmin) -> OnshapeSettings:
    return _onshape_settings()


@router.put("/onshape", response_model=OnshapeSettings)
def save_onshape_settings(
    body: OnshapeSettingsInput, request: Request, db: DbSession, admin: RequiredAdmin
) -> OnshapeSettings:
    """Persist Onshape credentials. Blank secret fields keep the stored values.

    Polling restarts at once, so a new interval needs no server restart.
    """
    from opal.config import apply_db_overlay, get_active_settings, set_app_setting
    from opal.extensions.loader import activate as activate_extensions

    current = get_active_settings()
    secret = "" if body.clear_secret_key else body.secret_key or current.onshape_secret_key
    webhook = (
        "" if body.clear_webhook_secret else body.webhook_secret or current.onshape_webhook_secret
    )

    # Every Onshape call carries the signed credential, so the base URL must be
    # https: a mistyped config must not point the client at an internal http target.
    base = body.base_url.strip() or "https://cad.onshape.com"
    if not base.startswith("https://") or len(base) <= len("https://"):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail="Base URL must be an https:// URL.")

    set_app_setting(db, "onshape_access_key", body.access_key.strip())
    set_app_setting(db, "onshape_secret_key", secret)
    set_app_setting(db, "onshape_base_url", base)
    set_app_setting(db, "onshape_poll_interval_minutes", str(body.poll_interval_minutes))
    set_app_setting(db, "onshape_webhook_secret", webhook)
    db.commit()
    apply_db_overlay(db)
    activate_extensions(request.app)
    return _onshape_settings()


class ConnectionResult(BaseModel):
    ok: bool
    message: str


@router.post("/onshape/test", response_model=ConnectionResult)
def test_onshape_connection(admin: RequiredAdmin) -> ConnectionResult:
    """Smoke-test the saved Onshape credentials."""
    from opal.config import get_active_settings
    from opal.integrations.onshape.client import OnshapeApiError, OnshapeClient

    s = get_active_settings()
    if not s.onshape_enabled:
        return ConnectionResult(ok=False, message="Access key and secret key are required.")
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
        return ConnectionResult(ok=True, message=f"Connected as {name}.")
    except OnshapeApiError as err:
        return ConnectionResult(ok=False, message=f"Onshape API {err.status_code}: {err.detail}")
    except json.JSONDecodeError:
        # Onshape returns an HTML login page (HTTP 200) for bad credentials,
        # which trips the JSON decoder before a 4xx is ever seen.
        return ConnectionResult(
            ok=False,
            message="Authentication failed. Check that the access and secret keys are correct.",
        )
    except Exception as err:
        return ConnectionResult(ok=False, message=f"Connection failed: {err}")


# ============ Instance lifecycle: demo data and factory reset ============


class LifecycleState(BaseModel):
    demo_active: bool
    demo_file_exists: bool
    demo_db_path: str


def _lifecycle_state() -> LifecycleState:
    from opal.core import lifecycle

    return LifecycleState(
        demo_active=lifecycle.is_demo_active(),
        demo_file_exists=lifecycle.demo_file_exists(),
        demo_db_path=str(lifecycle.demo_db_path()),
    )


@router.get("/lifecycle", response_model=LifecycleState)
def get_lifecycle(user: RequiredUser) -> LifecycleState:
    return _lifecycle_state()


@router.post("/demo/enter", response_model=LifecycleState)
def enter_demo(request: Request, response: Response, admin: RequiredAdmin) -> LifecycleState:
    """Switch the instance to the throwaway demo database."""
    from opal.core import lifecycle
    from opal.core.auth import create_session
    from opal.db.base import SessionLocal
    from opal.extensions.loader import activate as activate_extensions

    demo_user_id = lifecycle.enter_demo(admin)
    activate_extensions(request.app)

    if demo_user_id is not None:
        # Sessions live per database: mint one in the demo database so the
        # operator stays signed in across the switch.
        with SessionLocal() as demo_db:
            demo_user = demo_db.query(User).filter(User.id == demo_user_id).first()
            if demo_user:
                token = create_session(
                    demo_db,
                    demo_user,
                    auth_method="demo",
                    user_agent=request.headers.get("user-agent"),
                    ip_address=client_ip(request),
                )
                demo_db.commit()
                set_session_cookie(response, request, token)
    return _lifecycle_state()


@router.post("/demo/exit", response_model=LifecycleState)
def exit_demo(request: Request, response: Response, admin: RequiredAdmin) -> LifecycleState:
    """Leave the demo: switch back to the real database and delete the demo file."""
    from opal.core import lifecycle
    from opal.extensions.loader import activate as activate_extensions

    lifecycle.exit_demo(delete=True)
    activate_extensions(request.app)
    # Demo-database sessions mean nothing in the real database.
    clear_session_cookie(response)
    return _lifecycle_state()


@router.delete("/demo", response_model=LifecycleState)
def delete_demo_file(admin: RequiredAdmin) -> LifecycleState:
    """Delete an inactive demo database file."""
    from opal.core import lifecycle

    try:
        lifecycle.delete_demo_file()
    except RuntimeError as err:
        raise HTTPException(status.HTTP_409_CONFLICT, detail=str(err)) from err
    return _lifecycle_state()


class FactoryResetInput(BaseModel):
    confirm: str


@router.post("/factory-reset")
def factory_reset(
    body: FactoryResetInput, request: Request, response: Response, admin: RequiredAdmin
) -> dict[str, Any]:
    """Wipe the instance back to first-run state. Requires the word RESET."""
    from opal.core import lifecycle
    from opal.extensions.loader import activate as activate_extensions

    if body.confirm.strip() != "RESET":
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail="Type RESET to confirm")
    logger.warning("FACTORY RESET initiated by %s", admin.username)
    lifecycle.factory_reset()
    activate_extensions(request.app)
    clear_session_cookie(response)
    return {"ok": True}
