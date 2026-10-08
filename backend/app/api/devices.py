"""Device routes: devices, collecting from network devices, collected data."""

from ipaddress import IPv4Network

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api import schemas
from app.api.deps import get_session
from app.api.scans import result_schema
from app.api.collections import collected_summary
from app.core.config import Settings, get_settings
from app.core.credentials import credentials_for
from app.db import models
from app.engine import classifier, collector, config_diff, discovery
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
        virtualization=device.virtualization,
        device_type=device.device_type,
        type_source=device.type_source,
        type_reason=device.type_reason,
        latest_result=result_schema(latest) if latest else None,
    )


def _backup_label(backup: models.ConfigBackup) -> str:
    return f"backup #{backup.id} ({backup.collected_at:%Y-%m-%d %H:%M} UTC)"


def _backup_schema(
    backup: models.ConfigBackup, previous: models.ConfigBackup | None
) -> schemas.ConfigBackup:
    """Describe a backup, including how it differs from the one before it."""
    diff = config_diff.diff_configs(previous.config, backup.config) if previous else None
    return schemas.ConfigBackup(
        id=backup.id,
        collected_at=backup.collected_at,
        last_seen_at=backup.last_seen_at,
        sha256=backup.sha256,
        lines=len(backup.config.splitlines()),
        changed=diff.changed if diff else None,
        lines_added=diff.lines_added if diff else 0,
        lines_removed=diff.lines_removed if diff else 0,
    )


def _device_backups(session: Session, device: models.Device) -> list[models.ConfigBackup]:
    """A device's config backups, oldest first."""
    return list(
        session.scalars(
            select(models.ConfigBackup)
            .where(models.ConfigBackup.device_id == device.id)
            .order_by(models.ConfigBackup.id)
        )
    )


def _diff_schema(
    device: models.Device, backups: list[models.ConfigBackup], old_id: int, new_id: int
) -> schemas.ConfigDiff:
    by_id = {backup.id: backup for backup in backups}
    for backup_id in (old_id, new_id):
        if backup_id not in by_id:
            raise HTTPException(
                status.HTTP_404_NOT_FOUND,
                f"Config backup {backup_id} not found for device {device.id}.",
            )
    old, new = by_id[old_id], by_id[new_id]
    diff = config_diff.diff_configs(old.config, new.config, _backup_label(old), _backup_label(new))

    def describe(backup: models.ConfigBackup) -> schemas.ConfigBackup:
        index = backups.index(backup)
        return _backup_schema(backup, backups[index - 1] if index else None)

    return schemas.ConfigDiff(
        device_id=device.id,
        from_backup=describe(old),
        to_backup=describe(new),
        changed=diff.changed,
        lines_added=diff.lines_added,
        lines_removed=diff.lines_removed,
        diff=diff.diff,
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

    Only for devices classified as a network device (or already confirmed as
    a router or switch), at an address inside ALLOWED_SUBNETS. Logs in with
    the credentials from .env. Read-only. A successful login confirms the
    device as a router or switch from its "show version" output.
    """
    if device.device_type not in classifier.NETWORK_TYPES:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f"Device {device.id} is classified as '{device.device_type}', not as a "
            "network device, so it will not be logged in to.",
        )
    host = device.last_ip
    try:
        # The same guard as for scans: never connect outside the allowed networks.
        discovery.check_allowed(IPv4Network(host), settings.allowed_subnets)
    except discovery.SubnetNotAllowedError as exc:
        raise HTTPException(status.HTTP_403_FORBIDDEN, str(exc)) from exc

    try:
        row, backup, created = collection_service.collect_device(
            session, device, credentials_for(host, settings)
        )
    except collector.DeviceTimeoutError as exc:
        raise HTTPException(status.HTTP_504_GATEWAY_TIMEOUT, str(exc)) from exc
    except collector.CollectorError as exc:
        # 502: this API worked, but the device behind it did not cooperate.
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(exc)) from exc

    previous = collection_service.latest_backup(session, host, before_id=backup.id)
    return schemas.CollectResult(
        device_id=device.id,
        host=host,
        device_type=device.device_type,
        type_reason=device.type_reason,
        collection_id=row.id,
        collected_at=row.collected_at,
        collected=collected_summary(row.data),
        note=row.note,
        config_backup=_backup_schema(backup, previous),
        first_backup=created and previous is None,
        config_changed=bool(row.config_changed),
    )


# URL name -> key in DeviceCollection.data, with the command it comes from.
DATA_ENDPOINTS = {
    "interfaces": ("interfaces", "show ip interface brief"),
    "cdp-neighbors": ("cdp_neighbors", "show cdp neighbors detail"),
    "arp": ("arp", "show ip arp"),
    "vlans": ("vlans", "show vlan brief"),
    "trunks": ("trunks", "show interfaces trunk"),
    "spanning-tree": ("spanning_tree", "show spanning-tree"),
    "mac-table": ("mac_table", "show mac address-table"),
    "routes": ("routes", "show ip route"),
    "ospf-neighbors": ("ospf_neighbors", "show ip ospf neighbor"),
    "ospf-interfaces": ("ospf_interfaces", "show ip ospf interface brief"),
}


def _latest_collected(session: Session, device: models.Device, key: str) -> schemas.CollectedData:
    """The newest successful collection of this device that has this kind of data."""
    collections = session.scalars(
        select(models.DeviceCollection)
        .where(
            models.DeviceCollection.device_id == device.id,
            models.DeviceCollection.status == models.DeviceCollection.STATUS_SUCCESS,
        )
        .order_by(models.DeviceCollection.id.desc())
        .limit(20)
    ).all()
    if not collections:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND,
            f"Nothing has been collected from device {device.id} yet. "
            f"POST /devices/{device.id}/collect first.",
        )
    for collection in collections:
        if key in collection.data:
            return schemas.CollectedData(
                device_id=device.id, collected_at=collection.collected_at, data=collection.data[key]
            )
    raise HTTPException(
        status.HTTP_404_NOT_FOUND,
        f"This data is not collected from a {device.device_type} (device {device.id}).",
    )


def _add_data_endpoint(url_name: str, key: str, command: str) -> None:
    def endpoint(
        device: models.Device = Depends(get_device), session: Session = Depends(get_session)
    ):
        return _latest_collected(session, device, key)

    endpoint.__name__ = f"device_{key}"
    endpoint.__doc__ = f"Latest '{command}' collected from the device."
    router.get(f"/{{device_id}}/{url_name}", response_model=schemas.CollectedData)(endpoint)


for _url_name, (_key, _command) in DATA_ENDPOINTS.items():
    _add_data_endpoint(_url_name, _key, _command)


@router.get("/{device_id}/configs", response_model=list[schemas.ConfigBackup])
def device_configs(
    device: models.Device = Depends(get_device), session: Session = Depends(get_session)
):
    """Running-config versions stored for the device, newest first.

    Each one says whether it differs from the backup before it. Metadata
    only; the text is served, masked, by the two endpoints below.
    """
    backups = _device_backups(session, device)
    described = [
        _backup_schema(backup, backups[index - 1] if index else None)
        for index, backup in enumerate(backups)
    ]
    return described[::-1]


# The two /diff routes must come before /configs/{backup_id}: routes are
# tried in order, and "diff" would otherwise be taken for a backup id.
@router.get("/{device_id}/configs/diff/latest", response_model=schemas.ConfigDiff)
def device_config_diff_latest(
    device: models.Device = Depends(get_device), session: Session = Depends(get_session)
):
    """What changed between the device's previous backup and its latest one."""
    backups = _device_backups(session, device)
    if len(backups) < 2:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND,
            f"Device {device.id} has {len(backups)} config backup(s); two are needed to compare.",
        )
    return _diff_schema(device, backups, backups[-2].id, backups[-1].id)


@router.get("/{device_id}/configs/diff", response_model=schemas.ConfigDiff)
def device_config_diff(
    from_id: int = Query(description="Backup to compare from (normally the older one)."),
    to_id: int = Query(description="Backup to compare to (normally the newer one)."),
    device: models.Device = Depends(get_device),
    session: Session = Depends(get_session),
):
    """What changed between any two config backups of the device."""
    return _diff_schema(device, _device_backups(session, device), from_id, to_id)


@router.get("/{device_id}/configs/{backup_id}", response_model=schemas.ConfigBackupDetail)
def device_config(
    backup_id: int,
    device: models.Device = Depends(get_device),
    session: Session = Depends(get_session),
):
    """One stored running config, with its secrets masked.

    Password hashes, SNMP communities and keys are replaced before the text
    leaves the server, because this API has no authentication yet.
    """
    backups = _device_backups(session, device)
    backup = next((item for item in backups if item.id == backup_id), None)
    if backup is None:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND,
            f"Config backup {backup_id} not found for device {device.id}.",
        )
    index = backups.index(backup)
    return schemas.ConfigBackupDetail(
        **_backup_schema(backup, backups[index - 1] if index else None).model_dump(),
        config=config_diff.redact_config(backup.config),
    )
