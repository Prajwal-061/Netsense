"""Timestamps leave the API as UTC with a "Z", so browsers never read them as local time.

A timestamp without a timezone ("2026-10-26T19:57:20") is read by JavaScript
as the browser's own local time: in UTC+05:30 a scan from a minute ago would
show as "in 5 hours".
"""

import re
from datetime import datetime, timedelta, timezone

from pydantic import BaseModel
from sqlalchemy import text

from app.api.schemas import UTCDatetime
from app.db.models import Scan
from tests.test_api import HOST_PC, SWITCH, scan

ISO = re.compile(r"^\d{4}-\d\d-\d\d[T ]\d\d:\d\d")
ZONED = re.compile(r"(Z|[+-]\d\d:\d\d)$")


class Stamp(BaseModel):
    at: UTCDatetime


def timestamps(value, where=""):
    """Every (path, string) in a JSON value that looks like a date and time."""
    if isinstance(value, dict):
        for key, item in value.items():
            yield from timestamps(item, f"{where}.{key}")
    elif isinstance(value, list):
        for item in value:
            yield from timestamps(item, f"{where}[]")
    elif isinstance(value, str) and ISO.match(value):
        yield where, value


def test_a_naive_datetime_is_taken_as_utc_and_written_with_z():
    assert Stamp(at=datetime(2026, 10, 26, 19, 57, 20)).model_dump_json() == '{"at":"2026-10-26T19:57:20Z"}'


def test_a_datetime_in_another_zone_is_converted_to_utc():
    india = timezone(timedelta(hours=5, minutes=30))
    stamp = Stamp(at=datetime(2026, 10, 27, 1, 27, 20, tzinfo=india))
    assert stamp.model_dump_json() == '{"at":"2026-10-26T19:57:20Z"}'


def test_every_timestamp_in_api_responses_carries_a_timezone(client):
    scan(client, SWITCH, HOST_PC)
    scan_id = client.get("/scans").json()[0]["id"]
    device_id = client.get("/devices").json()[0]["id"]
    paths = ["/scans", f"/scans/{scan_id}", f"/scans/{scan_id}/progress", "/devices", f"/devices/{device_id}", "/auth/me"]

    found = []
    for path in paths:
        response = client.get(path)
        assert response.status_code == 200, path
        found += [(path + where, value) for where, value in timestamps(response.json())]

    assert len(found) > 10
    assert [item for item in found if not ZONED.search(item[1])] == []


def test_a_row_stored_without_a_timezone_comes_back_as_that_utc_instant(client, session):
    # As SQLite stores it: UTC, but with no timezone in the text.
    session.execute(
        text(
            "INSERT INTO scans (id, started_at, finished_at, subnet, status) "
            "VALUES (99, '2026-10-26 19:57:20.604724', '2026-10-26 19:57:47.522266', '192.168.17.0/24', 'completed')"
        )
    )
    session.commit()

    body = client.get("/scans/99").json()

    assert body["started_at"] == "2026-10-26T19:57:20.604724Z"
    assert datetime.fromisoformat(body["started_at"]) == datetime(2026, 10, 26, 19, 57, 20, 604724, tzinfo=timezone.utc)
    assert session.get(Scan, 99).started_at.tzinfo is not None
