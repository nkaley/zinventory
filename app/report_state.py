from sqlalchemy import delete
from sqlalchemy.orm import Session

from app.models import Report, ReportLine


def reset_report_calculation(db: Session, report: Report) -> None:
    db.execute(delete(ReportLine).where(ReportLine.report_id == report.id))
    report.total_cost = 0
    report.status = "draft"