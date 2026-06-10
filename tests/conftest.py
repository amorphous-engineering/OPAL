"""Pytest configuration and fixtures."""

import os
from collections.abc import Generator
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

# Set test environment before importing app
os.environ["OPAL_DATABASE_URL"] = "sqlite:///:memory:"
os.environ["OPAL_DEBUG"] = "false"

from opal.api.app import create_app
from opal.api.deps import get_db
from opal.core.auth import create_api_token, create_session, hash_password
from opal.db.base import Base
from opal.db.models import User

TEST_PASSWORD = "test-password-123"


@pytest.fixture(scope="session")
def engine():
    """Create test database engine."""
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
    )
    return engine


@pytest.fixture(scope="session")
def tables(engine):
    """Create all database tables."""
    Base.metadata.create_all(bind=engine)
    yield
    Base.metadata.drop_all(bind=engine)


@pytest.fixture
def db_session(engine, tables) -> Generator[Session, None, None]:
    """Create a new database session for each test."""
    connection = engine.connect()
    transaction = connection.begin()

    SessionLocal = sessionmaker(bind=connection)
    session = SessionLocal()

    yield session

    session.close()
    transaction.rollback()
    connection.close()


@pytest.fixture
def client(db_session: Session, monkeypatch) -> Generator[TestClient, None, None]:
    """Create test client with overridden database dependency.

    The client is pre-authenticated with a dedicated admin service user via a
    bearer token (the API requires auth on every business endpoint). Tests
    that need a specific identity pass auth_headers/admin_headers per request,
    which override the default Authorization header.

    The global session factory is also pointed at the test connection so the
    auth middleware (which resolves sessions outside request dependencies)
    sees the same data as the routes.
    """
    import opal.db.base as db_base

    connection = db_session.get_bind()
    test_factory = sessionmaker(autocommit=False, autoflush=False, bind=connection)
    monkeypatch.setattr(db_base, "_session_local", test_factory)

    app = create_app()

    def override_get_db():
        yield db_session

    app.dependency_overrides[get_db] = override_get_db

    service_user = User(
        name="Test Client",
        username="test.client",
        password_hash=hash_password(TEST_PASSWORD),
        is_active=True,
        is_admin=True,
    )
    db_session.add(service_user)
    db_session.flush()
    _, raw_token = create_api_token(db_session, service_user, "tests")
    db_session.commit()

    with TestClient(app, headers={"Authorization": f"Bearer {raw_token}"}) as test_client:
        yield test_client


@pytest.fixture
def test_user(db_session: Session) -> User:
    """Create a test user."""
    user = User(
        name="Test User",
        username="testuser",
        password_hash=hash_password(TEST_PASSWORD),
        email="test@example.com",
    )
    db_session.add(user)
    db_session.commit()
    db_session.refresh(user)
    return user


@pytest.fixture
def auth_headers(db_session: Session, test_user: User) -> dict[str, Any]:
    """Bearer-token authentication headers for test_user."""
    _, raw_token = create_api_token(db_session, test_user, "tests")
    db_session.commit()
    return {"Authorization": f"Bearer {raw_token}"}


@pytest.fixture
def admin_user(db_session: Session) -> User:
    """Create an admin test user."""
    user = User(
        name="Admin User",
        username="adminuser",
        password_hash=hash_password(TEST_PASSWORD),
        email="admin@example.com",
        is_admin=True,
    )
    db_session.add(user)
    db_session.commit()
    db_session.refresh(user)
    return user


@pytest.fixture
def admin_headers(db_session: Session, admin_user: User) -> dict[str, Any]:
    """Bearer-token authentication headers for admin_user."""
    _, raw_token = create_api_token(db_session, admin_user, "tests")
    db_session.commit()
    return {"Authorization": f"Bearer {raw_token}"}


@pytest.fixture
def web_client(client: TestClient, db_session: Session, test_user: User) -> TestClient:
    """TestClient with a logged-in web session for test_user."""
    from opal.core.auth import SESSION_COOKIE

    token = create_session(db_session, test_user)
    db_session.commit()
    client.cookies.set(SESSION_COOKIE, token)
    return client
