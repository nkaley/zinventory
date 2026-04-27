from datetime import datetime
from decimal import Decimal

from pydantic import BaseModel, Field


class HealthResponse(BaseModel):
    status: str = "ok"


class SyncResult(BaseModel):
    fetched: int | None = None
    inserted: int | None = None
    fetched_composites: int | None = None
    inserted_composites: int | None = None
    inserted_components: int | None = None
    skipped_composites: int | None = None
    deleted_composites: int | None = None
    detail_calls: int | None = None


class FullSyncResult(BaseModel):
    items: SyncResult
    composites: SyncResult


class LastSyncResponse(BaseModel):
    last_full_sync_at: datetime | None = None


class ReportDeviceCreate(BaseModel):
    zoho_composite_item_id: str
    device_name: str
    qty: int = Field(gt=0)


class ReportDeviceUpdate(BaseModel):
    zoho_composite_item_id: str | None = None
    device_name: str | None = None
    qty: int | None = Field(default=None, gt=0)


class ReportDeviceRead(BaseModel):
    id: int
    zoho_composite_item_id: str
    device_name: str
    qty: int
    created_at: datetime

    model_config = {"from_attributes": True}


class ReportLineRead(BaseModel):
    id: int
    zoho_item_id: str
    sku: str | None
    item_name: str
    manufacturer: str | None
    vendor_code: str | None
    category_name: str | None
    rate: Decimal
    stock_available: Decimal
    quantity: Decimal
    qty_tbo: Decimal
    total_cost: Decimal
    related_composite: str | None
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class ReportCreate(BaseModel):
    title: str = Field(min_length=1, max_length=255)


class ReportUpdate(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=255)
    status: str | None = None


class ReportRead(BaseModel):
    id: int
    title: str
    status: str
    total_cost: Decimal
    created_at: datetime
    updated_at: datetime
    devices: list[ReportDeviceRead] = []
    lines: list[ReportLineRead] = []

    model_config = {"from_attributes": True}


class ItemRead(BaseModel):
    id: int
    zoho_item_id: str
    sku: str | None
    name: str
    manufacturer: str | None
    vendor_code: str | None
    category_name: str | None
    rate: Decimal
    stock_available: Decimal
    is_active: bool
    product_type: str | None
    is_combo_product: bool
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class CompositeItemComponentRead(BaseModel):
    id: int
    component_zoho_item_id: str
    component_name: str
    component_sku: str | None
    quantity: Decimal
    product_type: str | None
    is_combo_product: bool
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class CompositeItemRead(BaseModel):
    id: int
    zoho_composite_item_id: str
    sku: str | None
    name: str
    is_active: bool
    created_at: datetime
    updated_at: datetime
    components: list[CompositeItemComponentRead] = []

    model_config = {"from_attributes": True}


class CalculateResult(BaseModel):
    report_id: int
    total_cost: Decimal
    lines_count: int


class PaginatedItemsResponse(BaseModel):
    total: int
    limit: int
    offset: int
    items: list[ItemRead]


class PaginatedCompositesResponse(BaseModel):
    total: int
    limit: int
    offset: int
    items: list[CompositeItemRead]


class MessageResponse(BaseModel):
    message: str


class SessionAcquireRequest(BaseModel):
    session_id: str = Field(min_length=8, max_length=128)


class SessionReleaseRequest(BaseModel):
    session_id: str = Field(min_length=8, max_length=128)


class SessionLockResponse(BaseModel):
    session_id: str
    expires_at: datetime
    ttl_seconds: int = 60