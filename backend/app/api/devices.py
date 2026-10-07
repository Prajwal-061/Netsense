"""Device routes: devices, collecting from network devices, collected data."""

from ipaddress import IPv4Network

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api import schemas
from app.api.deps import get_session
from app.api.scans import result_schema
from app.core.config import Settings, get_settings
from app.db import models
from app.engine import classifier, collector, discovery
from app.services import collection_service

router = APIRouter(prefix="/devices", tags=["devices"])


def get_device(device_id: int, session: Session = Depends(get_session)) -> models.Device:
    """Load the device named in the URL, or answer 404."""
    device = session.get(models.Device, device_id)
    if device is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"Device {device_id} not found.")
    return device


def _device_schema(session: Session, device: models.Device) -> schemas.Device:
    latest = session.scalars(
        select(models.ScanResult)
        .where(models.ScanResult.device_id == device.id)
        .order_by(models.ScanResult.id.desc())
        .limit(1)
    ).first()
    return schemas.Device(
        id=device.id,
        mac=device.mac,
        first_seen=device.first_seen,
        last_seen=device.last_seen,
        last_ip=device.last_ip,
        vendor=device.vendor,
        device_type=device.device_type,
        latest_result=result_schema(latest) if latest else None,
    )


def _backup_schema(backup: models.ConfigBackup) -> schemas.ConfigBackup:
    return schemas.ConfigBackup(
        id=backup.id,
        collected_at=backup.collected_at,
        last_seen_at=backup.last_seen_at,
        sha256=backup.sha256,
        lines=len(backup.config.splitlines()),
    )


@router.get("", response_model=list[schemas.Device])
def list_devices(session: Session = Depends(get_session)):
    """Every device ever seen, most recently seen first, with its latest scan result."""
    devices = session.scalars(
        select(models.Device).order_by(models.Device.last_seen.desc(), models.Device.id)
    )
    return [_device_schema(session, device) for device in devices]


@router.get("/{device_id}", response_model=schemas.Device)
def read_device(
    device: models.Device = Depends(get_device), session: Session = Depends(get_session)
):
    return _device_schema(session, device)


@router.post("/{device_id}/collect", response_model=schemas.CollectResult)
def collect_device(
    device: models.Device = Depends(get_device),
    session: Session = Depends(get_session),
    settings: Settings = Depends(get_settings),
):
    """SSH into a network device, read its state with show commands, and store it.

    Only for devices classified as a network device, at an address inside
    ALLOWED_SUBNETS. Logs in with the credentials from .env. Read-only.
    """
    if device.device_type != classifier.NETWORK_DEVICE:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f"Device {device.id} is classified as '{device.device_type}', not "
            f"'{classifier.NETWORK_DEVICE}', so it will not be logged in to.",
        )
    host = device.last_ip
    try:
        # The same guard as for scans: never connect outside the allowed networks.
        discovery.check_allowed(IPv4Network(host), settings.allowed_subnets)
    except discovery.SubnetNotAllowedError as exc:
        raise HTTPException(status.HTTP_403_FORBIDDEN, str(exc)) from exc

    try:
        conn = collector.connect(
            host=host,
            username=settings.lab_switch_username,
            password=settings.lab_switch_password.get_secret_value(),
        )
        try:
            interfaces = collector.get_interfaces(conn)
            vlans = collector.get_vlans(conn)
            mac_table = collector.get_mac_table(conn)
            config = collector.get_running_config(conn)
        finally:
            conn.disconnect()
    except collector.DeviceTimeoutError as exc:
        raise HTTPException(status.HTTP_504_GATEWAY_TIMEOUT, str(exc)) from exc
    except collector.CollectorError as exc:
        # 502: this API worked, but the device behind it did not cooperate.
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(exc)) from exc

    collection = collection_service.save_collection(
        session, host, interfaces, vlans, mac_table, device=device
    )
    backup, changed = collection_service.save_config_backup(session, host, config, device=device)

    def count(data) -> int | None:
        return len(data) if isinstance(data, list) else None

    return schemas.CollectResult(
        device_id=device.id,
        host=host,
        collection_id=collection.id,
        collected_at=collection.collected_at,
        interfaces=count(interfaces),
        vlans=count(vlans),
        mac_table=count(mac_table),
        config_backup=_backup_schema(backup),
        config_changed=changed,
    )


def _latest_collected(session: Session, device: models.Device, field: str) -> schemas.CollectedData:
    collection = session.scalars(
        select(models.DeviceCollection)
        .where(models.DeviceCollection.device_id == device.id)
        .order_by(models.DeviceCollection.id.desc())
        .limit(1)
    ).first()
    if collection is None:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND,
            f"Nothing has been collected from device {device.id} yet. "
            f"POST /devices/{device.id}/collect first.",
        )
    return schemas.CollectedData(
        device_id=device.id, collected_at=collection.collected_at, data=getattr(collection, field)
    )


@router.get("/{device_id}/interfaces", response_model=schemas.CollectedData)
def device_interfaces(
    device: models.Device = Depends(get_device), session: Session = Depends(get_session)
):
    """Latest 'show ip interface brief' collected from the device."""
    return _latest_collected(session, device, "interfaces")


@router.get("/{device_id}/vlans", response_model=schemas.CollectedData)
def device_vlans(
    device: models.Device = Depends(get_device), session: Session = Depends(get_session)
):
    """Latest 'show vlan brief' collected from the device."""
    return _latest_collected(session, device, "vlans")


@router.get("/{device_id}/mac-table", response_model=schemas.CollectedData)
def device_mac_table(
    device: models.Device = Depends(get_device), session: Session = Depends(get_session)
):
    """Latest 'show mac address-table' collected from the device."""
    return _latest_collected(session, device, "mac_table")


@router.get("/{device_id}/configs", response_model=list[schemas.ConfigBackup])
def device_configs(
    device: models.Device = Depends(get_device), session: Session = Depends(get_session)
):
    """Running-config versions stored for the device, newest first.

    Metadata only: the config text can contain password hashes, and this API
    has no authentication yet.
    """
    backups = session.scalars(
        select(models.ConfigBackup)
        .where(models.ConfigBackup.device_id == device.id)
        .order_by(models.ConfigBackup.id.desc())
    )
    return [_backup_schema(backup) for backup in backups]
