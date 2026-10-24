"""Health check."""

from fastapi import APIRouter, Depends
from sqlalchemy import Engine, select
from sqlalchemy.orm import Session

from app.api import schemas
from app.api.deps import get_engine, get_session
from app.db.database import is_migrated
from app.db.models import NetworkCollection, Scan
from app.engine import discovery

router = APIRouter(tags=["health"])

# Version of the API contract the dashboard depends on. Add 1 whenever an
# endpoint or response field the dashboard uses is added or changed, and set
# REQUIRED_API_REVISION in frontend/src/api.ts to the same number. A
# dashboard talking to a backend that was not restarted after an update then
# says so, instead of failing in confusing ways.
API_REVISION = 6


@router.get("/health", response_model=schemas.Health)
def health(engine: Engine = Depends(get_engine), session: Session = Depends(get_session)):
    """Is the API up, is the database ready, and can this process ARP scan?"""
    database = is_migrated(engine)
    running = database and session.scalars(
        select(Scan.id).where(Scan.status == Scan.STATUS_RUNNING).limit(1)
    ).first() is not None
    collecting = database and session.scalars(
        select(NetworkCollection.id)
        .where(NetworkCollection.status == NetworkCollection.STATUS_RUNNING)
        .limit(1)
    ).first() is not None
    return schemas.Health(
        status="ok" if database else "degraded",
        api_revision=API_REVISION,
        database=database,
        raw_sockets=discovery.can_open_raw_socket(),
        scan_running=running,
        collection_running=collecting,
    )
