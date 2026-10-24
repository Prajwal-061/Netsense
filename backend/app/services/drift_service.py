"""Drift service: baselines, and running drift checks against them.

The comparison itself is engine/drift.py's pure compare_snapshots(); this
module only turns stored collections into its input (snapshot) and stores
its output.
"""

import threading
from collections.abc import Callable
from ipaddress import IPv4Network

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.credentials import Credentials
from app.db.models import (
    Baseline,
    ConfigBackup,
    DeviceCollection,
    DriftCheck,
    NetworkCollection,
    utcnow,
)
from app.engine import drift
from app.services import collection_service

_start_lock = threading.Lock()


class NoBaselineError(Exception):
    """No baseline has been set, so there is nothing to compare with."""


class InvalidBaselineError(Exception):
    """This collection cannot be a baseline."""


class DriftCheckInProgressError(Exception):
    """A drift check is already running."""


def current_baseline(session: Session) -> Baseline | None:
    return session.scalars(select(Baseline).order_by(Baseline.id.desc()).limit(1)).first()


def set_baseline(session: Session, collection_id: int, note: str | None = None) -> Baseline:
    """Mark a finished collection as the baseline. Any earlier one may be chosen.

    Raises LookupError for an unknown collection and InvalidBaselineError for
    one that is still running or reached no device at all.
    """
    run = session.get(NetworkCollection, collection_id)
    if run is None:
        raise LookupError(f"Collection {collection_id} not found.")
    if run.status == NetworkCollection.STATUS_RUNNING:
        raise InvalidBaselineError(f"Collection {collection_id} is still running.")
    if not any(row.status == DeviceCollection.STATUS_SUCCESS for row in run.results):
        raise InvalidBaselineError(
            f"Collection {collection_id} reached no device, so it cannot describe a healthy network."
        )
    baseline = Baseline(network_collection=run, note=(note or "").strip() or None)
    session.add(baseline)
    session.commit()
    return baseline


def snapshot(session: Session, run: NetworkCollection, allowed: list[IPv4Network] | None = None) -> dict:
    """A collection as compare_snapshots() wants it: per-device data and config, plus topology."""
    devices = []
    for row in run.results:
        config = ""
        if row.config_backup_id is not None:
            backup = session.get(ConfigBackup, row.config_backup_id)
            config = backup.config if backup else ""
        devices.append(
            {
                "device_id": row.device_id,
                "host": row.host,
                # A device that could not be reached this time has no "show
                # version" to name it, so use the name it had before.
                "name": collection_service._last_known_hostname(session, row),
                "status": row.status,
                "error": row.error,
                "data": row.data,
                "config": config,
            }
        )
    topology = run.topology or collection_service.build_run_topology(session, run, allowed)
    return {"collection_id": run.id, "devices": devices, "topology": topology}


def _check_none_running(session: Session) -> None:
    running = session.scalars(
        select(DriftCheck).where(DriftCheck.status == DriftCheck.STATUS_RUNNING).limit(1)
    ).first()
    if running is not None:
        raise DriftCheckInProgressError(f"Drift check #{running.id} is still running.")


def finish(session: Session, check: DriftCheck, allowed: list[IPv4Network] | None = None) -> DriftCheck:
    """Compare the check's collection with its baseline and store the report."""
    try:
        check.report = drift.compare_snapshots(
            snapshot(session, check.baseline.network_collection, allowed),
            snapshot(session, check.network_collection, allowed),
        )
        check.status = DriftCheck.STATUS_COMPLETED
    except Exception as exc:
        session.rollback()
        check.status = DriftCheck.STATUS_FAILED
        check.error = f"{type(exc).__name__}: {exc}"
        raise
    finally:
        check.finished_at = utcnow()
        session.commit()
    return check


def compare_existing(
    session: Session, collection_id: int, allowed: list[IPv4Network] | None = None
) -> DriftCheck:
    """Check an existing collection against the baseline. No device is contacted."""
    baseline = current_baseline(session)
    if baseline is None:
        raise NoBaselineError("Set a baseline first.")
    run = session.get(NetworkCollection, collection_id)
    if run is None:
        raise LookupError(f"Collection {collection_id} not found.")
    if run.status == NetworkCollection.STATUS_RUNNING:
        raise InvalidBaselineError(f"Collection {collection_id} is still running.")
    check = DriftCheck(baseline=baseline, network_collection=run)
    session.add(check)
    session.commit()
    return finish(session, check, allowed)


def start_drift_check(session: Session, allowed: list[IPv4Network] | None = None) -> DriftCheck:
    """Start a new collection of every network device, to be compared with the baseline.

    Raises NoBaselineError, DriftCheckInProgressError, and the collection
    service's CollectionInProgressError and NoNetworkDevicesError.
    """
    with _start_lock:
        baseline = current_baseline(session)
        if baseline is None:
            raise NoBaselineError(
                "Set a baseline first: a collection taken while the network was healthy."
            )
        _check_none_running(session)
        run = collection_service.start_network_collection(session, allowed)
        check = DriftCheck(baseline=baseline, network_collection=run)
        session.add(check)
        session.commit()
    return check


def run_drift_check(
    session: Session,
    check: DriftCheck,
    credentials_for_host: Callable[[str], Credentials],
    allowed: list[IPv4Network] | None = None,
) -> DriftCheck:
    """Collect from every device (show commands only), then compare with the baseline."""
    try:
        collection_service.run_network_collection(
            session, check.network_collection, credentials_for_host, allowed=allowed
        )
    except BaseException as exc:
        check.status = DriftCheck.STATUS_FAILED
        check.error = f"The collection failed: {exc}"
        check.finished_at = utcnow()
        session.commit()
        raise
    return finish(session, check, allowed)


def fail_interrupted_drift_checks(session: Session) -> int:
    """Close checks still "running" at start-up: a crash cut them off."""
    interrupted = session.scalars(
        select(DriftCheck).where(DriftCheck.status == DriftCheck.STATUS_RUNNING)
    ).all()
    for check in interrupted:
        check.status = DriftCheck.STATUS_FAILED
        check.error = "Interrupted: the program stopped before the check finished."
        check.finished_at = utcnow()
    session.commit()
    return len(interrupted)
