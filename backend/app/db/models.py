"""Database models (SQLAlchemy 2.0).

Only generic column types are used, so the same models work on SQLite and
PostgreSQL. Schema changes go through Alembic migrations (backend/migrations).
"""

from datetime import datetime, timezone
from typing import Any

from sqlalchemy import JSON, DateTime, ForeignKey, String, Text, TypeDecorator, UniqueConstraint
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

    id: Mapped[int] = mapped_column(primary_key=True)
    started_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)
    finished_at: Mapped[datetime | None] = mapped_column(UTCDateTime)
    subnet: Mapped[str] = mapped_column(String(18), index=True)
    status: Mapped[str] = mapped_column(String(16), default=STATUS_RUNNING)
    error: Mapped[str | None] = mapped_column(Text)

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


class DeviceCollection(Base):
    """Structured data the Netmiko collector read from a device at one moment.

    Each value is the collector's output as-is: a list of dicts when TextFSM
    parsed it, or the raw CLI text when it could not.
    """

    __tablename__ = "device_collections"

    id: Mapped[int] = mapped_column(primary_key=True)
    # Null when the device was collected by address before any scan found it.
    device_id: Mapped[int | None] = mapped_column(ForeignKey("devices.id"), index=True)
    host: Mapped[str] = mapped_column(String(255), index=True)
    collected_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)
    interfaces: Mapped[Any] = mapped_column(JSON)
    vlans: Mapped[Any] = mapped_column(JSON)
    mac_table: Mapped[Any] = mapped_column(JSON)
    # "show version" output. Null for collections made before it was stored.
    version: Mapped[Any | None] = mapped_column(JSON)

    device: Mapped[Device | None] = relationship()


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
