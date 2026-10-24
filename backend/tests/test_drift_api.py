"""Baselines and drift checks through the API, against the fake lab."""

import pytest

from app.db.models import Device, DeviceCollection, DriftCheck, NetworkCollection
from app.engine import collector
from tests.lab import HOSTS, fake_lab


@pytest.fixture
def devices(session):
    rows = {
        name: Device(mac=f"52:54:00:00:00:0{index}", last_ip=host, device_type="network device")
        for index, (name, host) in enumerate(HOSTS.items(), start=1)
    }
    session.add_all(rows.values())
    session.commit()
    return rows


def collect(client, lab):
    run_id = client.post("/collections").json()["id"]
    assert client.get(f"/collections/{run_id}").json()["status"] == "completed"
    return run_id


def break_ospf(lab):
    """R1 and R2 lose their adjacency, and the routes learned over it."""
    for name in ("R1", "R2"):
        lab[name].outputs["show ip ospf neighbor"] = ""
        routes = collector.collect_device(lab[name]).data["routes"]
        lab[name].outputs["show ip route"] = [r for r in routes if r["protocol"] != "O"]


# --- baseline ------------------------------------------------------------------


def test_baseline_can_be_any_finished_collection_and_keeps_its_history(client, devices):
    assert client.get("/baseline").status_code == 404
    with fake_lab() as lab:
        first, second = collect(client, lab), collect(client, lab)

    set_second = client.put("/baseline", json={"collection_id": second, "note": "  Healthy  "})
    assert set_second.status_code == 200
    body = set_second.json()
    assert (body["collection_id"], body["note"]) == (second, "Healthy")
    assert [(d["name"], d["status"]) for d in body["devices"]] == [("R1", "success"), ("R2", "success"), ("SW1", "success"), ("SW2", "success")]

    # An older collection can be chosen too, and re-baselining keeps the history.
    client.put("/baseline", json={"collection_id": first})
    assert client.get("/baseline").json()["collection_id"] == first
    history = client.get("/baselines").json()
    assert [(b["collection_id"], b["note"]) for b in history] == [(first, None), (second, "Healthy")]


def test_baseline_must_be_a_finished_collection_that_reached_a_device(client, session, devices):
    assert client.put("/baseline", json={"collection_id": 999}).status_code == 404

    running = NetworkCollection(status=NetworkCollection.STATUS_RUNNING)
    session.add(running)
    session.commit()
    response = client.put("/baseline", json={"collection_id": running.id})
    assert (response.status_code, response.json()["detail"]) == (400, f"Collection {running.id} is still running.")

    empty = NetworkCollection(status=NetworkCollection.STATUS_COMPLETED)
    empty.results = [DeviceCollection(host="192.168.17.3", status=DeviceCollection.STATUS_FAILED, error="Timeout")]
    session.add(empty)
    session.commit()
    response = client.put("/baseline", json={"collection_id": empty.id})
    assert response.status_code == 400
    assert "reached no device" in response.json()["detail"]
    assert client.get("/baseline").status_code == 404


# --- drift checks ----------------------------------------------------------------


def test_drift_check_collects_compares_and_explains(client, devices):
    with fake_lab() as lab:
        baseline = collect(client, lab)
        client.put("/baseline", json={"collection_id": baseline})
        break_ospf(lab)

        started = client.post("/drift-checks")

    assert started.status_code == 202
    check = started.json()
    assert (check["status"], check["baseline_collection_id"], check["report"]) == ("running", baseline, None)

    done = client.get(f"/drift-checks/{check['id']}").json()
    assert done["status"] == "completed"
    assert done["collection_id"] != baseline
    report = done["report"]
    assert report["summary"]["critical"] == 4
    messages = [f["message"] for f in report["findings"]]
    assert "R1 lost OSPF neighbor R2 (10.0.12.2) on Gi0/2." in messages
    assert "R2 lost OSPF neighbor R1 (10.0.12.1) on Gi0/1." in messages
    routes = next(f for f in report["findings"] if f["message"].startswith("R1 lost 2 routes"))
    assert [c for c in routes["caused_by"]] == [next(f["id"] for f in report["findings"] if f["message"].startswith("R1 lost OSPF"))]
    assert report["highlight"]["links"] == ["dev:r1|Gi0/2--dev:r2|Gi0/1"]
    assert [(c["id"], c["summary"]["critical"]) for c in client.get("/drift-checks").json()] == [(check["id"], 4)]


def test_a_healthy_network_has_no_drift(client, devices):
    with fake_lab() as lab:
        client.put("/baseline", json={"collection_id": collect(client, lab)})
        check_id = client.post("/drift-checks").json()["id"]

    report = client.get(f"/drift-checks/{check_id}").json()["report"]
    assert report["findings"] == []
    assert {d["status"] for d in report["devices"]} == {"unchanged"}


def test_an_existing_collection_can_be_compared_without_contacting_devices(client, devices):
    with fake_lab() as lab:
        baseline = collect(client, lab)
        lab["SW2"].outputs["show vlan brief"] = lab["SW2"].outputs["show vlan brief"].replace("Et0/3", "     ")
        later = collect(client, lab)
        client.put("/baseline", json={"collection_id": baseline})
        logins = len(lab.logins)

        response = client.post("/drift-checks", json={"collection_id": later})

        assert len(lab.logins) == logins  # nothing was collected
    assert response.status_code == 201
    body = response.json()
    assert (body["status"], body["collection_id"]) == ("completed", later)
    assert body["report"]["findings"][0]["message"] == "SW2 Et0/3 is no longer an access port in VLAN 20 (USERS)."


def test_unreachable_device_in_a_drift_check(client, devices):
    with fake_lab() as lab:
        client.put("/baseline", json={"collection_id": collect(client, lab)})
        lab.fail("SW2", collector.DeviceTimeoutError("Timeout: 192.168.17.11 did not answer on TCP port 22 within 10s."))
        check_id = client.post("/drift-checks").json()["id"]

    report = client.get(f"/drift-checks/{check_id}").json()["report"]
    critical = [f["message"] for f in report["findings"] if f["severity"] == "critical"]
    assert critical == ["SW2 (192.168.17.11) could not be collected from: Timeout: 192.168.17.11 did not answer on TCP port 22 within 10s."]
    assert next(d for d in report["devices"] if d["name"] == "SW2")["status"] == "unreachable"


def test_drift_check_errors(client, session, devices):
    with fake_lab() as lab:
        response = client.post("/drift-checks")
        assert (response.status_code, response.json()["detail"]) == (409, "Set a baseline first: a collection taken while the network was healthy.")
        assert client.post("/drift-checks", json={"collection_id": 1}).status_code == 409

        client.put("/baseline", json={"collection_id": collect(client, lab)})
        assert client.post("/drift-checks", json={"collection_id": 999}).status_code == 404

        session.add(NetworkCollection(status=NetworkCollection.STATUS_RUNNING))
        session.commit()
        busy = client.post("/drift-checks")
        assert (busy.status_code, "still running" in busy.json()["detail"]) == (409, True)
    assert client.get("/drift-checks/999").status_code == 404


def test_drift_checks_cut_off_by_a_crash_are_closed_at_startup(session, devices):
    from app.services import drift_service

    with fake_lab():
        run = NetworkCollection(status=NetworkCollection.STATUS_COMPLETED)
        run.results = [DeviceCollection(host="192.168.17.3", status=DeviceCollection.STATUS_SUCCESS, data={})]
        session.add(run)
        session.commit()
        baseline = drift_service.set_baseline(session, run.id)
        session.add(DriftCheck(baseline=baseline, network_collection=run))
        session.commit()

    assert drift_service.fail_interrupted_drift_checks(session) == 1
    check = session.query(DriftCheck).one()
    assert (check.status, check.finished_at is not None) == ("failed", True)
