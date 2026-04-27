from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session, selectinload

from app.db import get_db
from app.models import CompositeItem, Item
from app.schemas import (
    CompositeItemRead,
    ItemRead,
    PaginatedCompositesResponse,
    PaginatedItemsResponse,
)

router = APIRouter(prefix="/catalog", tags=["catalog"])


@router.get("/items", response_model=PaginatedItemsResponse)
def list_items(
    q: str | None = Query(default=None),
    limit: int = Query(default=50, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
    db: Session = Depends(get_db),
) -> PaginatedItemsResponse:
    filters = []
    if q:
        pattern = f"%{q.strip()}%"
        filters.append(
            or_(
                Item.name.ilike(pattern),
                Item.sku.ilike(pattern),
                Item.zoho_item_id.ilike(pattern),
                Item.manufacturer.ilike(pattern),
                Item.category_name.ilike(pattern),
            )
        )

    count_stmt = select(func.count()).select_from(Item)
    if filters:
        for f in filters:
            count_stmt = count_stmt.where(f)

    stmt = select(Item).order_by(Item.name.asc()).limit(limit).offset(offset)
    if filters:
        for f in filters:
            stmt = stmt.where(f)

    total = db.execute(count_stmt).scalar_one()
    rows = list(db.execute(stmt).scalars().all())

    return PaginatedItemsResponse(
        total=total,
        limit=limit,
        offset=offset,
        items=rows,
    )


@router.get("/items/{item_id}", response_model=ItemRead)
def get_item(item_id: int, db: Session = Depends(get_db)) -> Item:
    item = db.get(Item, item_id)
    if item is None:
        raise HTTPException(status_code=404, detail="Item not found")
    return item


@router.get("/composites", response_model=PaginatedCompositesResponse)
def list_composites(
    q: str | None = Query(default=None),
    limit: int = Query(default=50, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
    include_components: bool = Query(default=False),
    include_inactive: bool = Query(default=False),
    db: Session = Depends(get_db),
) -> PaginatedCompositesResponse:
    filters = []
    if not include_inactive:
        filters.append(CompositeItem.is_active.is_(True))
    if q:
        pattern = f"%{q.strip()}%"
        filters.append(
            or_(
                CompositeItem.name.ilike(pattern),
                CompositeItem.sku.ilike(pattern),
                CompositeItem.zoho_composite_item_id.ilike(pattern),
            )
        )

    count_stmt = select(func.count()).select_from(CompositeItem)
    if filters:
        for f in filters:
            count_stmt = count_stmt.where(f)

    stmt = select(CompositeItem).order_by(CompositeItem.name.asc()).limit(limit).offset(offset)
    if include_components:
        stmt = stmt.options(selectinload(CompositeItem.components))
    if filters:
        for f in filters:
            stmt = stmt.where(f)

    total = db.execute(count_stmt).scalar_one()
    rows = list(db.execute(stmt).scalars().all())

    return PaginatedCompositesResponse(
        total=total,
        limit=limit,
        offset=offset,
        items=rows,
    )


@router.get("/composites/{composite_id}", response_model=CompositeItemRead)
def get_composite(composite_id: int, db: Session = Depends(get_db)) -> CompositeItem:
    result = db.execute(
        select(CompositeItem)
        .options(selectinload(CompositeItem.components))
        .where(CompositeItem.id == composite_id)
    )
    composite = result.scalar_one_or_none()

    if composite is None:
        raise HTTPException(status_code=404, detail="Composite item not found")

    return composite