"""Shared fixtures."""

import os

# Set before any app module is imported. Environment variables win over .env,
# so tests can never pick up real credentials or open the real database.
os.environ.update(
    {
        "LAB_SWITCH_HOST": "192.0.2.10",
        "LAB_SWITCH_USERNAME": "test-user",
        "LAB_SWITCH_PASSWORD": "test-password",
        "ALLOWED_SUBNETS": "192.168.17.0/24",
        "DATABASE_URL": "sqlite://",
        "CORS_ORIGINS": "http://localhost:5173",
    }
)

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from sqlalchemy.orm import Session  # noqa: E402

from app.db.database import create_db_engine  # noqa: E402
from app.db.models import Base  # noqa: E402


@pytest.fixture
def engine():
    """A fresh in-memory SQLite database, gone after the test."""
    engine = create_db_engine("sqlite://")
    Base.metadata.create_all(engine)
    yield engine
    engine.dispose()


@pytest.fixture
def session(engine):
    with Session(engine) as session:
        yield session


def _api_client(engine):
    from app.api.deps import get_engine
    from app.main import app

    app.dependency_overrides[get_engine] = lambda: engine
    return TestClient(app)


@pytest.fixture
def anon_client(engine):
    """An HTTP client that has not logged in."""
    from app.services import auth_service

    auth_service.login_limiter._failures.clear()
    yield _api_client(engine)
    from app.main import app

    app.dependency_overrides.clear()


@pytest.fixture
def client(engine):
    """An HTTP client logged in as the admin, with the API using the test database.

    The session is created directly: hashing a password with argon2 for every
    test would make the suite slow. Logging in for real is tested in test_auth.py.
    """
    from app.api.auth import COOKIE_NAME
    from app.db.models import AdminUser
    from app.services import auth_service

    with Session(engine) as session:
        user = AdminUser(username="admin", password_hash="not-used-here")
        session.add(user)
        session.commit()
        token, _ = auth_service.create_session(session, user, hours=1)
    api = _api_client(engine)
    api.cookies.set(COOKIE_NAME, token)
    yield api
    from app.main import app

    app.dependency_overrides.clear()
