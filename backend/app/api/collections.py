"""Collection routes: collect from every network device, and read the runs."""

import logging

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query, status
from sqlalchemy import Engine, select
from sqlalchemy.orm import Session

from app.api import schemas
from app.api.deps import get_engine, get_session
from app.core.config import Settings, get_settings
from app.core.credentials import credentials_for
from app.db import models
from app.services import collection_service

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/collections", tags=["collections"])


def collected_summary(data: dict) -> dict[str, int | None]:
    """Rows parsed per kind of data, or None where the raw text was kept."""
    return {kind: len(value) if isinstance(value, list) else None for kind, value in data.items()}


def result_schema(row: models.DeviceCollection) -> schemas.DeviceCollectionResult:
    version = row.data.get("version")
    hostname = version[0].get("hostname") if isinstance(version, list) and version else None
    return schemas.DeviceCollectionResult(
        id=row.id,
        device_id=row.device_id,
        host=row.host,
        hostname=hostname or None,
        device_type=row.device.device_type if row.device else None,
        status=row.status,
        error=row.error,
        note=row.note,
        collected_at=row.collected_at,
        collected=collected_summary(row.data),
        config_changed=row.config_changed,
    )


def _summary_fields(run: models.NetworkCollection) -> dict:
    statuses = [row.status for row in run.results]
    return {
        "id": run.id,
        "status": run.status,
        "started_at": run.started_at,
        "finished_at": run.finished_at,
        "device_count": len(statuses),
        "succeeded": statuses.count(models.DeviceCollection.STATUS_SUCCESS),
        "failed": statuses.count(models.DeviceCollection.STATUS_FAILED),
        "pending": statuses.count(models.DeviceCollection.STATUS_PENDING),
    }


def _detail(run: models.NetworkCollection) -> schemas.NetworkCollectionDetail:
    return schemas.NetworkCollectionDetail(
        **_summary_fields(run), results=[result_schema(row) for row in run.results]
    )


def run_collection_job(engine: Engine, run_id: int, settings: Settings) -> None:
    """The background half of POST /collections, with its own database session."""
    with Session(engine) as session:
        run = session.get(models.NetworkCollection, run_id)
        try:
            collection_service.run_network_collection(
                session, run, lambda host: credentials_for(host, settings)
            )
        except Exception:
            # Already saved on the run as status "failed".
            logger.exception("Collection #%s failed", run_id)


@router.post(
    "", response_model=schemas.NetworkCollectionDetail, status_code=status.HTTP_202_ACCEPTED
)
def start_collection(
    background: BackgroundTasks,
    session: Session = Depends(get_session),
    engine: Engine = Depends(get_engine),
    settings: Settings = Depends(get_settings),
):
    """Collect from every router, switch and likely network device, in the background.

    Returns the run with one pending result per device straight away. Poll
    GET /collections/{id} until its status is no longer "running". Devices
    are read with show commands only, a few at a time, and only at addresses
    inside ALLOWED_SUBNETS. Answers 409 while a run is going and 404 when no
    network device is known yet.
    """
    try:
        run = collection_service.start_network_collection(session, settings.allowed_subnets)
    except collection_service.CollectionInProgressError as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from exc
    except collection_service.NoNetworkDevicesError as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, str(exc)) from exc
    background.add_task(run_collection_job, engine, run.id, settings)
    return _detail(run)


@router.get("", response_model=list[schemas.NetworkCollectionSummary])
def list_collections(
    limit: int = Query(default=50, ge=1, le=200), session: Session = Depends(get_session)
):
    """Collection runs, newest first, with how many devices succeeded and failed."""
    runs = session.scalars(
        select(models.NetworkCollection).order_by(models.NetworkCollection.id.desc()).limit(limit)
    )
    return [schemas.NetworkCollectionSummary(**_summary_fields(run)) for run in runs]


@router.get("/{collection_id}", response_model=schemas.NetworkCollectionDetail)
def get_collection(collection_id: int, session: Session = Depends(get_session)):
    """One collection run with the result for each device."""
    run = session.get(models.NetworkCollection, collection_id)
    if run is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"Collection {collection_id} not found.")
    return _detail(run)
