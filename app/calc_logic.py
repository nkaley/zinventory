from __future__ import annotations

from decimal import Decimal
from typing import Dict, Set

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.models import CompositeItem, CompositeItemComponent, Item, Report, ReportDevice, ReportLine


def _d(value: object) -> Decimal:
    if value is None:
        return Decimal("0")
    return Decimal(str(value))


def _append_related_name(related_map: dict[str, list[str]], item_id: str, composite_name: str) -> None:
    if item_id not in related_map:
        related_map[item_id] = []

    if composite_name not in related_map[item_id]:
        related_map[item_id].append(composite_name)


def _expand_composite(
    db: Session,
    composite_zoho_item_id: str,
    multiplier: Decimal,
    totals: Dict[str, Decimal],
    related_map: dict[str, list[str]],
    visiting: Set[str] | None = None,
) -> None:
    if visiting is None:
        visiting = set()

    if composite_zoho_item_id in visiting:
        raise ValueError(f"Circular composite reference detected: {composite_zoho_item_id}")

    visiting.add(composite_zoho_item_id)

    composite = db.execute(
        select(CompositeItem).where(CompositeItem.zoho_composite_item_id == composite_zoho_item_id)
    ).scalar_one_or_none()

    if composite is None:
        raise ValueError(f"Composite item not found in local DB: {composite_zoho_item_id}")

    components = db.execute(
        select(CompositeItemComponent).where(CompositeItemComponent.composite_item_id == composite.id)
    ).scalars().all()

    for component in components:
        component_multiplier = multiplier * _d(component.quantity)

        if component.is_combo_product:
            _expand_composite(
                db=db,
                composite_zoho_item_id=component.component_zoho_item_id,
                multiplier=component_multiplier,
                totals=totals,
                related_map=related_map,
                visiting=set(visiting),
            )
        else:
            current = totals.get(component.component_zoho_item_id, Decimal("0"))
            totals[component.component_zoho_item_id] = current + component_multiplier
            _append_related_name(related_map, component.component_zoho_item_id, composite.name)


def calculate_report(db: Session, report_id: int) -> dict[str, object]:
    report = db.get(Report, report_id)
    if report is None:
        raise ValueError("Report not found")

    devices = db.execute(
        select(ReportDevice).where(ReportDevice.report_id == report_id)
    ).scalars().all()

    db.execute(delete(ReportLine).where(ReportLine.report_id == report_id))
    db.commit()

    totals: Dict[str, Decimal] = {}
    related_map: dict[str, list[str]] = {}

    for device in devices:
        _expand_composite(
            db=db,
            composite_zoho_item_id=device.zoho_composite_item_id,
            multiplier=Decimal(device.qty),
            totals=totals,
            related_map=related_map,
        )

    total_cost = Decimal("0")
    lines_count = 0

    for zoho_item_id, quantity in totals.items():
        item = db.execute(
            select(Item).where(Item.zoho_item_id == zoho_item_id)
        ).scalar_one_or_none()

        related_composite = None
        if zoho_item_id in related_map and related_map[zoho_item_id]:
            related_composite = "\n".join(related_map[zoho_item_id])

        if item is None:
            line = ReportLine(
                report_id=report_id,
                zoho_item_id=zoho_item_id,
                sku=None,
                item_name=f"Unknown item {zoho_item_id}",
                manufacturer=None,
                vendor_code=None,
                category_name=None,
                rate=Decimal("0"),
                stock_available=Decimal("0"),
                quantity=quantity,
                qty_tbo=quantity,
                total_cost=Decimal("0"),
                related_composite=related_composite,
            )
        else:
            stock_available = _d(item.stock_available)
            rate = _d(item.rate)
            qty_tbo = quantity - stock_available
            if qty_tbo < 0:
                qty_tbo = Decimal("0")
            line_total_cost = qty_tbo * rate

            line = ReportLine(
                report_id=report_id,
                zoho_item_id=item.zoho_item_id,
                sku=item.sku,
                item_name=item.name,
                manufacturer=item.manufacturer,
                vendor_code=item.vendor_code,
                category_name=item.category_name,
                rate=rate,
                stock_available=stock_available,
                quantity=quantity,
                qty_tbo=qty_tbo,
                total_cost=line_total_cost,
                related_composite=related_composite,
            )
            total_cost += line_total_cost

        db.add(line)
        lines_count += 1

    report.total_cost = total_cost
    report.status = "calculated"
    db.commit()

    return {
        "report_id": report_id,
        "total_cost": total_cost,
        "lines_count": lines_count,
    }