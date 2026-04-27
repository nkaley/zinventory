from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, JSON, Numeric, String, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base


class Report(Base):
    __tablename__ = "reports"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    status: Mapped[str] = mapped_column(String(50), nullable=False, default="draft")
    total_cost: Mapped[float] = mapped_column(Numeric(12, 2), nullable=False, default=0)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )

    devices: Mapped[list["ReportDevice"]] = relationship(
        "ReportDevice",
        back_populates="report",
        cascade="all, delete-orphan",
    )

    lines: Mapped[list["ReportLine"]] = relationship(
        "ReportLine",
        back_populates="report",
        cascade="all, delete-orphan",
    )


class ReportDevice(Base):
    __tablename__ = "report_devices"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)

    report_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("reports.id", ondelete="CASCADE"),
        nullable=False,
    )

    zoho_composite_item_id: Mapped[str] = mapped_column(String(50), nullable=False)
    device_name: Mapped[str] = mapped_column(String(255), nullable=False)
    qty: Mapped[int] = mapped_column(Integer, nullable=False)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    )

    report: Mapped["Report"] = relationship("Report", back_populates="devices")


class ReportLine(Base):
    __tablename__ = "report_lines"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)

    report_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("reports.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )

    zoho_item_id: Mapped[str] = mapped_column(String(50), nullable=False, index=True)
    sku: Mapped[str | None] = mapped_column(String(100), nullable=True, index=True)
    item_name: Mapped[str] = mapped_column(String(255), nullable=False, index=True)
    manufacturer: Mapped[str | None] = mapped_column(String(255), nullable=True)
    vendor_code: Mapped[str | None] = mapped_column(String(255), nullable=True)
    category_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    rate: Mapped[float] = mapped_column(Numeric(12, 2), nullable=False, default=0)
    stock_available: Mapped[float] = mapped_column(Numeric(12, 2), nullable=False, default=0)
    quantity: Mapped[float] = mapped_column(Numeric(12, 4), nullable=False, default=0)
    qty_tbo: Mapped[float] = mapped_column(Numeric(12, 4), nullable=False, default=0)
    total_cost: Mapped[float] = mapped_column(Numeric(12, 2), nullable=False, default=0)
    related_composite: Mapped[str | None] = mapped_column(String(5000), nullable=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )

    report: Mapped["Report"] = relationship("Report", back_populates="lines")


class Item(Base):
    __tablename__ = "items"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    zoho_item_id: Mapped[str] = mapped_column(String(50), unique=True, nullable=False, index=True)
    sku: Mapped[str | None] = mapped_column(String(100), nullable=True, index=True)
    name: Mapped[str] = mapped_column(String(255), nullable=False, index=True)
    manufacturer: Mapped[str | None] = mapped_column(String(255), nullable=True)
    vendor_code: Mapped[str | None] = mapped_column(String(255), nullable=True)
    category_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    rate: Mapped[float] = mapped_column(Numeric(12, 2), nullable=False, default=0)
    stock_available: Mapped[float] = mapped_column(Numeric(12, 2), nullable=False, default=0)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    product_type: Mapped[str | None] = mapped_column(String(50), nullable=True)
    is_combo_product: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    raw_json: Mapped[dict | None] = mapped_column(JSON, nullable=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )


class CompositeItem(Base):
    __tablename__ = "composite_items"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    zoho_composite_item_id: Mapped[str] = mapped_column(String(50), unique=True, nullable=False, index=True)
    sku: Mapped[str | None] = mapped_column(String(100), nullable=True, index=True)
    name: Mapped[str] = mapped_column(String(255), nullable=False, index=True)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    raw_json: Mapped[dict | None] = mapped_column(JSON, nullable=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )

    components: Mapped[list["CompositeItemComponent"]] = relationship(
        "CompositeItemComponent",
        back_populates="composite_item",
        cascade="all, delete-orphan",
    )


class CompositeItemComponent(Base):
    __tablename__ = "composite_item_components"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)

    composite_item_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("composite_items.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )

    component_zoho_item_id: Mapped[str] = mapped_column(String(50), nullable=False, index=True)
    component_name: Mapped[str] = mapped_column(String(255), nullable=False)
    component_sku: Mapped[str | None] = mapped_column(String(100), nullable=True)
    quantity: Mapped[float] = mapped_column(Numeric(12, 4), nullable=False, default=0)
    product_type: Mapped[str | None] = mapped_column(String(50), nullable=True)
    is_combo_product: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    raw_json: Mapped[dict | None] = mapped_column(JSON, nullable=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )

    composite_item: Mapped["CompositeItem"] = relationship("CompositeItem", back_populates="components")


class ActiveSessionLock(Base):
    __tablename__ = "active_session_locks"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    lock_name: Mapped[str] = mapped_column(String(50), unique=True, nullable=False, default="global")
    session_id: Mapped[str] = mapped_column(String(128), nullable=False, index=True)
    acquired_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    )
    expires_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        index=True,
    )