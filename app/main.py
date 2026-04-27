from datetime import datetime, timedelta, timezone

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy import select

from app.api.catalog import router as catalog_router
from app.api.reports import router as reports_router
from app.api.session import LOCK_NAME, LOCK_TTL_SECONDS, router as session_router
from app.api.sync import router as sync_router
from app.db import Base, SessionLocal, engine
from app.models import ActiveSessionLock
from app.schemas import HealthResponse

app = FastAPI(title="Zinventory", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",
        "http://127.0.0.1:3000",
        "http://zinventory.home",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
def on_startup() -> None:
    Base.metadata.create_all(bind=engine)


@app.middleware("http")
async def enforce_single_active_session(request: Request, call_next):
    path = request.url.path

    excluded_prefixes = ("/health", "/session", "/docs", "/redoc", "/openapi.json")
    if request.method == "OPTIONS" or path.startswith(excluded_prefixes):
        return await call_next(request)

    session_id = request.headers.get("X-Session-Id")
    if not session_id:
        return JSONResponse(
            status_code=428,
            content={"detail": "Missing X-Session-Id header"},
        )

    now = datetime.now(timezone.utc)
    with SessionLocal() as db:
        lock = db.execute(
            select(ActiveSessionLock).where(ActiveSessionLock.lock_name == LOCK_NAME)
        ).scalar_one_or_none()

        if lock is not None and lock.expires_at > now and lock.session_id != session_id:
            return JSONResponse(
                status_code=423,
                content={"detail": "Another user is already active"},
            )

        if lock is not None and lock.session_id == session_id:
            lock.expires_at = now + timedelta(seconds=LOCK_TTL_SECONDS)
            db.commit()

    return await call_next(request)


@app.get("/health", response_model=HealthResponse, tags=["system"])
def health() -> HealthResponse:
    return HealthResponse()


app.include_router(reports_router)
app.include_router(catalog_router)
app.include_router(sync_router)
app.include_router(session_router)