"""User avatars: storage, URLs and the OIDC ``picture`` fetch.

Files live under ``<upload_dir>/avatars`` next to attachments, never in the
repo. ``user.avatar_source`` records where the current state came from:
``upload`` (the user chose it), ``oidc`` (pulled from the provider), ``removed``
(the user deleted it; the provider must not refill it) or NULL.
"""

import logging
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import httpx
from sqlalchemy.orm import Session

from opal.config import get_active_settings
from opal.db.models import User

logger = logging.getLogger("opal.avatars")

MAX_AVATAR_BYTES = 2 * 1024 * 1024
FETCH_TIMEOUT_SECONDS = 5.0
EXTENSIONS = {"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif"}


def avatar_dir() -> Path:
    return get_active_settings().upload_dir / "avatars"


def avatar_path(user: User) -> Path | None:
    if not user.avatar_filename:
        return None
    return avatar_dir() / user.avatar_filename


def avatar_url(user: User | None) -> str | None:
    """Versioned URL of the user's photo, or None (the client draws initials)."""
    if user is None or not user.avatar_filename or user.avatar_source == "removed":
        return None
    stamp = user.avatar_updated_at
    version = int(stamp.timestamp()) if stamp else 0
    return f"/api/users/{user.id}/avatar?v={version}"


def sniff_image(data: bytes) -> str | None:
    """The mime type of PNG/JPEG/WebP/GIF bytes, from the magic number."""
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if data[:6] in (b"GIF87a", b"GIF89a"):
        return "image/gif"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    return None


def _remove_file(user: User) -> None:
    path = avatar_path(user)
    if path is not None:
        path.unlink(missing_ok=True)


def store_avatar(user: User, data: bytes, mime: str, source: str) -> None:
    """Write ``data`` as the user's avatar, replacing any previous file.
    The caller commits."""
    directory = avatar_dir()
    directory.mkdir(parents=True, exist_ok=True)
    filename = f"{user.id}-{uuid.uuid4().hex}.{EXTENSIONS[mime]}"
    (directory / filename).write_bytes(data)
    _remove_file(user)
    user.avatar_filename = filename
    user.avatar_mime = mime
    user.avatar_source = source
    user.avatar_updated_at = datetime.now(UTC)


def remove_avatar(user: User) -> None:
    """Delete the file and record that the user removed it. The caller commits."""
    _remove_file(user)
    user.avatar_filename = None
    user.avatar_mime = None
    user.avatar_source = "removed"
    user.avatar_updated_at = datetime.now(UTC)


def fetch_picture(url: str) -> tuple[bytes, str] | None:
    """Download an avatar image. Returns (bytes, mime) or None.

    http(s) only, 5 s timeout, at most 2 MB (streamed), ``image/*`` content type
    and PNG/JPEG/WebP/GIF content only. Every failure is logged, never raised.
    """
    if not url.lower().startswith(("http://", "https://")):
        logger.info("Ignoring OIDC picture with unsupported scheme")
        return None
    try:
        with httpx.stream(
            "GET", url, timeout=FETCH_TIMEOUT_SECONDS, follow_redirects=True
        ) as response:
            response.raise_for_status()
            declared = response.headers.get("content-type", "").split(";")[0].strip().lower()
            if not declared.startswith("image/"):
                logger.info("OIDC picture rejected: content type %r", declared)
                return None
            length = response.headers.get("content-length")
            if length and length.isdigit() and int(length) > MAX_AVATAR_BYTES:
                logger.info("OIDC picture rejected: %s bytes exceeds the cap", length)
                return None
            body = bytearray()
            for chunk in response.iter_bytes():
                body.extend(chunk)
                if len(body) > MAX_AVATAR_BYTES:
                    logger.info("OIDC picture rejected: larger than the cap")
                    return None
    except (httpx.HTTPError, ValueError) as exc:
        logger.info("OIDC picture fetch failed: %s", exc)
        return None
    mime = sniff_image(bytes(body))
    if mime is None:
        logger.info("OIDC picture rejected: not a PNG, JPEG, WebP or GIF")
        return None
    return bytes(body), mime


def refresh_from_oidc(db: Session, user: User, claims: dict[str, Any]) -> bool:
    """On OIDC sign-in, take the provider's ``picture`` when the user has not
    chosen otherwise (source NULL or ``oidc``). Never raises; returns whether
    the avatar changed. The caller commits."""
    try:
        picture = claims.get("picture")
        if not isinstance(picture, str) or not picture.strip():
            return False
        if user.avatar_source not in (None, "oidc"):
            return False
        fetched = fetch_picture(picture.strip())
        if fetched is None:
            return False
        data, mime = fetched
        with db.begin_nested():
            store_avatar(user, data, mime, "oidc")
        return True
    except Exception:
        logger.exception("OIDC avatar refresh failed for user %s", getattr(user, "id", "?"))
        return False
