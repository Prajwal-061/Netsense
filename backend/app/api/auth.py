"""Login, logout and "who am I" routes, and the dependency that protects the rest."""

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.api.deps import get_session
from app.api.schemas import UTCDatetime
from app.core.config import Settings, get_settings
from app.db.models import AuthSession
from app.services import auth_service

COOKIE_NAME = "netsense_session"

router = APIRouter(prefix="/auth", tags=["auth"])


class LoginRequest(BaseModel):
    username: str = Field(max_length=64)
    password: str = Field(max_length=1024)


class Me(BaseModel):
    username: str
    expires_at: UTCDatetime


def require_admin(request: Request, session: Session = Depends(get_session)) -> AuthSession:
    """Dependency on every protected route: a valid session cookie, or 401."""
    row = auth_service.session_for_token(session, request.cookies.get(COOKIE_NAME))
    if row is None:
        detail = "Your session has expired. Log in again." if request.cookies.get(COOKIE_NAME) else "Not logged in."
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail)
    return row


def _set_cookie(response: Response, token: str, settings: Settings) -> None:
    response.set_cookie(
        COOKIE_NAME,
        token,
        max_age=settings.session_hours * 3600,
        httponly=True,  # JavaScript cannot read it
        samesite="strict",  # never sent with requests started by another site
        secure=settings.session_cookie_secure,  # HTTPS only, once NetSense has HTTPS
        path="/",
    )


@router.post("/login", response_model=Me)
def login(
    body: LoginRequest,
    request: Request,
    response: Response,
    session: Session = Depends(get_session),
    settings: Settings = Depends(get_settings),
):
    """Log in as the admin. Sets an HttpOnly session cookie.

    After 5 failed attempts from one address in 15 minutes, further attempts
    are refused with 429 until the oldest of them is 15 minutes old.
    """
    client = request.client.host if request.client else "unknown"
    wait = auth_service.login_limiter.retry_after(client)
    if wait:
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS,
            f"Too many failed logins. Try again in {(wait + 59) // 60} minute(s).",
            headers={"Retry-After": str(wait)},
        )
    user = auth_service.authenticate(session, body.username, body.password)
    if user is None:
        auth_service.login_limiter.failed(client)
        if not auth_service.admin_exists(session):
            raise HTTPException(
                status.HTTP_401_UNAUTHORIZED,
                "No admin account exists yet. Create one with backend/scripts/create_admin.py.",
            )
        # The same message for a wrong username and a wrong password.
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Wrong username or password.")
    auth_service.login_limiter.succeeded(client)
    token, row = auth_service.create_session(session, user, settings.session_hours)
    _set_cookie(response, token, settings)
    return Me(username=user.username, expires_at=row.expires_at)


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
def logout(request: Request, response: Response, session: Session = Depends(get_session)):
    """End this browser's session. Works (and does nothing) when not logged in."""
    auth_service.end_session(session, request.cookies.get(COOKIE_NAME))
    response.delete_cookie(COOKIE_NAME, path="/")


@router.get("/me", response_model=Me)
def me(current: AuthSession = Depends(require_admin)):
    """Who is logged in, and until when. 401 when not logged in."""
    return Me(username=current.user.username, expires_at=current.expires_at)
