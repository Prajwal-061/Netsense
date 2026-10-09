"""NetSense API entry point.

Run from backend/ (never as root):
    .venv/bin/uvicorn app.main:app --host 192.168.17.132 --port 8000

WARNING: there is no authentication yet. Only run this on the isolated lab
network.
"""

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy.orm import Session

from app.api import collections, devices, health, scans, topology
from app.api.deps import get_engine
from app.core.config import get_settings
from app.db.database import is_migrated, migration_status
from app.services import collection_service, scan_service

logger = logging.getLogger("uvicorn.error")


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Runs once when the server starts (before the yield) and stops (after)."""
    engine = get_engine()
    if not is_migrated(engine):
        raise RuntimeError(
            "The database has not been created. Run: cd backend && .venv/bin/alembic upgrade head"
        )
    current, newest = migration_status(engine)
    if current != newest:
        raise RuntimeError(
            f"The database is at revision {current} but this code needs {newest}. "
            "Run: cd backend && .venv/bin/alembic upgrade head"
        )
    # A scan cannot outlive the process that ran it, so anything still
    # "running" now was cut off, and would block every new scan.
    with Session(engine) as session:
        interrupted = scan_service.fail_interrupted_scans(session)
        interrupted += collection_service.fail_interrupted_collections(session)
    if interrupted:
        logger.warning("Marked %s interrupted scan(s) or collection(s) as failed.", interrupted)
    yield


app = FastAPI(
    title="NetSense API",
    description="Network discovery and diagnostics. No authentication yet: lab use only.",
    lifespan=lifespan,
)

# Browsers block a page from calling an API on a different origin (scheme +
# host + port) unless the API allows that origin. The dashboard's dev server
# is such a different origin, so it is listed in CORS_ORIGINS.
app.add_middleware(
    CORSMiddleware,
    allow_origins=get_settings().cors_origins,
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)

app.include_router(health.router)
app.include_router(scans.router)
app.include_router(collections.router)
app.include_router(topology.router)
app.include_router(devices.router)
