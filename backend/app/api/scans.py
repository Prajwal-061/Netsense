"""Scan routes: start a scan, list scans, read one scan with its changes."""

import logging
from ipaddress import IPv4Network

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query, status
from sqlalchemy import Engine, select
from sqlalchemy.orm import Session

from app.api import schemas
from app.api.deps import get_engine, get_session
from app.core.config import Settings, get_settings
from app.db import models
from app.engine import discovery
from app.services import scan_service

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/scans", tags=["scans"])


def result_schema(result: models.ScanResult) -> schemas.ScanResult:
    return schemas.ScanResult(
        scan_id=result.scan_id,
        device_id=result.device_id,
        ip=result.ip,
        mac=result.device.mac,
        vendor=result.device.vendor,
        open_ports=result.open_ports,
        device_type=result.device_type,
        reason=result.reason,
        seen_at=result.scan.started_at,
    )


def _summary_fields(scan: models.Scan) -> dict:
    return {
        "id": scan.id,
        "status": scan.status,
        "subnet": scan.subnet,
        "started_at": scan.started_at,
        "finished_at": scan.finished_at,
        "error": scan.error,
        "device_count": len(scan.results),
    }


def run_scan_job(
    engine: Engine,
    scan_id: int,
    interface: str,
    top_ports: int,
    host_timeout: int,
    allowed: list[IPv4Network],
) -> None:
    """The background half of POST /scans. Runs after the response is sent.

    It gets its own database session, because the request's session is
    closed by the time this runs.
    """
    with Session(engine) as session:
        scan = session.get(models.Scan, scan_id)
        try:
            scan_service.execute_scan(session, scan, interface, top_ports, host_timeout, allowed)
        except Exception as exc:
            # Already saved on the scan as status "failed" with this message.
            logger.warning("Scan #%s failed: %s", scan_id, exc)


@router.post("", response_model=schemas.ScanSummary, status_code=status.HTTP_202_ACCEPTED)
def start_scan(
    background: BackgroundTasks,
    body: schemas.ScanCreate | None = None,
    session: Session = Depends(get_session),
    engine: Engine = Depends(get_engine),
    settings: Settings = Depends(get_settings),
):
    """Start a scan in the background and return its id straight away.

    Poll GET /scans/{id} until its status is no longer "running". Answers
    403 for a subnet outside ALLOWED_SUBNETS and 409 while a scan is running.
    """
    body = body or schemas.ScanCreate()
    allowed = settings.allowed_subnets
    try:
        # The safety guard, enforced here at the edge of the API. The
        # service and the engine each check again before any packet is sent.
        if body.subnet is not None:
            discovery.check_allowed(IPv4Network(body.subnet), allowed)
        # The interface is always worked out from the subnet, never taken
        # from the client, so a request cannot send packets out of another
        # interface (such as the NAT one).
        scan, interface = scan_service.start_scan(session, body.subnet, allowed=allowed)
    except discovery.SubnetNotAllowedError as exc:
        raise HTTPException(status.HTTP_403_FORBIDDEN, str(exc)) from exc
    except scan_service.ScanInProgressError as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from exc
    except (discovery.DiscoveryError, ValueError) as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc

    background.add_task(
        run_scan_job, engine, scan.id, interface, body.top_ports, body.host_timeout, allowed
    )
    return schemas.ScanSummary(**_summary_fields(scan))


@router.get("", response_model=list[schemas.ScanSummary])
def list_scans(
    limit: int = Query(default=50, ge=1, le=200), session: Session = Depends(get_session)
):
    """Scans, newest first, without their per-device results."""
    scans = session.scalars(select(models.Scan).order_by(models.Scan.id.desc()).limit(limit))
    return [schemas.ScanSummary(**_summary_fields(scan)) for scan in scans]


@router.get("/{scan_id}", response_model=schemas.ScanDetail)
def get_scan(scan_id: int, session: Session = Depends(get_session)):
    """One scan: status, what it saw, and what changed since the previous scan."""
    scan = session.get(models.Scan, scan_id)
    if scan is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"Scan {scan_id} not found.")
    report = scan_service.change_report(session, scan)
    return schemas.ScanDetail(
        **_summary_fields(scan),
        results=[result_schema(result) for result in scan.results],
        changes=schemas.ChangeReport(
            previous_scan_id=report.previous_scan_id,
            new_devices=report.new_devices,
            missing_devices=report.missing_devices,
            ip_changes=report.ip_changes,
        )
        if report
        else None,
    )
