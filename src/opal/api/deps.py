"""FastAPI dependencies."""

from collections.abc import Generator
from typing import Annotated

from fastapi import Depends, Header, HTTPException, Request, status
from sqlalchemy.orm import Session

from opal.core.auth import SESSION_COOKIE, resolve_api_token, resolve_session
from opal.db.base import SessionLocal
from opal.db.models import User


def get_db() -> Generator[Session, None, None]:
    """Get database session dependency."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


# Type alias for database session dependency
DbSession = Annotated[Session, Depends(get_db)]


def get_current_user(
    request: Request,
    db: DbSession,
    authorization: Annotated[str | None, Header()] = None,
) -> User | None:
    """Resolve the authenticated user for this request.

    Two credentials are accepted:
    - the ``opal_session`` cookie (browser sessions minted at login)
    - ``Authorization: Bearer opal_...`` API tokens (TUI, scripts)

    Returns None when neither is present and valid.
    """
    user = resolve_session(db, request.cookies.get(SESSION_COOKIE))
    if user is not None:
        return user
    if authorization and authorization.lower().startswith("bearer "):
        return resolve_api_token(db, authorization[7:].strip())
    return None


# Type alias for current user dependency
CurrentUser = Annotated[User | None, Depends(get_current_user)]


def get_current_user_id(user: CurrentUser) -> int | None:
    """Authenticated user's id, or None (for audit attribution)."""
    return user.id if user else None


# Type alias for user ID dependency
CurrentUserId = Annotated[int | None, Depends(get_current_user_id)]


def require_user(
    user: CurrentUser,
) -> User:
    """Require an authenticated user for the request.

    Raises 401 when no valid session cookie or bearer token was presented.
    """
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authentication required (session cookie or bearer API token)",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return user


# Type alias for required user dependency
RequiredUser = Annotated[User, Depends(require_user)]


def require_admin(
    user: RequiredUser,
) -> User:
    """Require an admin user for the request.

    Raises 403 if user is not an admin.
    """
    if not user.is_admin:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Admin access required",
        )
    return user


# Type alias for required admin dependency
RequiredAdmin = Annotated[User, Depends(require_admin)]


class Pagination:
    """Pagination parameters."""

    def __init__(
        self,
        skip: int = 0,
        limit: int = 100,
    ):
        if limit > 1000:
            limit = 1000
        if skip < 0:
            skip = 0
        self.skip = skip
        self.limit = limit


# Type alias for pagination dependency
PaginationParams = Annotated[Pagination, Depends()]
