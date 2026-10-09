"""Topology route: the network map computed from a collection run."""

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api import schemas
from app.api.deps import get_session
from app.core.config import Settings, get_settings
from app.db import models
from app.services import collection_service

router = APIRouter(prefix="/topology", tags=["topology"])


@router.get("", response_model=schemas.Topology)
def get_topology(
    collection_id: int | None = Query(
        default=None, description="A collection run. Default: the latest finished one."
    ),
    session: Session = Depends(get_session),
    settings: Settings = Depends(get_settings),
):
    """Nodes and links of the network, as one collection run saw it.

    Devices and the links between them come from CDP, hosts from switch MAC
    tables, and each link carries its status, VLANs, spanning-tree state and
    OSPF adjacency. The management network is returned separately.
    """
    if collection_id is not None:
        run = session.get(models.NetworkCollection, collection_id)
        if run is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, f"Collection {collection_id} not found.")
        if run.status == models.NetworkCollection.STATUS_RUNNING:
            raise HTTPException(
                status.HTTP_409_CONFLICT, f"Collection {collection_id} is still running."
            )
    else:
        run = session.scalars(
            select(models.NetworkCollection)
            .where(models.NetworkCollection.status != models.NetworkCollection.STATUS_RUNNING)
            .order_by(models.NetworkCollection.id.desc())
            .limit(1)
        ).first()
        if run is None:
            raise HTTPException(
                status.HTTP_404_NOT_FOUND,
                "No collection has finished yet. Collect from all devices first; "
                "the topology is built from what they report.",
            )

    # Runs from before topologies were stored get theirs computed now.
    topology = run.topology or collection_service.build_run_topology(
        session, run, settings.allowed_subnets
    )
    return schemas.Topology(
        collection_id=run.id, collected_at=run.finished_at or run.started_at, **topology
    )
