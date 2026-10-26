"""Authentication: one admin user, password hashing, sessions, login rate limit.

Design:
  - Passwords are hashed with argon2id (argon2-cffi). It is memory-hard: each
    guess costs 64 MiB of RAM, which makes cracking on GPUs expensive, and it
    has no 72-byte password limit as bcrypt has.
  - A login creates a random session token. The browser keeps it in an
    HttpOnly cookie (JavaScript cannot read it, so an XSS bug cannot steal
    it); the database keeps only its SHA-256, so a copied database holds no
    usable sessions. Logout deletes the row, which ends the session at once,
    something a JWT cannot do before it expires.
"""

import hashlib
import secrets
import threading
import time
from collections import deque
from datetime import datetime, timedelta

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.db.models import AdminUser, AuthSession, utcnow

MIN_PASSWORD_LENGTH = 10

_hasher = PasswordHasher()  # argon2id, 64 MiB, 3 passes, 4 lanes (RFC 9106 defaults)
# Checked when the username is wrong, so that a wrong username takes as long
# as a wrong password and response times do not reveal which one it was.
_DUMMY_HASH = _hasher.hash(secrets.token_hex(16))


class PasswordTooWeakError(ValueError):
    pass


def _token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def set_admin_password(session: Session, username: str, password: str) -> AdminUser:
    """Create the admin, or replace the password of an existing one.

    Changing the password logs out every browser that was logged in.
    """
    if len(password) < MIN_PASSWORD_LENGTH:
        raise PasswordTooWeakError(f"The password must be at least {MIN_PASSWORD_LENGTH} characters.")
    user = session.scalars(select(AdminUser).where(AdminUser.username == username)).first()
    if user is None:
        user = AdminUser(username=username, password_hash=_hasher.hash(password))
        session.add(user)
    else:
        user.password_hash = _hasher.hash(password)
        session.execute(delete(AuthSession).where(AuthSession.user_id == user.id))
    session.commit()
    return user


def authenticate(session: Session, username: str, password: str) -> AdminUser | None:
    """The user, if the username and password are right."""
    user = session.scalars(select(AdminUser).where(AdminUser.username == username)).first()
    try:
        _hasher.verify(user.password_hash if user else _DUMMY_HASH, password)
    except (VerificationError, InvalidHashError):
        return None
    return user


def create_session(session: Session, user: AdminUser, hours: int) -> tuple[str, AuthSession]:
    """Start a session. Returns the token for the cookie, and the stored row."""
    session.execute(delete(AuthSession).where(AuthSession.expires_at < utcnow()))
    token = secrets.token_urlsafe(32)  # 256 random bits
    row = AuthSession(user=user, token_hash=_token_hash(token), expires_at=utcnow() + timedelta(hours=hours))
    session.add(row)
    session.commit()
    return token, row


def session_for_token(session: Session, token: str | None) -> AuthSession | None:
    """The live session for a cookie's token, or None if unknown or expired."""
    if not token:
        return None
    row = session.scalars(select(AuthSession).where(AuthSession.token_hash == _token_hash(token))).first()
    if row is None or row.expires_at <= utcnow():
        return None
    return row


def end_session(session: Session, token: str | None) -> None:
    if token:
        session.execute(delete(AuthSession).where(AuthSession.token_hash == _token_hash(token)))
        session.commit()


def admin_exists(session: Session) -> bool:
    return session.scalars(select(AdminUser.id).limit(1)).first() is not None


class LoginRateLimiter:
    """At most `limit` failed logins per client address in `window` seconds.

    Kept in memory: it resets when the API restarts, and it covers one
    process (NetSense runs a single uvicorn worker). Enough to make guessing
    a password over the network impractical: 5 tries per 15 minutes.
    """

    def __init__(self, limit: int = 5, window: float = 15 * 60, clock=time.monotonic):
        self.limit, self.window, self.clock = limit, window, clock
        self._failures: dict[str, deque[float]] = {}
        self._lock = threading.Lock()

    def _recent(self, key: str) -> deque[float]:
        failures = self._failures.setdefault(key, deque())
        while failures and failures[0] <= self.clock() - self.window:
            failures.popleft()
        return failures

    def retry_after(self, key: str) -> int:
        """Seconds until this client may try again; 0 if it may try now."""
        with self._lock:
            failures = self._recent(key)
            if len(failures) < self.limit:
                return 0
            return max(1, int(failures[0] + self.window - self.clock()) + 1)

    def failed(self, key: str) -> None:
        with self._lock:
            self._recent(key).append(self.clock())

    def succeeded(self, key: str) -> None:
        with self._lock:
            self._failures.pop(key, None)


login_limiter = LoginRateLimiter()


def expires_in(expires_at: datetime) -> int:
    return max(0, int((expires_at - utcnow()).total_seconds()))
