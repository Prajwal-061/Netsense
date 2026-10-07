"""Shared fixtures."""

import pytest
from sqlalchemy.orm import Session

from app.db.database import create_db_engine
from app.db.models import Base


@pytest.fixture
def session():
    """A session on a fresh in-memory SQLite database, gone after the test."""
    engine = create_db_engine("sqlite://")
    Base.metadata.create_all(engine)
    with Session(engine) as session:
        yield session
    engine.dispose()
