"""Dependencies shared by the routes.

FastAPI calls these for each request and passes the result into the route
function (dependency injection). Tests swap them for fakes with
app.dependency_overrides, e.g. an in-memory database.
"""

from collections.abc import Iterator
from functools import lru_cache

from fastapi import Depends
from sqlalchemy import Engine
from sqlalchemy.orm import Session

from app.db.database import create_db_engine


@lru_cache
def get_engine() -> Engine:
    """The one database engine (connection pool) for the whole application."""
    return create_db_engine()


def get_session(engine: Engine = Depends(get_engine)) -> Iterator[Session]:
    """A database session that lives for one request and is then closed."""
    with Session(engine) as session:
        yield session
