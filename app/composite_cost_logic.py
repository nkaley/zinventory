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
) -> tuple[Decimal, list[dict[str, Any]], bool]:
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
        return Decimal("0"), [], True

    new_rate = Decimal("0")
    zero_components: list[dict[str, Any]] = []

    for zoho_item_id, qty in totals.items():
        item = db.execute(
            select(Item).where(Item.zoho_item_id == zoho_item_id)
        ).scalar_one_or_none()

        rate = _d(item.rate) if item is not None else Decimal("0")
        if rate <= 0:
            zero_components.append(
                {
                    "zoho_item_id": zoho_item_id,
                    "name": item.name if item is not None else "",
                    "sku": item.sku if item is not None else None,
                    "quantity": float(qty),
                }
            )

        new_rate += rate * qty

    return new_rate, zero_components, False


def _current_purchase_rate(composite: CompositeItem) -> Decimal:
    raw = composite.raw_json or {}
    return _d(raw.get("purchase_rate"))


def _candidate_entry(
    composite: CompositeItem,
    old: Decimal,
    new: Decimal,
    zero_components: list[dict[str, Any]],
) -> dict[str, Any]:
    return {
        "composite_id": composite.zoho_composite_item_id,
        "name": composite.name,
        "sku": composite.sku,
        "current_purchase_rate": float(_quantize(old)),
        "new_purchase_rate": float(_quantize(new)),
        "delta": float(_quantize(new - old)),
        "zero_rate_components": zero_components,
        "status": None,
        "error": None,
    }


def recalculate_composite_costs(
    db: Session,
    *,
    dry_run: bool,
    composite_ids: list[str] | None = None,
) -> dict[str, Any]:
    composites = (
        db.execute(
            select(CompositeItem).where(CompositeItem.is_active.is_(True))
        )
        .scalars()
        .all()
    )

    if not dry_run:
        if not composite_ids:
            raise ValueError(
                "composite_ids must be a non-empty list when dry_run=false"
            )
        selected_ids = set(composite_ids)
    else:
        selected_ids = None

    candidates: list[dict[str, Any]] = []
    skipped_no_change = 0
    skipped_empty_bom = 0

    if dry_run:
        for composite in composites:
            try:
                new_rate, zero_components, empty_bom = _compute_new_purchase_rate(
                    db, composite
                )
            except Exception as exc:
                candidates.append(
                    {
                        "composite_id": composite.zoho_composite_item_id,
                        "name": composite.name,
                        "sku": composite.sku,
                        "current_purchase_rate": float(
                            _quantize(_current_purchase_rate(composite))
                        ),
                        "new_purchase_rate": float(
                            _quantize(_current_purchase_rate(composite))
                        ),
                        "delta": 0.0,
                        "zero_rate_components": [],
                        "status": "error",
                        "error": f"compute failed: {exc}",
                    }
                )
                continue

            if empty_bom:
                skipped_empty_bom += 1
                continue

            old_rate = _current_purchase_rate(composite)
            delta = _quantize(new_rate) - _quantize(old_rate)

            if abs(delta) < COST_DELTA_THRESHOLD:
                skipped_no_change += 1
                continue

            candidates.append(
                _candidate_entry(composite, old_rate, new_rate, zero_components)
            )

        return {
            "dry_run": True,
            "threshold": float(COST_DELTA_THRESHOLD),
            "checked": len(composites),
            "skipped_no_change": skipped_no_change,
            "skipped_empty_bom": skipped_empty_bom,
            "candidates": candidates,
        }

    client = ZohoInventoryClient()
    needs_delay = False

    composites_by_zoho_id: dict[str, CompositeItem] = {
        c.zoho_composite_item_id: c for c in composites
    }

    for zoho_id in composite_ids or []:
        composite = composites_by_zoho_id.get(zoho_id)
        if composite is None:
            candidates.append(
                {
                    "composite_id": zoho_id,
                    "name": "",
                    "sku": None,
                    "current_purchase_rate": 0.0,
                    "new_purchase_rate": 0.0,
                    "delta": 0.0,
                    "zero_rate_components": [],
                    "status": "error",
                    "error": "Composite not found in local DB",
                }
            )
            continue

        try:
            new_rate, zero_components, empty_bom = _compute_new_purchase_rate(
                db, composite
            )
        except Exception as exc:
            candidates.append(
                _candidate_entry(
                    composite,
                    _current_purchase_rate(composite),
                    _current_purchase_rate(composite),
                    [],
                )
                | {"status": "error", "error": f"compute failed: {exc}"}
            )
            continue

        old_rate = _current_purchase_rate(composite)

        if empty_bom:
            entry = _candidate_entry(composite, old_rate, old_rate, [])
            entry["status"] = "error"
            entry["error"] = "Empty BOM"
            candidates.append(entry)
            continue

        entry = _candidate_entry(composite, old_rate, new_rate, zero_components)
        new_rate_q = _quantize(new_rate)

        try:
            if needs_delay:
                time.sleep(ZOHO_PUT_DELAY_SECONDS)
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

            entry["status"] = "updated"
        except Exception as exc:
            entry["status"] = "error"
            entry["error"] = str(exc)

        candidates.append(entry)

    db.commit()

    return {
        "dry_run": False,
        "threshold": float(COST_DELTA_THRESHOLD),
        "checked": len(composite_ids or []),
        "skipped_no_change": 0,
        "skipped_empty_bom": 0,
        "candidates": candidates,
    }
