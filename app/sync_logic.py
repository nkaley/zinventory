from __future__ import annotations

from decimal import Decimal
from typing import Any

from sqlalchemy import delete, select
from sqlalchemy.orm import Session, selectinload

from app.models import CompositeItem, CompositeItemComponent, Item
from app.services.zoho_inventory import ZohoInventoryClient


def _to_decimal(value: Any) -> Decimal:
    if value in (None, "", "null"):
        return Decimal("0")
    return Decimal(str(value))


def sync_items(db: Session) -> dict[str, int]:
    client = ZohoInventoryClient()
    records = client.get_all_items()

    db.execute(delete(Item))
    db.commit()

    inserted = 0

    for rec in records:
        item = Item(
            zoho_item_id=str(rec.get("item_id", "")),
            sku=rec.get("sku"),
            name=rec.get("name") or "",
            manufacturer=rec.get("manufacturer"),
            vendor_code=rec.get("cf_vendor_order_number"),
            category_name=rec.get("category_name"),
            rate=_to_decimal(rec.get("rate")),
            stock_available=_to_decimal(rec.get("actual_available_stock")),
            is_active=(rec.get("status") == "active"),
            product_type=rec.get("product_type"),
            is_combo_product=bool(rec.get("is_combo_product")),
            raw_json=rec,
        )
        db.add(item)
        inserted += 1

    db.commit()

    return {
        "fetched": len(records),
        "inserted": inserted,
    }


def _fetch_components_for_composite(
    client: ZohoInventoryClient, zoho_composite_item_id: str
) -> list[dict[str, Any]]:
    details = client.get_composite_item_details(zoho_composite_item_id)
    composite_item = details.get("composite_item", {}) or {}
    return composite_item.get("mapped_items", []) or []


def _replace_components(
    db: Session,
    composite: CompositeItem,
    mapped_items: list[dict[str, Any]],
) -> int:
    db.execute(
        delete(CompositeItemComponent).where(
            CompositeItemComponent.composite_item_id == composite.id
        )
    )
    db.flush()

    inserted = 0
    for mapped in mapped_items:
        component = CompositeItemComponent(
            composite_item_id=composite.id,
            component_zoho_item_id=str(mapped.get("item_id", "")),
            component_name=mapped.get("name") or "",
            component_sku=mapped.get("sku"),
            quantity=_to_decimal(mapped.get("quantity")),
            product_type=mapped.get("product_type"),
            is_combo_product=bool(mapped.get("is_combo_product")),
            raw_json=mapped,
        )
        db.add(component)
        inserted += 1

    return inserted


def sync_composites(db: Session, *, force: bool = False) -> dict[str, int]:
    client = ZohoInventoryClient()
    records = client.get_all_composite_items()

    existing_composites = (
        db.execute(
            select(CompositeItem).options(selectinload(CompositeItem.components))
        )
        .scalars()
        .all()
    )
    existing_by_zoho_id: dict[str, CompositeItem] = {
        c.zoho_composite_item_id: c for c in existing_composites
    }

    seen_zoho_ids: set[str] = set()
    composite_count = 0
    component_count = 0
    detail_calls = 0
    skipped = 0

    for rec in records:
        zoho_id = str(rec.get("composite_item_id", ""))
        if not zoho_id:
            continue

        seen_zoho_ids.add(zoho_id)
        existing = existing_by_zoho_id.get(zoho_id)

        zoho_lmt = rec.get("last_modified_time")
        existing_lmt = (
            (existing.raw_json or {}).get("last_modified_time")
            if existing and existing.raw_json
            else None
        )

        unchanged = (
            not force
            and existing is not None
            and bool(zoho_lmt)
            and bool(existing_lmt)
            and zoho_lmt == existing_lmt
        )

        if unchanged and existing is not None:
            composite_count += 1
            component_count += len(existing.components)
            skipped += 1
            continue

        if existing is None:
            composite = CompositeItem(
                zoho_composite_item_id=zoho_id,
                sku=rec.get("sku"),
                name=rec.get("name") or "",
                is_active=(rec.get("status") == "active"),
                raw_json=rec,
            )
            db.add(composite)
            db.flush()
        else:
            composite = existing
            composite.sku = rec.get("sku")
            composite.name = rec.get("name") or ""
            composite.is_active = (rec.get("status") == "active")
            composite.raw_json = rec

        mapped_items = _fetch_components_for_composite(client, zoho_id)
        detail_calls += 1
        component_count += _replace_components(db, composite, mapped_items)
        composite_count += 1

    deleted = 0
    for zoho_id, composite in existing_by_zoho_id.items():
        if zoho_id not in seen_zoho_ids:
            db.delete(composite)
            deleted += 1

    db.commit()

    return {
        "fetched_composites": len(records),
        "inserted_composites": composite_count,
        "inserted_components": component_count,
        "skipped_composites": skipped,
        "detail_calls": detail_calls,
        "deleted_composites": deleted,
    }