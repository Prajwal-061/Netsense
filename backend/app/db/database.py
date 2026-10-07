"""Database engine and readiness check.

The database is chosen by one URL (DATABASE_URL in .env). Nothing outside
this module knows whether it is SQLite or PostgreSQL.
"""

from pathlib import Path

from sqlalchemy import Engine, create_engine, event, inspect
from sqlalchemy.engine import make_url

from app.core.config import get_settings


def create_db_engine(url: str | None = None) -> Engine:
    """Create the engine for a database URL (default: DATABASE_URL)."""
    engine = create_engine(url or get_settings().database_url)
    if engine.dialect.name == "sqlite":
        # SQLite ignores foreign keys unless asked to enforce them, once per
        # connection. PostgreSQL always enforces them.
        @event.listens_for(engine, "connect")
        def _enable_foreign_keys(dbapi_connection, _):
            dbapi_connection.execute("PRAGMA foreign_keys=ON")

    return engine


def is_migrated(engine: Engine) -> bool:
    """True if the database exists and its tables have been created.

    For SQLite the file is checked first, because merely connecting would
    create an empty file (owned by root, if the caller is running under sudo).
    """
    url = make_url(str(engine.url))
    if engine.dialect.name == "sqlite" and url.database and not Path(url.database).exists():
        return False
    return inspect(engine).has_table("scans")
