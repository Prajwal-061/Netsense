"""Baseline and drift-check routes."""

import logging

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query, Response, status
from sqlalchemy import Engine, select
from sqlalchemy.orm import Session

from app.api import schemas
from app.api.deps import get_engine, get_session
from app.core.config import Settings, get_settings
from app.core.credentials import credentials_for
from app.db import models
from app.services import collection_service, drift_service

logger = logging.getLogger(__name__)
router = APIRouter(tags=["drift"])


def _baseline_schema(baseline: models.Baseline) -> schemas.Baseline:
    run = baseline.network_collection
    devices = []
    for row in run.results:
        version = row.data.get("version") if row.data else None
        name = version[0].get("hostname") if isinstance(version, list) and version else None
        devices.append(schemas.BaselineDevice(host=row.host, name=name, status=row.status))
    return schemas.Baseline(
        id=baseline.id,
        collection_id=run.id,
        collected_at=run.finished_at or run.started_at,
        set_at=baseline.set_at,
        note=baseline.note,
        devices=devices,
    )


def _check_fields(check: models.DriftCheck) -> dict:
    report = check.report or {}
    return {
        "id": check.id,
        "status": check.status,
        "started_at": check.started_at,
        "finished_at": check.finished_at,
        "error": check.error,
        "baseline_collection_id": check.baseline.network_collection_id,
        "collection_id": check.network_collection_id,
        "summary": report.get("summary"),
    }


@router.get("/baseline", response_model=schemas.Baseline)
def get_baseline(session: Session = Depends(get_session)):
    """The current baseline: the collection drift checks compare with."""
    baseline = drift_service.current_baseline(session)
    if baseline is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No baseline has been set yet.")
    return _baseline_schema(baseline)


@router.put("/baseline", response_model=schemas.Baseline)
def set_baseline(body: schemas.BaselineSet, session: Session = Depends(get_session)):
    """Make a finished collection the baseline. Any past collection can be chosen.

    Choose one taken while the network was working as intended. Setting a
    new baseline after an intentional change makes that change the new normal.
    """
    try:
        baseline = drift_service.set_baseline(session, body.collection_id, body.note)
    except LookupError as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, str(exc)) from exc
    except drift_service.InvalidBaselineError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    return _baseline_schema(baseline)


@router.get("/baselines", response_model=list[schemas.Baseline])
def list_baselines(session: Session = Depends(get_session)):
    """Every baseline that has been set, newest (the current one) first."""
    baselines = session.scalars(select(models.Baseline).order_by(models.Baseline.id.desc()))
    return [_baseline_schema(baseline) for baseline in baselines]


def run_drift_job(engine: Engine, check_id: int, settings: Settings) -> None:
    """The background half of POST /drift-checks, with its own database session."""
    with Session(engine) as session:
        check = session.get(models.DriftCheck, check_id)
        try:
            drift_service.run_drift_check(
                session, check, lambda host: credentials_for(host, settings), settings.allowed_subnets
            )
        except Exception:
            logger.exception("Drift check #%s failed", check_id)


@router.post(
    "/drift-checks", response_model=schemas.DriftCheck, status_code=status.HTTP_202_ACCEPTED
)
def start_drift_check(
    background: BackgroundTasks,
    response: Response,
    body: schemas.DriftCheckStart | None = None,
    session: Session = Depends(get_session),
    engine: Engine = Depends(get_engine),
    settings: Settings = Depends(get_settings),
):
    """Compare the network with the baseline.

    By default this collects from every network device first (show commands
    only) and answers 202 straight away; poll GET /drift-checks/{id}. With a
    collection_id, that existing collection is compared instead, at once,
    without contacting any device (201).
    """
    body = body or schemas.DriftCheckStart()
    try:
        if body.collection_id is not None:
            check = drift_service.compare_existing(session, body.collection_id, settings.allowed_subnets)
            response.status_code = status.HTTP_201_CREATED
            return schemas.DriftCheck(**_check_fields(check), report=check.report)
        check = drift_service.start_drift_check(session, settings.allowed_subnets)
    except drift_service.NoBaselineError as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from exc
    except LookupError as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, str(exc)) from exc
    except drift_service.InvalidBaselineError as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from exc
    except (drift_service.DriftCheckInProgressError, collection_service.CollectionInProgressError) as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from exc
    except collection_service.NoNetworkDevicesError as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, str(exc)) from exc
    background.add_task(run_drift_job, engine, check.id, settings)
    return schemas.DriftCheck(**_check_fields(check), report=None)


@router.get("/drift-checks", response_model=list[schemas.DriftCheckSummary])
def list_drift_checks(
    limit: int = Query(default=50, ge=1, le=200), session: Session = Depends(get_session)
):
    """Drift checks, newest first, with counts by severity."""
    checks = session.scalars(select(models.DriftCheck).order_by(models.DriftCheck.id.desc()).limit(limit))
    return [schemas.DriftCheckSummary(**_check_fields(check)) for check in checks]


@router.get("/drift-checks/{check_id}", response_model=schemas.DriftCheck)
def get_drift_check(check_id: int, session: Session = Depends(get_session)):
    """One drift check with its full report: findings, probable causes, config diffs."""
    check = session.get(models.DriftCheck, check_id)
    if check is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"Drift check {check_id} not found.")
    return schemas.DriftCheck(**_check_fields(check), report=check.report)
