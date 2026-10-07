"""Alembic environment: connects migrations to the app's settings and models."""

from logging.config import fileConfig

from alembic import context
from sqlalchemy import create_engine

from app.db.models import Base, UTCDateTime

config = context.config
if config.config_file_name is not None:
    fileConfig(config.config_file_name)

# Autogenerate compares the database against these models.
target_metadata = Base.metadata


def database_url() -> str:
    # A URL set on the Alembic config wins (the tests use this). Normally it
    # is empty and the app's DATABASE_URL setting is used.
    url = config.get_main_option("sqlalchemy.url")
    if url:
        return url
    from app.core.config import get_settings

    return get_settings().database_url


def render_item(type_, obj, autogen_context):
    """Write our UTCDateTime type into migrations as a plain SQLAlchemy type,
    so migration files do not depend on application code."""
    if type_ == "type" and isinstance(obj, UTCDateTime):
        return "sa.DateTime(timezone=True)"
    return False


def run_migrations_offline() -> None:
    """Emit the migration as SQL text instead of running it (alembic --sql)."""
    context.configure(
        url=database_url(),
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        render_item=render_item,
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    """Connect to the database and run the migration."""
    engine = create_engine(database_url())
    with engine.connect() as connection:
        context.configure(
            connection=connection,
            target_metadata=target_metadata,
            render_item=render_item,
            # SQLite cannot ALTER most things in place. Batch mode rebuilds
            # the table instead, and is a no-op on PostgreSQL.
            render_as_batch=True,
        )
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
