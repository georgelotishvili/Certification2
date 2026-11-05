"""Google Authenticator enrollment and administrative session elevation."""
from fastapi import APIRouter, Depends, Header, Request, Response
from pydantic import BaseModel, Field, SecretStr
from sqlalchemy.orm import Session

from ..database import get_db
from ..rate_limiter import RateLimiter
from ..services import admin_mfa as service

router = APIRouter()
attempt_limiter = RateLimiter(max_requests=30, window_seconds=60)


class PasswordInput(BaseModel):
    password: SecretStr = Field(min_length=1, max_length=1024)


class CodeInput(BaseModel):
    code: str = Field(min_length=1, max_length=80)


def no_store(response: Response):
    response.headers.update(service.NO_STORE)


@router.get("/status", dependencies=[Depends(no_store)])
def status(authorization: str | None = Header(None), db: Session = Depends(get_db)):
    return service.mfa_status(db, authorization)


@router.post("/setup", dependencies=[Depends(no_store)])
def setup(payload: PasswordInput, request: Request, authorization: str | None = Header(None), db: Session = Depends(get_db)):
    attempt_limiter.check(request)
    return service.begin_setup(db, authorization, payload.password.get_secret_value())


@router.post("/confirm", dependencies=[Depends(no_store)])
def confirm(payload: CodeInput, request: Request, authorization: str | None = Header(None), db: Session = Depends(get_db)):
    attempt_limiter.check(request)
    return service.confirm_setup(db, authorization, payload.code)


@router.post("/verify", dependencies=[Depends(no_store)])
def verify(payload: CodeInput, request: Request, authorization: str | None = Header(None), db: Session = Depends(get_db)):
    attempt_limiter.check(request)
    return service.verify_mfa(db, authorization, payload.code)


@router.post("/recovery-codes", dependencies=[Depends(no_store)])
def recovery_codes(payload: PasswordInput, request: Request, authorization: str | None = Header(None), db: Session = Depends(get_db)):
    attempt_limiter.check(request)
    return service.regenerate_recovery_codes(db, authorization, payload.password.get_secret_value())


@router.post("/lock", dependencies=[Depends(no_store)])
def lock(authorization: str | None = Header(None), db: Session = Depends(get_db)):
    return service.lock_mfa(db, authorization)
