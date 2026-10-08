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


def test_migration_merges_duplicate_backups_and_fixes_old_style_hashes(tmp_path):
    import hashlib
    import sqlite3

    from app.engine.config_diff import config_hash
    from tests.sample_configs import BASE, NEW_VLAN, SAME_LATER

    path = tmp_path / "mixed.db"
    config = Config(BACKEND / "alembic.ini")
    config.set_main_option("sqlalchemy.url", f"sqlite:///{path}")
    command.upgrade(config, "0002")

    def raw(text):
        return hashlib.sha256(text.encode()).hexdigest()

    # What a backend running pre-0002 code left behind: #3 and #4 repeat the
    # configuration of #2 and carry raw-text hashes. #5 is a real change
    # back to the first config, and #6 belongs to another host.
    rows = [
        (1, "192.168.17.10", "2026-10-07 20:35:30", config_hash(BASE), BASE),
        (2, "192.168.17.10", "2026-10-08 06:02:28", config_hash(NEW_VLAN), NEW_VLAN),
        (3, "192.168.17.10", "2026-10-08 06:08:15", raw(NEW_VLAN), NEW_VLAN),
        (4, "192.168.17.10", "2026-10-08 07:00:00", raw(NEW_VLAN), NEW_VLAN.replace("3340 bytes", "9 bytes")),
        (5, "192.168.17.10", "2026-10-08 08:00:00", raw(SAME_LATER), SAME_LATER),
        (6, "192.168.17.11", "2026-10-08 08:30:00", raw(SAME_LATER), SAME_LATER),
    ]
    with sqlite3.connect(path) as db:
        db.executemany(
            "insert into config_backups (id, host, collected_at, last_seen_at, sha256, config) "
            "values (?, ?, ?, ?, ?, ?)",
            [(i, host, seen, seen, sha, text) for i, host, seen, sha, text in rows],
        )

    command.upgrade(config, "head")

    with sqlite3.connect(path) as db:
        after = db.execute(
            "select id, host, last_seen_at, sha256, config from config_backups order by id"
        ).fetchall()
    assert [row[0] for row in after] == [1, 2, 5, 6]
    # #2 now covers the time its duplicates were seen.
    assert after[1][2].startswith("2026-10-08 07:00:00")
    # Every hash is the normalised one, and consecutive backups of a host differ.
    assert all(sha == config_hash(text) for *_, sha, text in after)
    assert after[0][3] != after[1][3] != after[2][3]
    # The other host's backup has the same config as #5 and is kept.
    assert after[3][1] == "192.168.17.11"


def test_migration_0004_moves_virtualization_out_of_the_device_type(tmp_path):
    import sqlite3

    path = tmp_path / "types.db"
    config = Config(BACKEND / "alembic.ini")
    config.set_main_option("sqlalchemy.url", f"sqlite:///{path}")
    command.upgrade(config, "0003")

    seen = "2026-10-08 06:28:20"
    devices = [
        (1, "52:54:00:12:33:67", "192.168.17.3", "QEMU/KVM virtual machine", "VMware/virtual"),
        (2, "aa:bb:cc:80:01:00", "192.168.17.10", "Locally administered", "network device"),
        (3, "52:54:00:68:dd:64", "192.168.17.129", "QEMU/KVM virtual machine", "Linux/Unix host"),
        (4, "00:50:56:c0:00:01", "192.168.17.1", "VMware, Inc.", "VMware/virtual"),
    ]
    with sqlite3.connect(path) as db:
        db.execute("insert into scans (id, started_at, subnet, status) values (1, ?, '192.168.17.0/24', 'completed')", (seen,))
        db.executemany(
            "insert into devices (id, mac, first_seen, last_seen, last_ip, vendor, device_type) "
            "values (?, ?, ?, ?, ?, ?, ?)",
            [(i, mac, seen, seen, ip, vendor, kind) for i, mac, ip, vendor, kind in devices],
        )
        db.execute(
            "insert into scan_results (scan_id, device_id, ip, open_ports, device_type, reason) "
            "values (1, 2, '192.168.17.10', '[]', 'network device', 'ssh banner says Cisco')"
        )

    command.upgrade(config, "head")

    with sqlite3.connect(path) as db:
        rows = db.execute(
            "select id, vendor, virtualization, device_type, type_source, type_reason "
            "from devices order by id"
        ).fetchall()
        history = db.execute("select device_type from scan_results").fetchone()[0]
    assert [row[1:5] for row in rows] == [
        ("QEMU/KVM", "QEMU/KVM", "unknown", "scan"),
        ("Locally administered", None, "network device", "scan"),
        ("QEMU/KVM", "QEMU/KVM", "Linux/Unix host", "scan"),
        ("VMware, Inc.", "VMware", "unknown", "scan"),
    ]
    assert rows[1][5] == "ssh banner says Cisco"  # taken from the device's latest scan result
    assert "scan again" in rows[0][5]
    assert history == "network device"  # past scan results are not rewritten
    command.check(config)


def test_migration_status_reports_a_database_that_is_behind_the_code(tmp_path):
    from app.db.database import migration_status

    url = f"sqlite:///{tmp_path / 'behind.db'}"
    config = Config(BACKEND / "alembic.ini")
    config.set_main_option("sqlalchemy.url", url)
    engine = create_db_engine(url)

    command.upgrade(config, "0003")
    current, newest = migration_status(engine)
    assert current == "0003"
    assert newest != "0003"

    command.upgrade(config, "head")
    current, newest = migration_status(engine)
    assert current == newest
    engine.dispose()


def test_api_refuses_to_start_on_a_database_that_is_behind_the_code(tmp_path):
    from fastapi.testclient import TestClient

    from app.api import deps
    from app.main import app

    url = f"sqlite:///{tmp_path / 'behind.db'}"
    config = Config(BACKEND / "alembic.ini")
    config.set_main_option("sqlalchemy.url", url)
    command.upgrade(config, "0003")
    engine = create_db_engine(url)

    # Entering the client runs the app's start-up code, as a real server does.
    from unittest.mock import patch

    with patch.object(deps.get_engine, "__wrapped__", lambda: engine), patch(
        "app.main.get_engine", lambda: engine
    ):
        with pytest.raises(RuntimeError, match="alembic upgrade head"):
            with TestClient(app):
                pass

        command.upgrade(config, "head")
        with TestClient(app) as client:
            assert client.get("/openapi.json").status_code == 200
    engine.dispose()
