"""Health check."""

from fastapi import APIRouter, Depends
from sqlalchemy import Engine, select
from sqlalchemy.orm import Session

from app.api import schemas
from app.api.deps import get_engine, get_session
from app.db.database import is_migrated
from app.db.models import Scan
from app.engine import discovery

router = APIRouter(tags=["health"])


@router.get("/health", response_model=schemas.Health)
def health(engine: Engine = Depends(get_engine), session: Session = Depends(get_session)):
    """Is the API up, is the database ready, and can this process ARP scan?"""
    database = is_migrated(engine)
    running = database and session.scalars(
        select(Scan.id).where(Scan.status == Scan.STATUS_RUNNING).limit(1)
    ).first() is not None
    return schemas.Health(
        status="ok" if database else "degraded",
        database=database,
        raw_sockets=discovery.can_open_raw_socket(),
        scan_running=running,
    )
