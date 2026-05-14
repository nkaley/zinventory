from __future__ import annotations

import time
from decimal import Decimal
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.calc_logic import _d, _expand_composite
from app.models import CompositeItem, Item
from app.services.zoho_inventory import ZohoInventoryClient


COST_DELTA_THRESHOLD = Decimal("0.01")
TWO_PLACES = Decimal("0.01")
ZOHO_PUT_DELAY_SECONDS = 0.6


def _quantize(value: Decimal) -> Decimal:
    return value.quantize(TWO_PLACES)


def _compute_new_purchase_rate(
    db: Session,
    composite: CompositeItem,
) -> tuple[Decimal, bool, bool]:
    totals: dict[str, Decimal] = {}
    related: dict[str, list[str]] = {}

    _expand_composite(
        db=db,
        composite_zoho_item_id=composite.zoho_composite_item_id,
        multiplier=Decimal("1"),
        totals=totals,
        related_map=related,
    )

    if not totals:
        return Decimal("0"), True, True

    new_rate = Decimal("0")
    has_zero_leaf = False

    for zoho_item_id, qty in totals.items():
        item = db.execute(
            select(Item).where(Item.zoho_item_id == zoho_item_id)
        ).scalar_one_or_none()

        rate = _d(item.rate) if item is not None else Decimal("0")
        if rate <= 0:
            has_zero_leaf = True

        new_rate += rate * qty

    return new_rate, has_zero_leaf, False


def _current_purchase_rate(composite: CompositeItem) -> Decimal:
    raw = composite.raw_json or {}
    return _d(raw.get("purchase_rate"))


def _change_entry(composite: CompositeItem, old: Decimal, new: Decimal) -> dict[str, Any]:
    return {
        "composite_id": composite.zoho_composite_item_id,
        "name": composite.name,
        "sku": composite.sku,
        "current_purchase_rate": float(_quantize(old)),
        "new_purchase_rate": float(_quantize(new)),
        "delta": float(_quantize(new - old)),
    }


def _skipped_entry(
    composite: CompositeItem,
    old: Decimal,
    new: Decimal,
    reason: str,
) -> dict[str, Any]:
    return {
        "composite_id": composite.zoho_composite_item_id,
        "name": composite.name,
        "sku": composite.sku,
        "current_purchase_rate": float(_quantize(old)),
        "computed_purchase_rate": float(_quantize(new)),
        "reason": reason,
    }


def recalculate_composite_costs(
    db: Session,
    *,
    dry_run: bool,
) -> dict[str, Any]:
    composites = (
        db.execute(
            select(CompositeItem).where(CompositeItem.is_active.is_(True))
        )
        .scalars()
        .all()
    )

    to_update: list[dict[str, Any]] = []
    updated: list[dict[str, Any]] = []
    skipped_unreliable: list[dict[str, Any]] = []
    skipped_no_change = 0
    errors: list[dict[str, Any]] = []

    client: ZohoInventoryClient | None = None if dry_run else ZohoInventoryClient()
    needs_delay = False

    for composite in composites:
        try:
            new_rate, has_zero_leaf, empty_bom = _compute_new_purchase_rate(
                db, composite
            )
        except Exception as exc:
            errors.append(
                {
                    "composite_id": composite.zoho_composite_item_id,
                    "name": composite.name,
                    "sku": composite.sku,
                    "current_purchase_rate": None,
                    "new_purchase_rate": None,
                    "delta": None,
                    "error": f"compute failed: {exc}",
                }
            )
            continue

        old_rate = _current_purchase_rate(composite)
        new_rate_q = _quantize(new_rate)
        old_rate_q = _quantize(old_rate)
        delta = new_rate_q - old_rate_q

        if empty_bom:
            skipped_unreliable.append(
                _skipped_entry(composite, old_rate, new_rate, "empty_bom")
            )
            continue

        if has_zero_leaf:
            skipped_unreliable.append(
                _skipped_entry(composite, old_rate, new_rate, "zero_rate_leaf")
            )
            continue

        if abs(delta) < COST_DELTA_THRESHOLD:
            skipped_no_change += 1
            continue

        entry = _change_entry(composite, old_rate, new_rate)
        to_update.append(entry)

        if dry_run:
            continue

        try:
            if needs_delay:
                time.sleep(ZOHO_PUT_DELAY_SECONDS)
            assert client is not None
            response = client.update_composite_item_purchase_rate(
                composite.zoho_composite_item_id,
                new_rate_q,
            )
            needs_delay = True

            updated_composite = response.get("composite_item") if response else None
            new_raw = dict(composite.raw_json or {})
            if updated_composite:
                new_raw.update(updated_composite)
            new_raw["purchase_rate"] = float(new_rate_q)
            composite.raw_json = new_raw

            updated.append(entry)
        except Exception as exc:
            errors.append({**entry, "error": str(exc)})

    if not dry_run:
        db.commit()

    return {
        "dry_run": dry_run,
        "threshold": float(COST_DELTA_THRESHOLD),
        "checked": len(composites),
        "skipped_no_change": skipped_no_change,
        "to_update": to_update,
        "skipped_unreliable": skipped_unreliable,
        "updated": updated,
        "errors": errors,
    }
