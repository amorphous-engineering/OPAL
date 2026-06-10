"""FIDO2/WebAuthn passkey service (python-fido2 wrapper).

Passkeys are registered as discoverable credentials so login can be
usernameless: the browser presents any matching credential for this RP and
we look it up by credential id.

Deployment constraints (inherent to WebAuthn, not OPAL):
- Browsers only expose WebAuthn in secure contexts: https://, or localhost.
- Credentials bind to the RP ID (the hostname). Serving OPAL from a stable
  hostname (e.g. opal.shop.local behind TLS) is required for passkeys to
  survive; raw IP addresses are not valid RP IDs.

The RP ID defaults to the request hostname and can be pinned with
OPAL_PASSKEY_RP_ID once a deployment hostname is chosen.
"""

import logging
from datetime import UTC, datetime

from fido2.server import Fido2Server
from fido2.webauthn import (
    AttestedCredentialData,
    PublicKeyCredentialRpEntity,
    PublicKeyCredentialUserEntity,
    ResidentKeyRequirement,
    UserVerificationRequirement,
)
from sqlalchemy.orm import Session

from opal.db.models.auth import PasskeyCredential
from opal.db.models.user import User

logger = logging.getLogger("opal.webauthn")

RP_NAME = "OPAL"


def rp_id_for_host(host: str | None) -> str:
    """Derive the WebAuthn RP ID: configured override, else request hostname."""
    from opal.config import get_active_settings

    configured = getattr(get_active_settings(), "passkey_rp_id", "")
    if configured:
        return configured
    hostname = (host or "localhost").split(":")[0]
    return hostname or "localhost"


def _server(rp_id: str) -> Fido2Server:
    return Fido2Server(PublicKeyCredentialRpEntity(id=rp_id, name=RP_NAME))


def _user_credentials(db: Session, user_id: int) -> list[AttestedCredentialData]:
    rows = db.query(PasskeyCredential).filter(PasskeyCredential.user_id == user_id).all()
    return [AttestedCredentialData(row.public_key) for row in rows]


def begin_registration(db: Session, user: User, rp_id: str) -> tuple[dict, dict]:
    """Start passkey registration. Returns (browser options, server state)."""
    server = _server(rp_id)
    options, state = server.register_begin(
        PublicKeyCredentialUserEntity(
            id=str(user.id).encode(),
            name=user.username,
            display_name=user.name or user.username,
        ),
        credentials=_user_credentials(db, user.id),
        user_verification=UserVerificationRequirement.PREFERRED,
        resident_key_requirement=ResidentKeyRequirement.REQUIRED,
    )
    return dict(options), dict(state)


def complete_registration(
    db: Session,
    user: User,
    rp_id: str,
    state: dict,
    response: dict,
    name: str,
) -> PasskeyCredential:
    """Finish registration and persist the credential."""
    server = _server(rp_id)
    auth_data = server.register_complete(state, response)
    cred_data = auth_data.credential_data
    if cred_data is None:
        raise ValueError("Registration response contained no credential data")

    transports = response.get("response", {}).get("transports") or []
    credential = PasskeyCredential(
        user_id=user.id,
        credential_id=bytes(cred_data.credential_id),
        public_key=bytes(cred_data),
        sign_count=auth_data.counter or 0,
        name=name[:100] or "Passkey",
        aaguid=str(cred_data.aaguid) if cred_data.aaguid else None,
        transports=",".join(transports)[:100] or None,
    )
    db.add(credential)
    db.flush()
    return credential


def begin_authentication(rp_id: str) -> tuple[dict, dict]:
    """Start usernameless authentication. Returns (browser options, state).

    No allowCredentials list is sent: the authenticator offers whatever
    discoverable credentials it holds for this RP.
    """
    server = _server(rp_id)
    options, state = server.authenticate_begin(
        credentials=[],
        user_verification=UserVerificationRequirement.PREFERRED,
    )
    return dict(options), dict(state)


def complete_authentication(
    db: Session,
    rp_id: str,
    state: dict,
    response: dict,
) -> User | None:
    """Verify an assertion and return the credential's active user."""
    raw_id = response.get("rawId") or response.get("id")
    if not raw_id:
        return None
    from fido2.utils import websafe_decode

    try:
        credential_id = websafe_decode(raw_id)
    except Exception:
        return None

    row = (
        db.query(PasskeyCredential).filter(PasskeyCredential.credential_id == credential_id).first()
    )
    if row is None:
        return None

    server = _server(rp_id)
    try:
        server.authenticate_complete(state, [AttestedCredentialData(row.public_key)], response)
    except Exception as exc:
        logger.warning("Passkey assertion failed: %s", exc)
        return None

    # Basic clone detection: a signature counter that goes backwards while
    # counters are in use means a copied credential. Many passkey providers
    # always report 0, so only enforce when the stored counter is in use.
    new_count = _assertion_counter(response)
    if row.sign_count and new_count and new_count <= row.sign_count:
        logger.warning(
            "Passkey counter regression for credential %s (stored=%s, got=%s)",
            row.id,
            row.sign_count,
            new_count,
        )
        return None
    if new_count:
        row.sign_count = new_count
    row.last_used_at = datetime.now(UTC)

    return db.query(User).filter(User.id == row.user_id, User.is_active.is_(True)).first()


def _assertion_counter(response: dict) -> int:
    """Extract the signature counter from an assertion response, or 0."""
    from fido2.utils import websafe_decode
    from fido2.webauthn import AuthenticatorData

    try:
        auth_data = AuthenticatorData(websafe_decode(response["response"]["authenticatorData"]))
        return auth_data.counter or 0
    except Exception:
        return 0
