from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload
from urllib.parse import quote

from app.calc_logic import calculate_report
from app.db import get_db
from app.export_logic import export_report_xlsx
from app.models import Report, ReportDevice
from app.report_state import reset_report_calculation
from app.schemas import (
    CalculateResult,
    MessageResponse,
    ReportCreate,
    ReportDeviceCreate,
    ReportDeviceRead,
    ReportDeviceUpdate,
    ReportRead,
    ReportUpdate,
)

router = APIRouter(prefix="/reports", tags=["reports"])


@router.post("", response_model=ReportRead)
def create_report(payload: ReportCreate, db: Session = Depends(get_db)) -> Report:
    report = Report(
        title=payload.title,
        status="draft",
        total_cost=0,
    )
    db.add(report)
    db.commit()
    db.refresh(report)
    return report


@router.get("", response_model=list[ReportRead])
def list_reports(db: Session = Depends(get_db)) -> list[Report]:
    result = db.execute(
        select(Report)
        .options(selectinload(Report.devices), selectinload(Report.lines))
        .order_by(Report.id.desc())
    )
    return list(result.scalars().all())


@router.get("/{report_id}", response_model=ReportRead)
def get_report(report_id: int, db: Session = Depends(get_db)) -> Report:
    result = db.execute(
        select(Report)
        .options(selectinload(Report.devices), selectinload(Report.lines))
        .where(Report.id == report_id)
    )
    report = result.scalar_one_or_none()

    if report is None:
        raise HTTPException(status_code=404, detail="Report not found")

    return report


@router.patch("/{report_id}", response_model=ReportRead)
def update_report(
    report_id: int,
    payload: ReportUpdate,
    db: Session = Depends(get_db),
) -> Report:
    report = db.get(Report, report_id)
    if report is None:
        raise HTTPException(status_code=404, detail="Report not found")

    if payload.title is not None:
        report.title = payload.title
    if payload.status is not None:
        report.status = payload.status

    db.commit()
    db.refresh(report)
    return get_report(report_id, db)


@router.delete("/{report_id}", response_model=MessageResponse)
def delete_report(report_id: int, db: Session = Depends(get_db)) -> MessageResponse:
    report = db.get(Report, report_id)
    if report is None:
        raise HTTPException(status_code=404, detail="Report not found")

    db.delete(report)
    db.commit()
    return MessageResponse(message="Report deleted")


@router.post("/{report_id}/devices", response_model=ReportDeviceRead)
def add_device_to_report(
    report_id: int,
    payload: ReportDeviceCreate,
    db: Session = Depends(get_db),
) -> ReportDevice:
    report = db.get(Report, report_id)
    if report is None:
        raise HTTPException(status_code=404, detail="Report not found")

    device = ReportDevice(
        report_id=report_id,
        zoho_composite_item_id=payload.zoho_composite_item_id,
        device_name=payload.device_name,
        qty=payload.qty,
    )

    db.add(device)
    db.flush()

    reset_report_calculation(db, report)

    db.commit()
    db.refresh(device)

    return device


@router.patch("/{report_id}/devices/{device_id}", response_model=ReportDeviceRead)
def update_device_in_report(
    report_id: int,
    device_id: int,
    payload: ReportDeviceUpdate,
    db: Session = Depends(get_db),
) -> ReportDevice:
    device = db.get(ReportDevice, device_id)
    if device is None or device.report_id != report_id:
        raise HTTPException(status_code=404, detail="Report device not found")

    report = db.get(Report, report_id)
    if report is None:
        raise HTTPException(status_code=404, detail="Report not found")

    if payload.zoho_composite_item_id is not None:
        device.zoho_composite_item_id = payload.zoho_composite_item_id
    if payload.device_name is not None:
        device.device_name = payload.device_name
    if payload.qty is not None:
        device.qty = payload.qty

    reset_report_calculation(db, report)

    db.commit()
    db.refresh(device)
    return device


@router.delete("/{report_id}/devices/{device_id}", response_model=MessageResponse)
def delete_device_from_report(
    report_id: int,
    device_id: int,
    db: Session = Depends(get_db),
) -> MessageResponse:
    device = db.get(ReportDevice, device_id)
    if device is None or device.report_id != report_id:
        raise HTTPException(status_code=404, detail="Report device not found")

    report = db.get(Report, report_id)
    if report is None:
        raise HTTPException(status_code=404, detail="Report not found")

    db.delete(device)
    db.flush()

    reset_report_calculation(db, report)

    db.commit()

    return MessageResponse(message="Device deleted")


@router.post("/{report_id}/calculate", response_model=CalculateResult)
def calculate_report_endpoint(report_id: int, db: Session = Depends(get_db)) -> CalculateResult:
    try:
        result = calculate_report(db, report_id)
        return CalculateResult(**result)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/{report_id}/export/xlsx")
def export_report_xlsx_endpoint(report_id: int, db: Session = Depends(get_db)) -> StreamingResponse:
    try:
        output, filename = export_report_xlsx(db, report_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    ascii_filename = filename.encode("ascii", "ignore").decode("ascii").strip()
    if not ascii_filename:
        ascii_filename = f"report_{report_id}.xlsx"

    # Use RFC 5987 for Unicode filenames while keeping latin-1-safe fallback.
    content_disposition = (
        f'attachment; filename="{ascii_filename}"; '
        f"filename*=UTF-8''{quote(filename)}"
    )
    headers = {"Content-Disposition": content_disposition}

    return StreamingResponse(
        output,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers=headers,
    )