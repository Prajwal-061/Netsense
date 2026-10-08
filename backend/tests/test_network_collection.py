"""Collecting from every network device: the service and the /collections API."""

import threading
import time
from ipaddress import IPv4Network

import pytest
from sqlalchemy import select

from app.core.credentials import Credentials
from app.db.models import ConfigBackup, Device, DeviceCollection, NetworkCollection
from app.engine import collector
from app.services import collection_service
from tests.lab import HOSTS, fake_lab
from tests.sample_configs import NEW_VLAN

ALLOWED = [IPv4Network("192.168.17.0/24")]
LAB_CREDENTIALS = Credentials("test-user", "test-password")


def lab_credentials(host):
    return LAB_CREDENTIALS


@pytest.fixture
def devices(session):
    """The lab as a scan would have left it: four network devices and a Linux host."""
    rows = {
        name: Device(mac=f"52:54:00:00:00:0{index}", last_ip=host, device_type="network device")
        for index, (name, host) in enumerate(HOSTS.items(), start=1)
    }
    rows["alpine"] = Device(mac="52:54:00:68:dd:64", last_ip="192.168.17.129", device_type="Linux/Unix host")
    session.add_all(rows.values())
    session.commit()
    return rows


def run_collection(session, **kwargs):
    run = collection_service.start_network_collection(session, ALLOWED)
    collection_service.run_network_collection(session, run, lab_credentials, **kwargs)
    return run


def by_host(run):
    return {row.host: row for row in run.results}


# --- inventory -------------------------------------------------------------


def test_inventory_is_routers_switches_and_likely_network_devices_by_management_ip(session, devices):
    devices["R1"].device_type = "router"
    devices["SW1"].device_type = "switch"
    session.commit()

    inventory = collection_service.network_inventory(session, ALLOWED)

    # Ordered by IP; the Linux host is not a network device.
    assert [device.last_ip for device in inventory] == [
        "192.168.17.3",
        "192.168.17.4",
        "192.168.17.10",
        "192.168.17.11",
    ]


def test_inventory_skips_addresses_outside_the_allowed_subnets_and_stale_duplicates(session, devices):
    session.add(Device(mac="00:1b:54:00:00:01", last_ip="10.9.9.9", device_type="router"))
    # An older device row that used to have SW1's address.
    old = Device(mac="aa:bb:cc:00:00:99", last_ip=HOSTS["SW1"], device_type="switch")
    old.last_seen = devices["SW1"].last_seen.replace(year=2020)
    session.add(old)
    session.commit()

    inventory = collection_service.network_inventory(session, ALLOWED)

    assert "10.9.9.9" not in [device.last_ip for device in inventory]
    assert [device.id for device in inventory if device.last_ip == HOSTS["SW1"]] == [devices["SW1"].id]


# --- a run -----------------------------------------------------------------


def test_run_collects_from_every_device_and_confirms_each_type(session, devices):
    with fake_lab() as lab:
        run = run_collection(session)

    assert run.status == NetworkCollection.STATUS_COMPLETED
    assert run.started_at <= run.finished_at
    results = by_host(run)
    assert {row.status for row in results.values()} == {DeviceCollection.STATUS_SUCCESS}
    assert set(results[HOSTS["R1"]].data) >= {"routes", "ospf_neighbors", "ospf_interfaces", "arp"}
    assert set(results[HOSTS["SW1"]].data) >= {"vlans", "trunks", "spanning_tree", "mac_table"}
    assert "routes" not in results[HOSTS["SW1"]].data
    assert {name: devices[name].device_type for name in HOSTS} == {
        "R1": "router",
        "R2": "router",
        "SW1": "switch",
        "SW2": "switch",
    }
    assert all(devices[name].type_source == Device.TYPE_FROM_COLLECTION for name in HOSTS)
    assert "legacy SSH" in results[HOSTS["R2"]].note and results[HOSTS["SW2"]].note is None
    # One config backup per device, linked from its result.
    assert session.query(ConfigBackup).count() == 4
    assert all(row.config_backup_id and row.config_changed is False for row in results.values())
    assert sorted(host for host, _, _ in lab.logins) == sorted(HOSTS.values())
    assert all(device.disconnected == 1 for device in lab.devices.values())


def test_one_failed_device_does_not_stop_the_others(session, devices):
    with fake_lab() as lab:
        lab.fail("R2", collector.DeviceAuthenticationError("Authentication failed: 192.168.17.4 rejected the login."))
        lab.fail("SW2", collector.DeviceTimeoutError("Timeout: 192.168.17.11 did not answer on TCP port 22."))
        lab["SW1"].outputs["show spanning-tree"] = RuntimeError("unexpected reply")
        run = run_collection(session)

    results = by_host(run)
    assert run.status == NetworkCollection.STATUS_COMPLETED
    assert results[HOSTS["R1"]].status == DeviceCollection.STATUS_SUCCESS
    assert results[HOSTS["R1"]].data["routes"]
    assert (results[HOSTS["R2"]].status, results[HOSTS["R2"]].error) == (
        DeviceCollection.STATUS_FAILED,
        "Authentication failed: 192.168.17.4 rejected the login.",
    )
    assert "did not answer" in results[HOSTS["SW2"]].error
    # A bug or surprise on one device is caught and recorded like any failure.
    assert results[HOSTS["SW1"]].error == "Unexpected error: RuntimeError: unexpected reply"
    assert results[HOSTS["SW1"]].data == {}
    # Failed devices keep the scan's guess; the one that answered is confirmed.
    assert devices["R1"].device_type == "router"
    assert {devices[name].device_type for name in ("R2", "SW1", "SW2")} == {"network device"}
    assert session.query(ConfigBackup).count() == 1


def test_devices_are_collected_in_parallel_up_to_the_limit(session, devices):
    active, peak, lock = 0, 0, threading.Lock()

    with fake_lab() as lab:
        real_connect = lab.connect

        def slow_connect(host, username, password, port=22, timeout=10):
            nonlocal active, peak
            with lock:
                active += 1
                peak = max(peak, active)
            time.sleep(0.15)  # stands in for the SSH login
            with lock:
                active -= 1
            return real_connect(host, username, password)

        lab.connect_mock.side_effect = slow_connect
        started = time.monotonic()
        run = run_collection(session, max_workers=2)
        elapsed = time.monotonic() - started

    assert peak == 2  # never more than the limit, but really concurrent
    assert elapsed < 0.15 * 4  # faster than one device after another
    assert {row.status for row in run.results} == {DeviceCollection.STATUS_SUCCESS}


def test_a_slow_device_does_not_delay_the_results_of_the_fast_ones(session, devices):
    finished = []
    release = threading.Event()

    with fake_lab() as lab:
        real_connect = lab.connect

        def connect(host, username, password, port=22, timeout=10):
            if host == HOSTS["R1"]:
                release.wait(5)  # R1 hangs until the others have been saved
            return real_connect(host, username, password)

        lab.connect_mock.side_effect = connect
        real_record = collection_service.record_success

        def record(session_, row, outcome):
            result = real_record(session_, row, outcome)
            finished.append(row.host)
            if len(finished) == 3:
                release.set()
            return result

        with pytest.MonkeyPatch.context() as patcher:
            patcher.setattr(collection_service, "record_success", record)
            run_collection(session)

    assert finished[-1] == HOSTS["R1"]
    assert sorted(finished[:3]) == sorted([HOSTS["R2"], HOSTS["SW1"], HOSTS["SW2"]])


def test_each_device_is_asked_for_its_own_credentials(session, devices):
    def per_device(host):
        return Credentials(f"user-for-{host}", f"password-for-{host}")

    with fake_lab() as lab:
        run = collection_service.start_network_collection(session, ALLOWED)
        collection_service.run_network_collection(session, run, per_device)

    assert sorted(lab.logins) == sorted(
        (host, f"user-for-{host}", f"password-for-{host}") for host in HOSTS.values()
    )


def test_credentials_do_not_show_their_password():
    assert "s3cret" not in repr(Credentials("admin", "s3cret"))


def test_second_run_reports_which_configs_changed(session, devices):
    with fake_lab() as lab:
        run_collection(session)
        lab["SW2"].outputs["show running-config"] = NEW_VLAN
        second = run_collection(session)

    changed = {row.host: row.config_changed for row in second.results}
    assert changed == {HOSTS["R1"]: False, HOSTS["R2"]: False, HOSTS["SW1"]: False, HOSTS["SW2"]: True}
    assert session.query(ConfigBackup).count() == 5
    assert session.query(NetworkCollection).count() == 2


def test_only_one_collection_runs_at_a_time(session, devices):
    collection_service.start_network_collection(session, ALLOWED)

    with pytest.raises(collection_service.CollectionInProgressError, match="still running"):
        collection_service.start_network_collection(session, ALLOWED)

    assert session.query(NetworkCollection).count() == 1


def test_collection_needs_at_least_one_network_device(session):
    session.add(Device(mac="52:54:00:68:dd:64", last_ip="192.168.17.129", device_type="Linux/Unix host"))
    session.commit()

    with pytest.raises(collection_service.NoNetworkDevicesError, match="Run a scan first"):
        collection_service.start_network_collection(session, ALLOWED)

    assert session.query(NetworkCollection).count() == 0


def test_runs_cut_off_by_a_crash_are_closed_at_startup(session, devices):
    run = collection_service.start_network_collection(session, ALLOWED)

    assert collection_service.fail_interrupted_collections(session) == 1

    assert run.status == NetworkCollection.STATUS_FAILED
    assert run.finished_at is not None
    assert {row.status for row in run.results} == {DeviceCollection.STATUS_FAILED}
    assert "stopped before this device was reached" in run.results[0].error
    # And a new run can start.
    assert collection_service.start_network_collection(session, ALLOWED).id != run.id


# --- API -------------------------------------------------------------------


def test_post_collections_returns_pending_results_then_runs_in_the_background(client, devices):
    with fake_lab():
        response = client.post("/collections")

    assert response.status_code == 202
    started = response.json()
    assert started["status"] == "running"
    assert (started["device_count"], started["pending"], started["succeeded"]) == (4, 4, 0)
    assert [r["host"] for r in started["results"]] == ["192.168.17.3", "192.168.17.4", "192.168.17.10", "192.168.17.11"]
    assert {r["status"] for r in started["results"]} == {"pending"}

    # The test client finishes background work before returning.
    finished = client.get(f"/collections/{started['id']}").json()
    assert finished["status"] == "completed"
    assert (finished["succeeded"], finished["failed"], finished["pending"]) == (4, 0, 0)
    results = {r["host"]: r for r in finished["results"]}
    r1, sw1 = results["192.168.17.3"], results["192.168.17.10"]
    assert (r1["hostname"], r1["device_type"], r1["status"]) == ("R1", "router", "success")
    assert (sw1["hostname"], sw1["device_type"]) == ("SW1", "switch")
    assert r1["collected"]["routes"] == 10 and "vlans" not in r1["collected"]
    assert sw1["collected"]["trunks"] == 3 and "routes" not in sw1["collected"]
    assert "legacy SSH" in r1["note"]
    assert sw1["config_changed"] is False
    assert "test-password" not in str(finished)


def test_collection_results_record_each_failure(client, devices):
    with fake_lab() as lab:
        lab.fail("R2", collector.DeviceSshError("SSH negotiation failed: 192.168.17.4 and this client have no key exchange or host key algorithm in common."))
        run_id = client.post("/collections").json()["id"]

    body = client.get(f"/collections/{run_id}").json()

    assert body["status"] == "completed"
    assert (body["succeeded"], body["failed"]) == (3, 1)
    r2 = next(r for r in body["results"] if r["host"] == "192.168.17.4")
    assert r2["status"] == "failed"
    assert r2["error"].startswith("SSH negotiation failed")
    assert (r2["hostname"], r2["collected"], r2["device_type"]) == (None, {}, "network device")
    summary = client.get("/collections").json()
    assert [(s["id"], s["succeeded"], s["failed"]) for s in summary] == [(run_id, 3, 1)]


def test_collections_list_newest_first_and_unknown_is_404(client, devices):
    with fake_lab():
        first = client.post("/collections").json()["id"]
        second = client.post("/collections").json()["id"]

    assert [s["id"] for s in client.get("/collections").json()] == [second, first]
    assert [s["id"] for s in client.get("/collections", params={"limit": 1}).json()] == [second]
    assert client.get("/collections/999").status_code == 404


def test_second_collection_is_refused_while_one_is_running(client, session, devices):
    session.add(NetworkCollection(status=NetworkCollection.STATUS_RUNNING))
    session.commit()

    with fake_lab() as lab:
        response = client.post("/collections")

    assert response.status_code == 409
    assert "still running" in response.json()["detail"]
    assert lab.logins == []
    assert client.get("/health").json()["collection_running"] is True


def test_collection_with_no_network_devices_is_404(client):
    with fake_lab() as lab:
        response = client.post("/collections")

    assert response.status_code == 404
    assert "Run a scan first" in response.json()["detail"]
    assert lab.logins == []


def test_collection_never_logs_in_outside_the_allowed_subnets(client, session, devices):
    session.add(Device(mac="00:1b:54:00:00:01", last_ip="192.168.44.5", device_type="router"))
    session.commit()

    with fake_lab() as lab:
        body = client.post("/collections").json()

    assert "192.168.44.5" not in [r["host"] for r in body["results"]]
    assert "192.168.44.5" not in [host for host, _, _ in lab.logins]


def test_latest_data_endpoints_for_a_router(client, devices):
    with fake_lab():
        client.post("/collections")
    r1 = devices["R1"].id

    def data(name):
        response = client.get(f"/devices/{r1}/{name}")
        assert response.status_code == 200, (name, response.text)
        assert response.json()["collected_at"]
        return response.json()["data"]

    assert data("ospf-neighbors")[0]["neighbor_id"] == "2.2.2.2"
    assert {row["interface"] for row in data("ospf-interfaces")} >= {"Gi0/2"}
    assert any(route["protocol"] == "O" for route in data("routes"))
    assert {row["neighbor_name"].split(".")[0] for row in data("cdp-neighbors")} == {"SW1", "R2"}
    assert any(row["ip_address"] == "10.0.12.2" for row in data("arp"))
    assert len(data("interfaces")) == 6
    # Switch-only data does not exist for a router.
    for name in ("trunks", "spanning-tree", "vlans", "mac-table"):
        response = client.get(f"/devices/{r1}/{name}")
        assert response.status_code == 404
        assert "not collected from a router" in response.json()["detail"]


def test_latest_data_endpoints_for_a_switch(client, devices):
    with fake_lab():
        client.post("/collections")
    sw2 = devices["SW2"].id

    trunks = client.get(f"/devices/{sw2}/trunks").json()["data"]
    assert [(t["interface"], t["forwarding_vlans"]) for t in trunks] == [("Et0/1", "20,30"), ("Et0/2", "none")]
    stp = client.get(f"/devices/{sw2}/spanning-tree").json()["data"]
    assert {"Root", "Altn"} <= {row["role"] for row in stp}
    assert client.get(f"/devices/{sw2}/cdp-neighbors").json()["data"]
    assert client.get(f"/devices/{sw2}/arp").json()["data"]
    for name in ("routes", "ospf-neighbors", "ospf-interfaces"):
        assert client.get(f"/devices/{sw2}/{name}").status_code == 404


def test_latest_data_survives_a_later_failed_collection(client, devices):
    with fake_lab() as lab:
        client.post("/collections")
        lab.fail("R1", collector.DeviceTimeoutError("Timeout: no answer."))
        client.post("/collections")

    response = client.get(f"/devices/{devices['R1'].id}/routes")

    assert response.status_code == 200
    assert len(response.json()["data"]) == 10
