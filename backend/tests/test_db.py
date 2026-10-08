"""Database tests: the models, and the migration that creates them."""

from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import inspect
from sqlalchemy.exc import IntegrityError

from app.db.database import create_db_engine, is_migrated
from app.db.models import Base, Device, Scan, ScanResult

BACKEND = Path(__file__).resolve().parents[1]


def test_migrations_build_the_schema_the_models_describe(tmp_path):
    url = f"sqlite:///{tmp_path / 'test.db'}"
    config = Config(BACKEND / "alembic.ini")
    config.set_main_option("sqlalchemy.url", url)

    command.upgrade(config, "head")

    tables = set(inspect(create_db_engine(url)).get_table_names())
    assert set(Base.metadata.tables) <= tables
    # Raises if a model was changed without a matching migration.
    command.check(config)


def test_is_migrated(tmp_path):
    engine = create_db_engine(f"sqlite:///{tmp_path / 'new.db'}")

    assert not is_migrated(engine)
    # Checking must not create an empty database file as a side effect.
    assert not (tmp_path / "new.db").exists()

    Base.metadata.create_all(engine)
    assert is_migrated(engine)


def test_timestamps_come_back_as_utc(session):
    # 12:00 at UTC+5:45 (Nepal) is 06:15 UTC.
    nepal = timezone(timedelta(hours=5, minutes=45))
    session.add(Scan(subnet="192.168.17.0/24", started_at=datetime(2026, 10, 7, 12, 0, tzinfo=nepal)))
    session.commit()
    session.expire_all()

    started = session.query(Scan).one().started_at
    assert started == datetime(2026, 10, 7, 6, 15, tzinfo=timezone.utc)
    assert started.tzinfo is not None


def test_naive_timestamps_are_rejected(session):
    session.add(Scan(subnet="192.168.17.0/24", started_at=datetime(2026, 10, 7, 12, 0)))

    with pytest.raises(Exception, match="Naive datetime"):
        session.commit()


def test_a_mac_address_can_only_belong_to_one_device(session):
    session.add(Device(mac="aa:bb:cc:00:01:00", last_ip="192.168.17.10"))
    session.add(Device(mac="aa:bb:cc:00:01:00", last_ip="192.168.17.11"))

    with pytest.raises(IntegrityError):
        session.commit()


def test_foreign_keys_are_enforced_on_sqlite(session):
    session.add(ScanResult(scan_id=999, device_id=999, ip="192.168.17.10", device_type="unknown"))

    with pytest.raises(IntegrityError):
        session.commit()


def test_migration_rehashes_existing_config_backups(tmp_path):
    import hashlib
    import sqlite3

    from app.engine.config_diff import config_hash
    from tests.sample_configs import BASE, SAME_LATER

    path = tmp_path / "old.db"
    config = Config(BACKEND / "alembic.ini")
    config.set_main_option("sqlalchemy.url", f"sqlite:///{path}")

    # A database from before normalisation: the hash is of the raw text.
    command.upgrade(config, "0001")
    raw_hash = hashlib.sha256(BASE.encode()).hexdigest()
    with sqlite3.connect(path) as db:
        db.execute(
            "insert into config_backups (host, collected_at, last_seen_at, sha256, config) "
            "values ('192.168.17.10', '2026-10-07 20:35:30', '2026-10-07 20:35:30', ?, ?)",
            (raw_hash, BASE),
        )

    command.upgrade(config, "head")

    with sqlite3.connect(path) as db:
        stored, text = db.execute("select sha256, config from config_backups").fetchone()
    assert stored == config_hash(BASE) == config_hash(SAME_LATER)
    assert stored != raw_hash
    assert text == BASE  # the config itself is untouched

    command.downgrade(config, "0001")
    with sqlite3.connect(path) as db:
        assert db.execute("select sha256 from config_backups").fetchone()[0] == raw_hash
