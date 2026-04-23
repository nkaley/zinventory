from __future__ import annotations

from decimal import Decimal
from typing import Any

from sqlalchemy import delete
from sqlalchemy.orm import Session

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


def sync_composites(db: Session) -> dict[str, int]:
    client = ZohoInventoryClient()
    records = client.get_all_composite_items()

    db.execute(delete(CompositeItemComponent))
    db.execute(delete(CompositeItem))
    db.commit()

    composite_inserted = 0
    component_inserted = 0

    for rec in records:
        composite = CompositeItem(
            zoho_composite_item_id=str(rec.get("composite_item_id", "")),
            sku=rec.get("sku"),
            name=rec.get("name") or "",
            is_active=(rec.get("status") == "active"),
            raw_json=rec,
        )
        db.add(composite)
        db.flush()

        composite_inserted += 1

        details = client.get_composite_item_details(str(rec.get("composite_item_id")))
        composite_item = details.get("composite_item", {}) or {}
        mapped_items = composite_item.get("mapped_items", []) or []

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
            component_inserted += 1

    db.commit()

    return {
        "fetched_composites": len(records),
        "inserted_composites": composite_inserted,
        "inserted_components": component_inserted,
    }