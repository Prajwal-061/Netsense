"""Authentication: one admin, a session cookie, and every other route protected."""

import re
from datetime import timedelta

import pytest
from sqlalchemy.orm import Session

from app.api.auth import COOKIE_NAME
from app.db.models import AuthSession, Device, utcnow
from app.services import auth_service

PUBLIC = {"/health", "/auth/login", "/auth/logout", "/openapi.json", "/docs", "/docs/oauth2-redirect", "/redoc"}
PASSWORD = "correct horse battery"


@pytest.fixture
def admin(engine):
    with Session(engine) as session:
        auth_service.set_admin_password(session, "admin", PASSWORD)


def login(api, username="admin", password=PASSWORD):
    return api.post("/auth/login", json={"username": username, "password": password})


def protected_routes():
    """Every (method, path) the API serves except the public ones, from its OpenAPI description."""
    from app.main import app

    routes = [
        (method.upper(), re.sub(r"\{[^}]+\}", "1", path))
        for path, operations in app.openapi()["paths"].items()
        if path not in PUBLIC
        for method in operations
    ]
    assert len(routes) > 30  # guard: an empty list would make the tests below pass vacuously
    return routes


# --- protection ----------------------------------------------------------------


@pytest.mark.parametrize("method, path", sorted(protected_routes()))
def test_every_protected_route_rejects_requests_without_a_session(anon_client, method, path):
    response = anon_client.request(method, path, json={})

    assert response.status_code == 401, (method, path, response.text)
    assert response.json() == {"detail": "Not logged in."}


def test_public_routes_stay_open(anon_client):
    assert anon_client.get("/health").status_code == 200
    assert anon_client.post("/auth/logout").status_code == 204


def test_protected_routes_are_most_of_the_api():
    paths = {path for _, path in protected_routes()}
    assert {"/devices", "/scans", "/collections", "/topology", "/baseline", "/drift-checks", "/auth/me"} <= paths


# --- logging in -------------------------------------------------------------------


def test_wrong_password_and_wrong_username_give_the_same_answer(anon_client, admin):
    wrong_password = login(anon_client, password="not the password")
    wrong_user = login(anon_client, username="root")

    assert wrong_password.status_code == wrong_user.status_code == 401
    assert wrong_password.json() == wrong_user.json() == {"detail": "Wrong username or password."}
    assert COOKIE_NAME not in anon_client.cookies
    assert anon_client.get("/devices").status_code == 401


def test_login_before_an_admin_exists_says_how_to_create_one(anon_client):
    response = login(anon_client)

    assert response.status_code == 401
    assert "create_admin.py" in response.json()["detail"]


def test_right_password_sets_a_safe_cookie_and_opens_the_api(anon_client, admin, engine):
    response = login(anon_client)

    assert response.status_code == 200
    assert response.json()["username"] == "admin"
    cookie = response.headers["set-cookie"]
    assert cookie.startswith(f"{COOKIE_NAME}=")
    assert "HttpOnly" in cookie  # JavaScript cannot read it
    assert "SameSite=strict" in cookie  # other sites cannot make the browser send it
    assert "Path=/" in cookie and "Max-Age=28800" in cookie  # 8 hours
    assert "Secure" not in cookie  # the lab is plain HTTP; SESSION_COOKIE_SECURE turns it on

    with Session(engine) as session:
        session.add(Device(mac="aa:bb:cc:00:01:00", last_ip="192.168.17.10", device_type="switch"))
        session.commit()
    assert anon_client.get("/devices").status_code == 200
    assert anon_client.get("/auth/me").json()["username"] == "admin"


def test_only_a_hash_of_the_session_token_is_stored(anon_client, admin, engine):
    login(anon_client)
    token = anon_client.cookies[COOKIE_NAME]

    with Session(engine) as session:
        (row,) = session.query(AuthSession).all()
    assert row.token_hash != token
    assert len(token) >= 40 and len(row.token_hash) == 64


def test_logout_ends_the_session_on_the_server(anon_client, admin):
    login(anon_client)
    token = anon_client.cookies[COOKIE_NAME]

    assert anon_client.post("/auth/logout").status_code == 204

    assert anon_client.get("/auth/me").status_code == 401
    # Replaying the old cookie does not work either: the session is gone.
    anon_client.cookies.set(COOKIE_NAME, token)
    assert anon_client.get("/auth/me").json() == {"detail": "Your session has expired. Log in again."}


def test_an_expired_session_is_rejected(anon_client, admin, engine):
    login(anon_client)
    with Session(engine) as session:
        row = session.query(AuthSession).one()
        row.expires_at = utcnow() - timedelta(seconds=1)
        session.commit()

    response = anon_client.get("/devices")

    assert (response.status_code, response.json()["detail"]) == (401, "Your session has expired. Log in again.")


def test_a_made_up_cookie_is_rejected(anon_client, admin):
    anon_client.cookies.set(COOKIE_NAME, "guessed-token")

    assert anon_client.get("/devices").status_code == 401


# --- rate limit -------------------------------------------------------------------


def test_failed_logins_are_rate_limited_per_address(anon_client, admin):
    for _ in range(5):
        assert login(anon_client, password="wrong").status_code == 401

    blocked = login(anon_client)  # even the right password

    assert blocked.status_code == 429
    assert blocked.json()["detail"] == "Too many failed logins. Try again in 15 minute(s)."
    assert 0 < int(blocked.headers["retry-after"]) <= 15 * 60
    assert COOKIE_NAME not in anon_client.cookies


def test_rate_limit_window_passes_and_success_resets_it():
    now = [1000.0]
    limiter = auth_service.LoginRateLimiter(limit=3, window=60, clock=lambda: now[0])
    for _ in range(3):
        limiter.failed("10.0.0.1")
    assert limiter.retry_after("10.0.0.1") == 61
    assert limiter.retry_after("10.0.0.2") == 0  # per address

    now[0] += 61
    assert limiter.retry_after("10.0.0.1") == 0

    limiter.failed("10.0.0.1")
    limiter.succeeded("10.0.0.1")
    assert limiter._recent("10.0.0.1") == type(limiter._recent("10.0.0.1"))()


# --- the admin account ------------------------------------------------------------


def test_password_is_stored_as_an_argon2id_hash(engine):
    with Session(engine) as session:
        user = auth_service.set_admin_password(session, "admin", PASSWORD)
        assert user.password_hash.startswith("$argon2id$")
        assert PASSWORD not in user.password_hash


def test_short_passwords_are_refused(engine):
    with Session(engine) as session, pytest.raises(auth_service.PasswordTooWeakError):
        auth_service.set_admin_password(session, "admin", "short")


def test_changing_the_password_logs_everyone_out(anon_client, admin, engine):
    login(anon_client)

    with Session(engine) as session:
        auth_service.set_admin_password(session, "admin", "a brand new password")

    assert anon_client.get("/auth/me").status_code == 401
    assert login(anon_client).status_code == 401
    assert login(anon_client, password="a brand new password").status_code == 200


def test_create_admin_script(engine, monkeypatch, capsys):
    import scripts.create_admin as script

    monkeypatch.setattr(script, "create_db_engine", lambda: engine)

    def answers(*values):
        replies = iter(values)
        return lambda prompt: next(replies)

    assert script.main([], ask=answers("first password!", "different password")) == 1
    assert "different" in capsys.readouterr().err
    assert script.main([], ask=answers("short", "short")) == 1
    assert "at least 10" in capsys.readouterr().err
    assert script.main(["--username", "netadmin"], ask=answers(PASSWORD, PASSWORD)) == 0
    assert "Password set for netadmin" in capsys.readouterr().out
    assert script.main(["--username", "netadmin"], ask=answers("another password", "another password")) == 0
    assert "Password changed for netadmin" in capsys.readouterr().out
    with Session(engine) as session:
        assert auth_service.authenticate(session, "netadmin", "another password") is not None


# --- what the browser gets --------------------------------------------------------


def test_device_credentials_never_reach_the_browser(client, session):
    from tests.lab import HOSTS, fake_lab

    for index, (name, host) in enumerate(HOSTS.items(), start=1):
        session.add(Device(mac=f"52:54:00:00:00:0{index}", last_ip=host, device_type="network device"))
    session.commit()
    with fake_lab():
        run = client.post("/collections").json()["id"]
    client.put("/baseline", json={"collection_id": run})
    client.post("/drift-checks", json={"collection_id": run})

    paths = ["/devices", "/collections", f"/collections/{run}", "/topology", "/baseline", "/drift-checks", "/auth/me", "/openapi.json"]
    paths += [f"/devices/{d['id']}{suffix}" for d in client.get("/devices").json() for suffix in ("", "/configs")]
    for path in paths:
        text = client.get(path).text
        assert "test-password" not in text, path  # LAB_SWITCH_PASSWORD from tests/conftest.py
        assert "argon2" not in text and "token_hash" not in text, path


def test_cors_allows_credentials_only_for_the_dashboard_origin(client):
    preflight = {"Access-Control-Request-Method": "GET"}

    allowed = client.options("/devices", headers={"Origin": "http://localhost:5173", **preflight})
    other = client.options("/devices", headers={"Origin": "http://evil.example", **preflight})

    assert allowed.headers["access-control-allow-origin"] == "http://localhost:5173"
    assert allowed.headers["access-control-allow-credentials"] == "true"
    assert "access-control-allow-origin" not in other.headers


def test_default_cors_origin_is_only_the_lab_dashboard():
    from app.core.config import Settings

    assert Settings.model_fields["cors_origins"].default == ["http://192.168.17.132:5173"]
