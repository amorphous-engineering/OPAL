"""OpenID Connect single sign-on: discovery, the code flow, identity mapping.

Design notes
------------
- Authorization Code flow with PKCE (S256) against any spec-compliant
  provider. Pocket ID is the reference target; Authentik, Keycloak, Auth0 and
  Entra ID all speak the same handshake.
- PKCE is used unconditionally, so a public (secretless) client is safe. A
  client secret is sent when configured, for providers that require one.
- Provider metadata and JWKS are fetched from the issuer's discovery document
  and cached in-process with a TTL. OPAL runs single-process by design, so a
  module-level cache is the whole story.
- The handshake carries no server-side state: ``state``, ``nonce`` and the
  PKCE verifier travel in one short-lived HMAC-signed cookie (the same
  ``sign_payload``/``verify_payload`` mechanism the WebAuthn challenge uses).
- Identity is ``(issuer, sub)``. Email is a display attribute and may change;
  ``sub`` is the join key, which is why accounts are linked on it and only
  ever *claimed* by email once (see ``resolve_identity``).
- This module resolves a User. It never mints sessions — callers hand the User
  to ``opal.core.auth.create_session`` like every other login method.
"""

from __future__ import annotations

import base64
import hashlib
import logging
import secrets
import time
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urlencode

import httpx
import jwt
from jwt import PyJWKClient
from sqlalchemy.orm import Session

from opal.db.models.user import User

logger = logging.getLogger("opal.oidc")

STATE_COOKIE = "opal_oidc_state"
DISCOVERY_PATH = "/.well-known/openid-configuration"
DISCOVERY_TTL_SECONDS = 3600.0
HTTP_TIMEOUT = 10.0
CALLBACK_PATH = "/oidc/callback"


class OidcError(Exception):
    """A sign-in attempt failed. The message is safe to show to the user."""


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class OidcConfig:
    """Resolved OIDC settings, normalized for use."""

    issuer: str
    client_id: str
    client_secret: str
    scopes: str
    provider_name: str
    groups_claim: str
    admin_group: str
    auto_create_users: bool
    redirect_base_url: str

    @property
    def is_configured(self) -> bool:
        return bool(self.issuer and self.client_id)


def get_config() -> OidcConfig:
    """Build the OIDC config from the active settings."""
    from opal.config import get_active_settings

    s = get_active_settings()
    return OidcConfig(
        issuer=(s.oidc_issuer or "").strip().rstrip("/"),
        client_id=(s.oidc_client_id or "").strip(),
        client_secret=s.oidc_client_secret or "",
        scopes=(s.oidc_scopes or "openid profile email").strip(),
        provider_name=(s.oidc_provider_name or "SSO").strip() or "SSO",
        groups_claim=(s.oidc_groups_claim or "groups").strip(),
        admin_group=(s.oidc_admin_group or "").strip(),
        auto_create_users=bool(s.oidc_auto_create_users),
        redirect_base_url=(s.oidc_redirect_base_url or "").strip().rstrip("/"),
    )


def is_enabled() -> bool:
    """Whether OIDC sign-in should be offered."""
    from opal.config import get_active_settings

    return bool(get_active_settings().oidc_enabled) and get_config().is_configured


# ---------------------------------------------------------------------------
# Discovery
# ---------------------------------------------------------------------------


@dataclass
class _CacheEntry:
    metadata: dict[str, Any]
    fetched_at: float
    jwk_client: PyJWKClient | None = field(default=None)


_discovery_cache: dict[str, _CacheEntry] = {}


def reset_discovery_cache() -> None:
    """Drop cached provider metadata (call after a settings change)."""
    _discovery_cache.clear()


def discover(issuer: str, *, force: bool = False) -> dict[str, Any]:
    """Fetch (and cache) the issuer's OpenID provider metadata."""
    if not issuer:
        raise OidcError("No OIDC issuer is configured.")
    if not issuer.startswith("https://") and not _is_loopback(issuer):
        raise OidcError("The OIDC issuer must be an https:// URL.")

    entry = _discovery_cache.get(issuer)
    if (
        not force
        and entry is not None
        and time.monotonic() - entry.fetched_at < DISCOVERY_TTL_SECONDS
    ):
        return entry.metadata

    url = issuer + DISCOVERY_PATH
    try:
        response = httpx.get(url, timeout=HTTP_TIMEOUT, follow_redirects=True)
        response.raise_for_status()
        metadata = response.json()
    except httpx.HTTPError as exc:
        raise OidcError(f"Could not reach the identity provider at {url}: {exc}") from exc
    except ValueError as exc:
        raise OidcError(f"The identity provider at {url} did not return JSON.") from exc

    if not isinstance(metadata, dict):
        raise OidcError(f"The discovery document at {url} is not an object.")

    # The issuer in the document is authoritative and must match what we asked
    # for; a mismatch means we are talking to the wrong provider.
    advertised = str(metadata.get("issuer", "")).rstrip("/")
    if advertised and advertised != issuer:
        raise OidcError(f"Issuer mismatch: configured {issuer}, provider advertises {advertised}.")

    for required in ("authorization_endpoint", "token_endpoint"):
        if not metadata.get(required):
            raise OidcError(f"The discovery document is missing {required}.")

    _discovery_cache[issuer] = _CacheEntry(metadata=metadata, fetched_at=time.monotonic())
    return metadata


def _is_loopback(url: str) -> bool:
    """Allow plain http only for loopback issuers (local development)."""
    return url.startswith("http://localhost") or url.startswith("http://127.0.0.1")


def _jwk_client(issuer: str, metadata: dict[str, Any]) -> PyJWKClient:
    """Get a cached JWKS client for the issuer."""
    entry = _discovery_cache.get(issuer)
    if entry is not None and entry.jwk_client is not None:
        return entry.jwk_client
    jwks_uri = metadata.get("jwks_uri")
    if not jwks_uri:
        raise OidcError("The discovery document is missing jwks_uri.")
    client = PyJWKClient(jwks_uri, cache_keys=True, timeout=int(HTTP_TIMEOUT))
    if entry is not None:
        entry.jwk_client = client
    return client


# ---------------------------------------------------------------------------
# The handshake
# ---------------------------------------------------------------------------


def redirect_uri(request_base_url: str, config: OidcConfig) -> str:
    """The callback URL registered with the provider.

    Derived from the request unless ``oidc_redirect_base_url`` pins it, which
    a reverse proxy that rewrites the host requires.
    """
    base = config.redirect_base_url or request_base_url.rstrip("/")
    return base + CALLBACK_PATH


def make_pkce_pair() -> tuple[str, str]:
    """Return (code_verifier, code_challenge) for PKCE S256."""
    verifier = secrets.token_urlsafe(64)
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    challenge = base64.urlsafe_b64encode(digest).decode("ascii").rstrip("=")
    return verifier, challenge


def build_authorization_url(
    config: OidcConfig,
    callback_url: str,
    state: str,
    nonce: str,
    code_challenge: str,
) -> str:
    """Build the provider's authorization URL for the code flow."""
    metadata = discover(config.issuer)
    params = {
        "response_type": "code",
        "client_id": config.client_id,
        "redirect_uri": callback_url,
        "scope": config.scopes,
        "state": state,
        "nonce": nonce,
        "code_challenge": code_challenge,
        "code_challenge_method": "S256",
    }
    return f"{metadata['authorization_endpoint']}?{urlencode(params)}"


def exchange_code(
    config: OidcConfig, code: str, callback_url: str, code_verifier: str
) -> dict[str, Any]:
    """Trade an authorization code for tokens at the token endpoint."""
    metadata = discover(config.issuer)
    data = {
        "grant_type": "authorization_code",
        "code": code,
        "redirect_uri": callback_url,
        "client_id": config.client_id,
        "code_verifier": code_verifier,
    }
    auth: tuple[str, str] | None = None
    if config.client_secret:
        # client_secret_basic is the spec default; providers that only accept
        # client_secret_post advertise it, so honour that when they do.
        methods = metadata.get("token_endpoint_auth_methods_supported") or ["client_secret_basic"]
        if "client_secret_basic" in methods:
            auth = (config.client_id, config.client_secret)
        else:
            data["client_secret"] = config.client_secret

    try:
        response = httpx.post(
            metadata["token_endpoint"], data=data, auth=auth, timeout=HTTP_TIMEOUT
        )
    except httpx.HTTPError as exc:
        raise OidcError(f"Token exchange failed: {exc}") from exc

    if response.status_code != 200:
        detail = ""
        try:
            body = response.json()
            detail = str(body.get("error_description") or body.get("error") or "")
        except ValueError:
            pass
        logger.warning("OIDC token exchange rejected (%s): %s", response.status_code, detail)
        raise OidcError(f"The identity provider rejected the sign-in. {detail}".strip())

    try:
        tokens = response.json()
    except ValueError as exc:
        raise OidcError("The token endpoint did not return JSON.") from exc
    if "id_token" not in tokens:
        raise OidcError("The token response carried no id_token.")
    return tokens


def verify_id_token(config: OidcConfig, id_token: str, nonce: str) -> dict[str, Any]:
    """Verify the ID token's signature, issuer, audience and nonce."""
    metadata = discover(config.issuer)
    jwk_client = _jwk_client(config.issuer, metadata)
    try:
        signing_key = jwk_client.get_signing_key_from_jwt(id_token)
    except Exception as exc:  # network failure, unknown kid, malformed token
        raise OidcError(f"Could not verify the identity token signature: {exc}") from exc

    algorithms = metadata.get("id_token_signing_alg_values_supported") or ["RS256"]
    # Never accept unsigned tokens, whatever the provider advertises.
    algorithms = [a for a in algorithms if a.lower() != "none"]
    if not algorithms:
        raise OidcError("The provider advertises no usable signing algorithm.")

    try:
        claims = jwt.decode(
            id_token,
            signing_key.key,
            algorithms=algorithms,
            audience=config.client_id,
            issuer=metadata.get("issuer", config.issuer),
            options={"require": ["exp", "iat", "iss", "sub", "aud"]},
        )
    except jwt.PyJWTError as exc:
        raise OidcError(f"The identity token is not valid: {exc}") from exc

    if claims.get("nonce") != nonce:
        raise OidcError("The identity token nonce did not match. Please try signing in again.")
    return claims


def fetch_userinfo(config: OidcConfig, access_token: str) -> dict[str, Any]:
    """Read the userinfo endpoint. Returns {} when unavailable.

    Providers differ on which claims ride in the ID token versus userinfo —
    Pocket ID puts groups in both, others only in userinfo — so this is a
    best-effort enrichment, never a hard requirement.
    """
    metadata = discover(config.issuer)
    endpoint = metadata.get("userinfo_endpoint")
    if not endpoint or not access_token:
        return {}
    try:
        response = httpx.get(
            endpoint,
            headers={"Authorization": f"Bearer {access_token}"},
            timeout=HTTP_TIMEOUT,
        )
        response.raise_for_status()
        body = response.json()
    except (httpx.HTTPError, ValueError) as exc:
        logger.info("OIDC userinfo unavailable (%s); using id_token claims only", exc)
        return {}
    return body if isinstance(body, dict) else {}


# ---------------------------------------------------------------------------
# Handshake state (stateless, in a signed cookie)
# ---------------------------------------------------------------------------

STATE_MAX_AGE = 600  # seconds; a user has 10 minutes to complete the handshake


def sign_state(payload: dict[str, Any]) -> str:
    """Sign the handshake state (state, nonce, PKCE verifier, next) for a cookie."""
    from datetime import timedelta

    from opal.core.auth import sign_payload

    return sign_payload({**payload, "kind": "oidc-state"}, max_age=timedelta(seconds=STATE_MAX_AGE))


def verify_state(value: str | None) -> dict[str, Any] | None:
    """Recover handshake state from the cookie. None when absent or expired."""
    from opal.core.auth import verify_payload

    payload = verify_payload(value)
    if not payload or payload.get("kind") != "oidc-state":
        return None
    if not all(payload.get(k) for k in ("state", "nonce", "verifier")):
        return None
    return payload


# ---------------------------------------------------------------------------
# Claim mapping
# ---------------------------------------------------------------------------


def extract_groups(claims: dict[str, Any], groups_claim: str) -> list[str]:
    """Read the group list out of the claims, tolerating provider variance."""
    raw = claims.get(groups_claim)
    if raw is None:
        return []
    if isinstance(raw, str):
        # Some providers emit a space- or comma-separated string.
        return [part for part in raw.replace(",", " ").split() if part]
    if isinstance(raw, list):
        return [str(item) for item in raw if item is not None]
    return []


def _display_name(claims: dict[str, Any], email: str | None, subject: str) -> str:
    for key in ("name", "preferred_username", "nickname"):
        value = claims.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()[:255]
    given = str(claims.get("given_name") or "").strip()
    family = str(claims.get("family_name") or "").strip()
    if given or family:
        return f"{given} {family}".strip()[:255]
    if email:
        local = email.split("@")[0]
        return local.replace(".", " ").replace("_", " ").replace("-", " ").title()[:255]
    return subject[:255]


# ---------------------------------------------------------------------------
# Identity resolution
# ---------------------------------------------------------------------------


def resolve_identity(db: Session, config: OidcConfig, claims: dict[str, Any]) -> User:
    """Map verified claims to an OPAL user, provisioning when allowed.

    Matching order:
    1. ``(oidc_issuer, oidc_subject)`` — the stable identity link.
    2. An existing account with the same email and no OIDC link yet, which is
       claimed once and thereafter matched by subject. This is what lets an
       existing password account adopt SSO without losing its history.
    3. Auto-provision, when enabled.

    Raises OidcError when the identity may not sign in.
    """
    subject = str(claims.get("sub") or "").strip()
    if not subject:
        raise OidcError("The identity provider returned no subject claim.")

    email_raw = claims.get("email")
    email = str(email_raw).strip().lower() if isinstance(email_raw, str) and email_raw else None
    if email and claims.get("email_verified") is False:
        # An unverified email must never be used to claim an existing account.
        email = None
        unverified = True
    else:
        unverified = False

    groups = extract_groups(claims, config.groups_claim)
    grants_admin = bool(config.admin_group) and config.admin_group in groups

    user = (
        db.query(User)
        .filter(User.oidc_issuer == config.issuer, User.oidc_subject == subject)
        .first()
    )

    if user is None and email:
        candidate = db.query(User).filter(User.email == email, User.oidc_subject.is_(None)).first()
        if candidate is not None:
            candidate.oidc_issuer = config.issuer
            candidate.oidc_subject = subject
            logger.info("Linked OIDC identity %s to existing user %s", subject, candidate.username)
            user = candidate

    if user is None:
        if not config.auto_create_users:
            raise OidcError(
                "This identity has no OPAL account. Ask an administrator to create one"
                + (" for " + email if email else "")
                + "."
            )
        if unverified:
            raise OidcError(
                "The identity provider reports this email address as unverified. "
                "Verify it, then sign in again."
            )
        # The very first account on a fresh install is admin regardless of
        # groups, so an operator cannot lock themselves out of a new instance.
        bootstrap_admin = db.query(User.id).first() is None
        user = _provision(db, config, claims, subject, email, bootstrap_admin=bootstrap_admin)
    else:
        bootstrap_admin = False

    if not user.is_active:
        raise OidcError("This account is deactivated.")

    # Attributes the IdP owns are refreshed on every sign-in.
    if email and user.email != email:
        # Guard the unique constraint: another account already holding this
        # address means the IdP and OPAL disagree, so leave OPAL's value alone.
        clash = db.query(User).filter(User.email == email, User.id != user.id).first()
        if clash is None:
            user.email = email
    if config.admin_group and not bootstrap_admin:
        user.is_admin = grants_admin
    if user.needs_profile_setup and user.name.strip():
        user.needs_profile_setup = False

    db.flush()
    return user


def _provision(
    db: Session,
    config: OidcConfig,
    claims: dict[str, Any],
    subject: str,
    email: str | None,
    *,
    bootstrap_admin: bool,
) -> User:
    """Create an account for a first-time OIDC identity."""
    from opal.core.auth import generate_unique_username

    name = _display_name(claims, email, subject)
    seed = str(claims.get("preferred_username") or "") or (email.split("@")[0] if email else name)

    grants_admin = bool(config.admin_group) and config.admin_group in extract_groups(
        claims, config.groups_claim
    )

    user = User(
        name=name,
        username=generate_unique_username(db, seed),
        email=email,
        password_hash=None,
        oidc_issuer=config.issuer,
        oidc_subject=subject,
        is_active=True,
        is_admin=bootstrap_admin or grants_admin,
        needs_profile_setup=not bool(name.strip()),
    )
    db.add(user)
    db.flush()
    logger.info(
        "Provisioned OIDC user %s (sub=%s, admin=%s)", user.username, subject, user.is_admin
    )
    return user
