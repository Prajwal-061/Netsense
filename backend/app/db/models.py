"""Database models (SQLAlchemy 2.0).

Only generic column types are used, so the same models work on SQLite and
PostgreSQL. Schema changes go through Alembic migrations (backend/migrations).
"""

from datetime import datetime, timezone
from typing import Any

from sqlalchemy import (
    JSON,
    Boolean,
    DateTime,
    ForeignKey,
    Integer,
    String,
    Text,
    TypeDecorator,
    UniqueConstraint,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class UTCDateTime(TypeDecorator):
    """A timestamp that is always timezone-aware UTC in Python.

    SQLite has no timezone support and hands back naive datetimes, while
    PostgreSQL keeps the timezone. Normalising here makes both behave the same.
    """

    impl = DateTime(timezone=True)
    cache_ok = True

    def process_bind_param(self, value, dialect):
        if value is not None and value.tzinfo is None:
            raise ValueError("Naive datetime: use a timezone-aware UTC datetime.")
        return value.astimezone(timezone.utc) if value is not None else None

    def process_result_value(self, value, dialect):
        if value is not None and value.tzinfo is None:
            return value.replace(tzinfo=timezone.utc)
        return value


class Base(DeclarativeBase):
    pass


class Scan(Base):
    """One run of the discovery -> port scan -> classify pipeline."""

    __tablename__ = "scans"

    STATUS_RUNNING = "running"
    STATUS_COMPLETED = "completed"
    STATUS_FAILED = "failed"
    # Cut off before it finished (restart, crash, Ctrl-C): no results kept.
    # Never becomes "completed" afterwards.
    STATUS_INTERRUPTED = "interrupted"

    id: Mapped[int] = mapped_column(primary_key=True)
    started_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)
    finished_at: Mapped[datetime | None] = mapped_column(UTCDateTime)
    subnet: Mapped[str] = mapped_column(String(18), index=True)
    status: Mapped[str] = mapped_column(String(16), default=STATUS_RUNNING)
    error: Mapped[str | None] = mapped_column(Text)
    # Process running the scan (the API or a script), so start-up only marks
    # scans interrupted whose process is gone. Null for scans from before 0009.
    pid: Mapped[int | None] = mapped_column(Integer)

    results: Mapped[list["ScanResult"]] = relationship(
        back_populates="scan", cascade="all, delete-orphan", order_by="ScanResult.id"
    )


class Device(Base):
    """One physical device, identified by its MAC address.

    Holds the current picture of the device. What each individual scan saw
    is in ScanResult.
    """

    __tablename__ = "devices"

    id: Mapped[int] = mapped_column(primary_key=True)
    mac: Mapped[str] = mapped_column(String(17), unique=True, index=True)
    first_seen: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)
    last_seen: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)
    last_ip: Mapped[str] = mapped_column(String(15), index=True)
    vendor: Mapped[str] = mapped_column(String(255), default="")
    # How the device is hosted (e.g. "QEMU/KVM"), from its MAC prefix. Null
    # when the MAC shows no sign of virtualisation. Independent of the type.
    virtualization: Mapped[str | None] = mapped_column(String(32))
    device_type: Mapped[str] = mapped_column(String(32), default="unknown")
    # Where device_type came from. A type confirmed by logging in to the
    # device ("collected") is kept when later scans guess something else.
    type_source: Mapped[str] = mapped_column(String(16), default="scan")
    type_reason: Mapped[str] = mapped_column(Text, default="")

    TYPE_FROM_SCAN = "scan"
    TYPE_FROM_COLLECTION = "collected"

    results: Mapped[list["ScanResult"]] = relationship(back_populates="device")


class ScanResult(Base):
    """What one scan saw for one device. Never updated: this is the history."""

    __tablename__ = "scan_results"
    __table_args__ = (UniqueConstraint("scan_id", "device_id"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    scan_id: Mapped[int] = mapped_column(ForeignKey("scans.id", ondelete="CASCADE"), index=True)
    device_id: Mapped[int] = mapped_column(ForeignKey("devices.id"), index=True)
    ip: Mapped[str] = mapped_column(String(15))
    # The scanner's list of port dicts. Always read together with the result,
    # so it is stored as one JSON value instead of a separate ports table.
    open_ports: Mapped[list[dict[str, Any]]] = mapped_column(JSON, default=list)
    device_type: Mapped[str] = mapped_column(String(32))
    reason: Mapped[str] = mapped_column(Text, default="")

    scan: Mapped[Scan] = relationship(back_populates="results")
    device: Mapped[Device] = relationship(back_populates="results")


class NetworkCollection(Base):
    """One run of "collect from every network device"."""

    __tablename__ = "network_collections"

    STATUS_RUNNING = "running"
    STATUS_COMPLETED = "completed"
    STATUS_FAILED = "failed"

    id: Mapped[int] = mapped_column(primary_key=True)
    started_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)
    finished_at: Mapped[datetime | None] = mapped_column(UTCDateTime)
    status: Mapped[str] = mapped_column(String(16), default=STATUS_RUNNING)
    # The topology computed from this run (engine/topology.py), kept so that
    # the topologies of different runs can be compared. Null until computed.
    topology: Mapped[dict[str, Any] | None] = mapped_column(JSON)

    results: Mapped[list["DeviceCollection"]] = relationship(
        back_populates="network_collection", order_by="DeviceCollection.id"
    )


class DeviceCollection(Base):
    """What one collection read from one device, or why it could not.

    Part of a NetworkCollection run, or on its own when a single device was
    collected. data holds every command's output under the collector's key
    for it ("interfaces", "routes", ...): a list of dicts when the output was
    parsed, or the raw CLI text when it was not. One JSON document instead of
    a column per command means a new command needs no schema change.
    """

    __tablename__ = "device_collections"

    STATUS_PENDING = "pending"
    STATUS_SUCCESS = "success"
    STATUS_FAILED = "failed"

    id: Mapped[int] = mapped_column(primary_key=True)
    network_collection_id: Mapped[int | None] = mapped_column(
        ForeignKey("network_collections.id", ondelete="CASCADE"), index=True
    )
    # Null when the device was collected by address before any scan found it.
    device_id: Mapped[int | None] = mapped_column(ForeignKey("devices.id"), index=True)
    host: Mapped[str] = mapped_column(String(255), index=True)
    collected_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)
    status: Mapped[str] = mapped_column(String(16), default=STATUS_SUCCESS)
    error: Mapped[str | None] = mapped_column(Text)
    note: Mapped[str | None] = mapped_column(Text)
    data: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    config_backup_id: Mapped[int | None] = mapped_column(ForeignKey("config_backups.id"))
    # True if this collection found a config different from the previous backup.
    config_changed: Mapped[bool | None] = mapped_column(Boolean)

    device: Mapped[Device | None] = relationship()
    network_collection: Mapped[NetworkCollection | None] = relationship(back_populates="results")


class ConfigBackup(Base):
    """One version of a device's running config.

    A new row is added only when the config's hash differs from the device's
    latest backup. An unchanged config just moves last_seen_at forward, so
    each row covers the period during which that version was in place.

    The text can contain password hashes and SNMP communities: the database
    file must stay out of git.
    """

    __tablename__ = "config_backups"

    id: Mapped[int] = mapped_column(primary_key=True)
    device_id: Mapped[int | None] = mapped_column(ForeignKey("devices.id"), index=True)
    host: Mapped[str] = mapped_column(String(255), index=True)
    collected_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)
    last_seen_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)
    sha256: Mapped[str] = mapped_column(String(64), index=True)
    config: Mapped[str] = mapped_column(Text)

    device: Mapped[Device | None] = relationship()


class Baseline(Base):
    """A collection marked as "the network as it should be".

    Every time a baseline is set a new row is added, so the history of
    baselines (and why they were taken) is kept. The newest row is the
    current baseline.
    """

    __tablename__ = "baselines"

    id: Mapped[int] = mapped_column(primary_key=True)
    network_collection_id: Mapped[int] = mapped_column(ForeignKey("network_collections.id"), index=True)
    set_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)
    note: Mapped[str | None] = mapped_column(Text)

    network_collection: Mapped[NetworkCollection] = relationship()


class DriftCheck(Base):
    """One comparison of a collection with the baseline.

    report is the output of engine/drift.py's compare_snapshots, kept as it
    was computed so that a later change of baseline does not rewrite history.
    """

    __tablename__ = "drift_checks"

    STATUS_RUNNING = "running"
    STATUS_COMPLETED = "completed"
    STATUS_FAILED = "failed"

    id: Mapped[int] = mapped_column(primary_key=True)
    baseline_id: Mapped[int] = mapped_column(ForeignKey("baselines.id"), index=True)
    # The collection compared with the baseline: made by the check itself,
    # or an existing one.
    network_collection_id: Mapped[int] = mapped_column(ForeignKey("network_collections.id"), index=True)
    started_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)
    finished_at: Mapped[datetime | None] = mapped_column(UTCDateTime)
    status: Mapped[str] = mapped_column(String(16), default=STATUS_RUNNING)
    error: Mapped[str | None] = mapped_column(Text)
    report: Mapped[dict[str, Any] | None] = mapped_column(JSON)

    baseline: Mapped[Baseline] = relationship()
    network_collection: Mapped[NetworkCollection] = relationship()


class AdminUser(Base):
    """The one user who may use the dashboard and API. Created with scripts/create_admin.py."""

    __tablename__ = "admin_users"

    id: Mapped[int] = mapped_column(primary_key=True)
    username: Mapped[str] = mapped_column(String(64), unique=True)
    # argon2id hash: algorithm, parameters, salt and hash in one string.
    password_hash: Mapped[str] = mapped_column(String(255))
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)


class AuthSession(Base):
    """A logged-in browser. The cookie holds a random token; only its hash is stored."""

    __tablename__ = "auth_sessions"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("admin_users.id", ondelete="CASCADE"), index=True)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)
    expires_at: Mapped[datetime] = mapped_column(UTCDateTime)

    user: Mapped[AdminUser] = relationship()
