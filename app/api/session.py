from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, Header, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db import get_db
from app.models import ActiveSessionLock
from app.schemas import (
    MessageResponse,
    SessionAcquireRequest,
    SessionLockResponse,
    SessionReleaseRequest,
)

router = APIRouter(prefix="/session", tags=["session"])

LOCK_NAME = "global"
LOCK_TTL_SECONDS = 60


@router.post("/acquire", response_model=SessionLockResponse)
def acquire_session_lock(payload: SessionAcquireRequest, db: Session = Depends(get_db)) -> SessionLockResponse:
    now = datetime.now(timezone.utc)
    lock = db.execute(
        select(ActiveSessionLock).where(ActiveSessionLock.lock_name == LOCK_NAME)
    ).scalar_one_or_none()

    if lock is None:
        lock = ActiveSessionLock(
            lock_name=LOCK_NAME,
            session_id=payload.session_id,
            expires_at=now + timedelta(seconds=LOCK_TTL_SECONDS),
        )
        db.add(lock)
    elif lock.expires_at <= now or lock.session_id == payload.session_id:
        lock.session_id = payload.session_id
        lock.expires_at = now + timedelta(seconds=LOCK_TTL_SECONDS)
    else:
        raise HTTPException(status_code=423, detail="Another user is already active")

    db.commit()
    db.refresh(lock)

    return SessionLockResponse(session_id=lock.session_id, expires_at=lock.expires_at)


@router.post("/release", response_model=MessageResponse)
def release_session_lock(
    payload: SessionReleaseRequest | None = None,
    x_session_id: str | None = Header(default=None, alias="X-Session-Id"),
    db: Session = Depends(get_db),
) -> MessageResponse:
    session_id = (payload.session_id if payload else None) or x_session_id
    if not session_id:
        raise HTTPException(status_code=400, detail="session_id is required")

    lock = db.execute(
        select(ActiveSessionLock).where(ActiveSessionLock.lock_name == LOCK_NAME)
    ).scalar_one_or_none()

    if lock is not None and lock.session_id == session_id:
        db.delete(lock)
        db.commit()

    return MessageResponse(message="Session lock released")
