"""Database engine and readiness check.

The database is chosen by one URL (DATABASE_URL in .env). Nothing outside
this module knows whether it is SQLite or PostgreSQL.
"""

from pathlib import Path

from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import Engine, create_engine, event, inspect, text
from sqlalchemy.engine import make_url
from sqlalchemy.pool import StaticPool

from app.core.config import get_settings

BACKEND_DIR = Path(__file__).resolve().parents[2]


def create_db_engine(url: str | None = None) -> Engine:
    """Create the engine for a database URL (default: DATABASE_URL)."""
    url = url or get_settings().database_url
    options = {}
    if make_url(url).get_backend_name() == "sqlite" and make_url(url).database in (None, ":memory:"):
        # An in-memory SQLite database exists only inside one connection, so
        # every session and thread must share that single connection (tests).
        options = {"poolclass": StaticPool, "connect_args": {"check_same_thread": False}}
    engine = create_engine(url, **options)
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


def migration_status(engine: Engine) -> tuple[str | None, str]:
    """Return (revision the database is at, newest revision in the code).

    They differ when the code was updated but "alembic upgrade head" has not
    been run yet: the models then expect tables or columns that do not exist.
    """
    newest = ScriptDirectory.from_config(Config(BACKEND_DIR / "alembic.ini")).get_current_head()
    if not inspect(engine).has_table("alembic_version"):
        return None, newest
    with engine.connect() as connection:
        current = connection.execute(text("select version_num from alembic_version")).scalar()
    return current, newest
