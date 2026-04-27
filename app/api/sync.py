from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.db import get_db
from app.models import CompositeItem, Item
from app.schemas import FullSyncResult, LastSyncResponse, SyncResult
from app.sync_logic import sync_composites, sync_items

router = APIRouter(prefix="/sync", tags=["sync"])


@router.post("/items", response_model=SyncResult)
def sync_items_endpoint(db: Session = Depends(get_db)) -> SyncResult:
    try:
        result = sync_items(db)
        return SyncResult(**result)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Items sync failed: {exc}") from exc


@router.post("/composites", response_model=SyncResult)
def sync_composites_endpoint(
    force: bool = Query(default=False),
    db: Session = Depends(get_db),
) -> SyncResult:
    try:
        result = sync_composites(db, force=force)
        return SyncResult(**result)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Composites sync failed: {exc}") from exc


@router.post("/full", response_model=FullSyncResult)
def sync_full_endpoint(
    force: bool = Query(default=False),
    db: Session = Depends(get_db),
) -> FullSyncResult:
    try:
        items_result = sync_items(db)
        composites_result = sync_composites(db, force=force)

        return FullSyncResult(
            items=SyncResult(**items_result),
            composites=SyncResult(**composites_result),
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Full sync failed: {exc}") from exc


@router.get("/last", response_model=LastSyncResponse)
def get_last_sync_endpoint(db: Session = Depends(get_db)) -> LastSyncResponse:
    last_items_sync = db.execute(select(func.max(Item.updated_at))).scalar_one_or_none()
    last_composites_sync = db.execute(select(func.max(CompositeItem.updated_at))).scalar_one_or_none()

    candidates = [value for value in [last_items_sync, last_composites_sync] if value is not None]
    last_full_sync_at = max(candidates) if candidates else None

    return LastSyncResponse(last_full_sync_at=last_full_sync_at)