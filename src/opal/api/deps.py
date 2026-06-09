"""FastAPI dependencies."""

from collections.abc import Generator
from typing import Annotated

from fastapi import Depends, Header, HTTPException, Request, status
from sqlalchemy.orm import Session

from opal.core.auth import AUTH_COOKIE, verify_user_id
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


def get_current_user_id(
    request: Request,
    x_user_id: Annotated[int | None, Header()] = None,
) -> int | None:
    """Get current user ID for the request.

    Prefers the signed session cookie (browser sessions, cannot be forged).
    Falls back to the X-User-Id header for programmatic clients (TUI, MCP),
    which remain honor-system on the local network.
    """
    cookie_user_id = verify_user_id(request.cookies.get(AUTH_COOKIE))
    if cookie_user_id is not None:
        return cookie_user_id
    return x_user_id


# Type alias for user ID dependency
CurrentUserId = Annotated[int | None, Depends(get_current_user_id)]


def get_current_user(
    db: DbSession,
    user_id: CurrentUserId,
) -> User | None:
    """Get current user from database.

    Returns None if no user ID provided or user not found.
    """
    if user_id is None:
        return None
    return db.query(User).filter(User.id == user_id).first()


# Type alias for current user dependency
CurrentUser = Annotated[User | None, Depends(get_current_user)]


def require_user(
    user: CurrentUser,
) -> User:
    """Require a valid user for the request.

    Raises 401 if no user provided.
    """
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="User identification required (X-User-Id header)",
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
