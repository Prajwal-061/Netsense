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
from fastapi.responses import JSONResponse
from sqlalchemy.orm import Session

from fastapi import Depends

from app.api import auth, collections, devices, drift, health, scans, topology
from app.api.deps import get_engine
from app.core.config import get_settings
from app.db.database import is_migrated, migration_status
from app.services import collection_service, drift_service, scan_service

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
        interrupted += drift_service.fail_interrupted_drift_checks(session)
    if interrupted:
        logger.warning("Marked %s interrupted scan(s) or collection(s) as failed.", interrupted)
    yield


app = FastAPI(
    title="NetSense API",
    description="Network discovery and diagnostics. No authentication yet: lab use only.",
    lifespan=lifespan,
)

# Every HTTP method the API's routes use. The browser asks first (a CORS
# "preflight") whether the dashboard may send a PUT or POST; a method missing
# here makes the browser drop the request, and the page only sees a failed
# fetch. tests/test_api.py checks this list against every route.
ALLOWED_METHODS = ["GET", "POST", "PUT"]


class UnhandledErrorsAsJson:
    """Turn an unhandled exception into a JSON 500 response.

    Starlette's own handler for unhandled errors sits outside every other
    middleware, CORS included, so its 500 response has no CORS headers and
    the browser will not let the dashboard read it: the page sees a network
    failure instead. Added before CORSMiddleware, this middleware sits inside
    it, so its response gets the CORS headers like any other.

    The response names only the type of error. The message and traceback can
    contain SQL, addresses or config text, so they go to the server log.
    """

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        started = False

        async def send_and_track(message):
            nonlocal started
            if message["type"] == "http.response.start":
                started = True
            await send(message)

        try:
            await self.app(scope, receive, send_and_track)
        except Exception as exc:
            logger.exception("Unhandled error in %s %s", scope.get("method"), scope.get("path"))
            if started:
                raise  # part of a response was already sent: nothing to replace
            response = JSONResponse(
                {
                    "detail": f"Internal server error ({type(exc).__name__}) while handling "
                    f"{scope.get('method')} {scope.get('path')}. The full error is in the backend's log."
                },
                status_code=500,
            )
            await response(scope, receive, send)


# Order matters: middleware added later wraps middleware added earlier.
app.add_middleware(UnhandledErrorsAsJson)

# Browsers block a page from calling an API on a different origin (scheme +
# host + port) unless the API allows that origin. The dashboard's dev server
# is such a different origin, so it is listed in CORS_ORIGINS.
app.add_middleware(
    CORSMiddleware,
    allow_origins=get_settings().cors_origins,
    allow_methods=ALLOWED_METHODS,
    allow_headers=["Content-Type"],
    # Lets the browser send the session cookie with the dashboard's requests.
    # Only safe with an explicit list of origins, never "*".
    allow_credentials=True,
)

# Public: the health check (the dashboard uses it to tell "API down" from
# "not logged in") and the login routes. Everything else needs a session.
app.include_router(health.router)
app.include_router(auth.router)
protected = [Depends(auth.require_admin)]
app.include_router(scans.router, dependencies=protected)
app.include_router(collections.router, dependencies=protected)
app.include_router(topology.router, dependencies=protected)
app.include_router(drift.router, dependencies=protected)
app.include_router(devices.router, dependencies=protected)
