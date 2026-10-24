"""API tests: real routes and database (in-memory), fake network engine."""

from contextlib import contextmanager
from ipaddress import IPv4Network
from unittest.mock import MagicMock, patch

import pytest

from app.api.health import API_REVISION
from app.db.models import ConfigBackup, Device, Scan
from app.engine import collector, discovery, scanner
from tests.lab import LAB, fake_lab
from tests.sample_configs import BASE, NEW_SECRET, NEW_VLAN, SAME_LATER

LAB = IPv4Network("192.168.17.0/24")
NAT = IPv4Network("192.168.44.0/24")

SSH = {
    "port": 22,
    "protocol": "tcp",
    "service": "ssh",
    "product": "Cisco SSH",
    "version": "1.25",
    "extra_info": "protocol 2.0",
    "os_type": "IOS",
}
SWITCH = ("192.168.17.10", "aa:bb:cc:00:01:00", [SSH])
HOST_PC = ("192.168.17.1", "00:50:56:c0:00:01", [])
VM = ("192.168.17.129", "52:54:00:12:34:56", [])

IOSV_ROUTER = ("192.168.17.3", "52:54:00:12:33:67", [SSH])
ALPINE = (
    "192.168.17.129",
    "52:54:00:68:dd:64",
    [{**SSH, "product": "OpenSSH", "version": "10.2", "os_type": ""}],
)
CONFIG = "hostname SW1\nenable secret 9 $9$not-a-real-hash\nend"
SWITCH_KINDS = {
    "version": 1,
    "interfaces": 5,
    "cdp_neighbors": 3,
    "arp": 7,
    "vlans": 8,
    "trunks": 3,
    "spanning_tree": 7,
    "mac_table": 5,
}


@pytest.fixture(autouse=True)
def local_interfaces():
    """Give the machine the lab's two interfaces, without running 'ip'."""
    with patch.object(discovery, "local_networks", return_value=[("ens160", NAT), ("ens256", LAB)]):
        yield


@contextmanager
def fake_network(*hosts):
    """Make the engine 'see' the given (ip, mac, ports) hosts. No packets are sent."""
    found = [{"ip": ip, "mac": mac, "vendor": discovery.lookup_vendor(mac)} for ip, mac, _ in hosts]
    scanned = [{"ip": ip, "ports": ports, "timed_out": False} for ip, _, ports in hosts]
    with (
        patch.object(discovery, "arp_scan", return_value=found) as arp_scan,
        patch.object(scanner, "scan_hosts", return_value=scanned) as scan_hosts,
    ):
        yield arp_scan, scan_hosts


def scan(client, *hosts, **body):
    """POST /scans against a fake network and return the response."""
    with fake_network(*hosts):
        return client.post("/scans", json=body)


@pytest.fixture
def switch_id(client):
    """Scan the fake switch into the database and return its device id."""
    scan(client, SWITCH, HOST_PC)
    return next(d["id"] for d in client.get("/devices").json() if d["last_ip"] == "192.168.17.10")


@pytest.fixture
def switch_ssh():
    """The fake lab switch SW1 behind collector.connect: (connect mock, device)."""
    with fake_lab("SW1", "R1") as lab:
        yield lab.connect_mock, lab["SW1"]


# --- GET /health -----------------------------------------------------------


def test_health(client):
    with patch.object(discovery, "can_open_raw_socket", return_value=False):
        response = client.get("/health")

    assert response.status_code == 200
    assert response.json() == {
        "status": "ok",
        "api_revision": API_REVISION,
        "database": True,
        "raw_sockets": False,
        "scan_running": False,
        "collection_running": False,
    }


# --- POST /scans -----------------------------------------------------------


def test_start_scan_returns_its_id_straight_away_as_running(client):
    response = scan(client, SWITCH, HOST_PC)

    assert response.status_code == 202
    body = response.json()
    assert body["status"] == "running"
    assert body["subnet"] == "192.168.17.0/24"
    assert body["finished_at"] is None
    assert body["device_count"] == 0
    assert isinstance(body["id"], int)


def test_scan_runs_in_the_background_and_can_be_read_back(client):
    scan_id = scan(client, SWITCH, HOST_PC).json()["id"]

    # The test client finishes background tasks before returning.
    body = client.get(f"/scans/{scan_id}").json()

    assert body["status"] == "completed"
    assert body["error"] is None
    assert body["device_count"] == 2
    switch = next(r for r in body["results"] if r["ip"] == "192.168.17.10")
    assert switch["mac"] == "aa:bb:cc:00:01:00"
    assert switch["vendor"] == "Locally administered"
    assert switch["open_ports"] == [SSH]
    assert switch["device_type"] == "network device"
    assert "Cisco SSH 1.25" in switch["reason"]
    # First scan of the subnet: a baseline, so everything is new.
    assert body["changes"]["previous_scan_id"] is None
    assert len(body["changes"]["new_devices"]) == 2


def test_scan_detects_the_interface_and_passes_the_options_to_the_engine(client):
    with fake_network(SWITCH) as (arp_scan, scan_hosts):
        client.post("/scans", json={"top_ports": 20, "host_timeout": 30})

    arp_scan.assert_called_once_with("192.168.17.0/24", "ens256", allowed=[LAB])
    scan_hosts.assert_called_once_with(["192.168.17.10"], 20, 30, [LAB])


def test_scan_works_with_no_request_body(client):
    with fake_network(SWITCH):
        response = client.post("/scans")

    assert response.status_code == 202


def test_second_scan_reports_changes(client):
    first = scan(client, SWITCH, HOST_PC).json()["id"]
    second = scan(client, SWITCH, ("192.168.17.77", "00:50:56:c0:00:01", []), VM).json()["id"]

    changes = client.get(f"/scans/{second}").json()["changes"]

    assert changes["previous_scan_id"] == first
    assert [d["mac"] for d in changes["new_devices"]] == ["52:54:00:12:34:56"]
    assert changes["missing_devices"] == []
    assert changes["ip_changes"] == [
        {
            "mac": "00:50:56:c0:00:01",
            "vendor": "VMware, Inc.",
            "old_ip": "192.168.17.1",
            "new_ip": "192.168.17.77",
        }
    ]


def test_second_scan_is_refused_while_one_is_running(client, session):
    session.add(Scan(subnet="192.168.17.0/24", status=Scan.STATUS_RUNNING))
    session.commit()

    with fake_network(SWITCH) as (arp_scan, _):
        response = client.post("/scans")

    assert response.status_code == 409
    assert "still running" in response.json()["detail"]
    arp_scan.assert_not_called()
    assert len(client.get("/scans").json()) == 1
    assert client.get("/health").json()["scan_running"] is True


@pytest.mark.parametrize("subnet", ["192.168.44.0/24", "192.168.0.0/16", "8.8.8.0/24"])
def test_scan_of_a_subnet_outside_the_allowed_list_is_refused(client, subnet):
    with fake_network(SWITCH) as (arp_scan, scan_hosts):
        response = client.post("/scans", json={"subnet": subnet})

    assert response.status_code == 403
    assert "ALLOWED_SUBNETS" in response.json()["detail"]
    arp_scan.assert_not_called()
    scan_hosts.assert_not_called()
    assert client.get("/scans").json() == []


def test_scan_request_cannot_choose_the_interface(client):
    with fake_network(SWITCH) as (arp_scan, _):
        client.post("/scans", json={"interface": "ens160"})

    assert arp_scan.call_args.args[1] == "ens256"


@pytest.mark.parametrize(
    "body, status",
    [
        ({"subnet": "banana"}, 400),
        ({"subnet": "192.168.17.5/24"}, 400),  # host bits set: not a network address
        ({"top_ports": 0}, 422),
        ({"host_timeout": 100000}, 422),
    ],
)
def test_invalid_scan_requests_are_rejected(client, body, status):
    with fake_network(SWITCH) as (arp_scan, _):
        response = client.post("/scans", json=body)

    assert response.status_code == status
    arp_scan.assert_not_called()


def test_failed_scan_is_reported_with_its_error(client):
    error = discovery.DiscoveryError("ARP scanning needs root or the CAP_NET_RAW capability.")
    with patch.object(discovery, "arp_scan", side_effect=error):
        response = client.post("/scans")

    assert response.status_code == 202  # starting worked; the failure came later
    body = client.get(f"/scans/{response.json()['id']}").json()
    assert body["status"] == "failed"
    assert "CAP_NET_RAW" in body["error"]
    assert body["finished_at"] is not None
    assert body["results"] == []
    assert body["changes"] is None
    # A failed scan does not block the next one.
    assert scan(client, SWITCH).status_code == 202


# --- GET /scans ------------------------------------------------------------


def test_list_scans_newest_first(client):
    first = scan(client, SWITCH).json()["id"]
    second = scan(client, SWITCH, VM).json()["id"]

    body = client.get("/scans").json()

    assert [s["id"] for s in body] == [second, first]
    assert [s["device_count"] for s in body] == [2, 1]
    assert "results" not in body[0]
    assert [s["id"] for s in client.get("/scans", params={"limit": 1}).json()] == [second]


def test_unknown_scan_is_404(client):
    assert client.get("/scans/999").status_code == 404


# --- GET /devices ----------------------------------------------------------


def test_devices_carry_their_latest_scan_result(client):
    scan(client, SWITCH, HOST_PC)
    latest = scan(client, ("192.168.17.20", "aa:bb:cc:00:01:00", [SSH])).json()["id"]

    devices = client.get("/devices").json()

    assert len(devices) == 2
    switch = next(d for d in devices if d["mac"] == "aa:bb:cc:00:01:00")
    assert switch["last_ip"] == "192.168.17.20"
    assert switch["device_type"] == "network device"
    assert switch["first_seen"] <= switch["last_seen"]
    assert switch["latest_result"]["scan_id"] == latest
    assert switch["latest_result"]["ip"] == "192.168.17.20"
    assert switch["latest_result"]["open_ports"] == [SSH]
    assert client.get(f"/devices/{switch['id']}").json() == switch


def test_unknown_device_is_404(client):
    for path in ("", "/interfaces", "/vlans", "/mac-table", "/configs"):
        assert client.get(f"/devices/999{path}").status_code == 404
    assert client.post("/devices/999/collect").status_code == 404


# --- POST /devices/{id}/collect --------------------------------------------


def test_collect_logs_in_with_env_credentials_and_stores_everything(client, switch_id, switch_ssh):
    connect, conn = switch_ssh
    conn.outputs["show running-config"] = CONFIG

    response = client.post(f"/devices/{switch_id}/collect")

    assert response.status_code == 200
    body = response.json()
    assert body["device_id"] == switch_id
    assert body["host"] == "192.168.17.10"
    assert body["collected"] == SWITCH_KINDS
    assert body["note"] is None
    # A first backup is new, not "changed": there is nothing to compare with.
    assert body["first_backup"] is True
    assert body["config_changed"] is False
    assert body["config_backup"]["lines"] == 3
    assert body["config_backup"]["changed"] is None
    connect.assert_called_once_with("192.168.17.10", "test-user", "test-password", timeout=10)
    assert conn.disconnected == 1
    # Only read-only show commands went to the device, and no router commands.
    assert conn.sent and all(command.startswith("show ") for command in conn.sent)
    assert "show ip route" not in conn.sent


def test_collected_data_can_be_read_back(client, switch_id, switch_ssh):
    client.post(f"/devices/{switch_id}/collect")

    interfaces = client.get(f"/devices/{switch_id}/interfaces").json()
    assert interfaces["device_id"] == switch_id
    assert interfaces["collected_at"]
    assert {"interface": "Vlan10", "ip_address": "192.168.17.10", "status": "up", "proto": "up"} in interfaces["data"]
    vlans = client.get(f"/devices/{switch_id}/vlans").json()["data"]
    assert {"20": "USERS", "30": "SERVERS"}.items() <= {v["vlan_id"]: v["vlan_name"] for v in vlans}.items()
    assert len(client.get(f"/devices/{switch_id}/mac-table").json()["data"]) == 5


def test_unparsed_output_is_stored_and_served_as_raw_text(client, switch_id, switch_ssh):
    _, conn = switch_ssh
    conn.outputs["show mac address-table"] = "Mac Address Table (TextFSM could not parse this)"

    body = client.post(f"/devices/{switch_id}/collect").json()

    assert body["collected"]["mac_table"] is None
    assert (
        client.get(f"/devices/{switch_id}/mac-table").json()["data"]
        == "Mac Address Table (TextFSM could not parse this)"
    )


def test_collected_data_is_404_before_any_collection(client, switch_id):
    response = client.get(f"/devices/{switch_id}/interfaces")

    assert response.status_code == 404
    assert "collect first" in response.json()["detail"]
    assert client.get(f"/devices/{switch_id}/configs").json() == []


def test_identical_config_is_backed_up_once_and_its_text_is_never_exposed(
    client, switch_id, switch_ssh
):
    _, conn = switch_ssh
    conn.outputs["show running-config"] = CONFIG
    client.post(f"/devices/{switch_id}/collect")
    second = client.post(f"/devices/{switch_id}/collect")

    assert second.json()["config_changed"] is False
    configs = client.get(f"/devices/{switch_id}/configs")
    assert len(configs.json()) == 1
    assert "config" not in configs.json()[0]
    assert second.json()["first_backup"] is False
    assert "enable secret" not in configs.text
    assert "enable secret" not in second.text


def test_config_text_is_served_with_its_secrets_masked(client, switch_id, switch_ssh):
    switch_ssh[1].outputs["show running-config"] = CONFIG
    client.post(f"/devices/{switch_id}/collect")
    backup_id = client.get(f"/devices/{switch_id}/configs").json()[0]["id"]

    response = client.get(f"/devices/{switch_id}/configs/{backup_id}")

    assert response.status_code == 200
    body = response.json()
    assert body["config"] == "hostname SW1\nenable secret <redacted>\nend"
    assert body["lines"] == 3
    assert "not-a-real-hash" not in response.text


def test_config_backup_of_another_device_is_404(client, switch_id, switch_ssh):
    client.post(f"/devices/{switch_id}/collect")
    backup_id = client.get(f"/devices/{switch_id}/configs").json()[0]["id"]
    other = next(d["id"] for d in client.get("/devices").json() if d["id"] != switch_id)

    assert client.get(f"/devices/{other}/configs/{backup_id}").status_code == 404
    assert client.get(f"/devices/{switch_id}/configs/999").status_code == 404


# --- device type and virtualisation ----------------------------------------


def test_devices_report_virtualization_separately_from_type(client):
    scan(client, SWITCH, HOST_PC, IOSV_ROUTER, ALPINE)

    devices = {d["last_ip"]: d for d in client.get("/devices").json()}

    def summary(ip):
        return devices[ip]["device_type"], devices[ip]["virtualization"]

    assert summary("192.168.17.3") == ("network device", "QEMU/KVM")  # IOSv router
    assert summary("192.168.17.129") == ("Linux/Unix host", "QEMU/KVM")  # Alpine
    assert summary("192.168.17.10") == ("network device", None)  # IOL switch
    assert summary("192.168.17.1") == ("unknown", "VMware")
    router = devices["192.168.17.3"]
    assert router["vendor"] == "QEMU/KVM"
    assert router["type_source"] == "scan"
    assert router["type_reason"] == "ssh banner on port 22 is 'Cisco SSH 1.25', OS IOS"


def test_collect_confirms_the_switch_and_later_scans_keep_it(client, switch_id, switch_ssh):
    response = client.post(f"/devices/{switch_id}/collect")

    assert response.json()["device_type"] == "switch"
    assert response.json()["type_reason"].startswith("confirmed by login: show version reports")
    device = client.get(f"/devices/{switch_id}").json()
    assert (device["device_type"], device["type_source"]) == ("switch", "collected")

    # A new scan still only sees an SSH banner, and must not undo the login's answer.
    scan(client, SWITCH, HOST_PC)
    device = client.get(f"/devices/{switch_id}").json()
    assert (device["device_type"], device["type_source"]) == ("switch", "collected")
    assert device["latest_result"]["device_type"] == "network device"
    # A confirmed switch can be collected from again.
    assert client.post(f"/devices/{switch_id}/collect").status_code == 200


def test_collect_confirms_an_iosv_router_as_a_router(client, switch_ssh):
    scan(client, IOSV_ROUTER)
    router = client.get("/devices").json()[0]
    assert router["device_type"] == "network device"

    response = client.post(f"/devices/{router['id']}/collect")

    assert response.status_code == 200
    body = response.json()
    assert body["device_type"] == "router"
    # Router data only: no VLAN table, trunks, spanning tree or MAC table.
    assert body["collected"] == {
        "version": 1,
        "interfaces": 6,
        "cdp_neighbors": 2,
        "arp": 7,
        "routes": 10,
        "ospf_neighbors": 1,
        "ospf_interfaces": 3,
    }
    assert "legacy SSH (ssh-rsa" in body["note"]
    device = client.get(f"/devices/{router['id']}").json()
    assert (device["device_type"], device["virtualization"]) == ("router", "QEMU/KVM")
    assert "VIOS-ADVENTERPRISEK9-M" in device["type_reason"]


def test_failed_collect_leaves_the_scan_based_type_alone(client, switch_id):
    with patch.object(collector, "connect", side_effect=collector.DeviceAuthenticationError("no")):
        client.post(f"/devices/{switch_id}/collect")

    device = client.get(f"/devices/{switch_id}").json()
    assert (device["device_type"], device["type_source"]) == ("network device", "scan")


# --- config changes and diffs ----------------------------------------------


def collect_config(client, switch_id, conn, config):
    """Collect from the fake switch while its running config is the given text."""
    conn.outputs["show running-config"] = config
    response = client.post(f"/devices/{switch_id}/collect")
    assert response.status_code == 200
    return response.json()


def test_collect_reports_no_change_when_only_timestamps_differ(client, switch_id, switch_ssh):
    _, conn = switch_ssh
    first = collect_config(client, switch_id, conn, BASE)
    second = collect_config(client, switch_id, conn, SAME_LATER)

    assert (first["first_backup"], first["config_changed"]) == (True, False)
    assert (second["first_backup"], second["config_changed"]) == (False, False)
    assert second["config_backup"]["id"] == first["config_backup"]["id"]
    assert len(client.get(f"/devices/{switch_id}/configs").json()) == 1


def test_collect_reports_a_real_config_change_with_its_size(client, switch_id, switch_ssh):
    _, conn = switch_ssh
    first = collect_config(client, switch_id, conn, BASE)
    second = collect_config(client, switch_id, conn, NEW_VLAN)

    assert second["config_changed"] is True
    assert second["first_backup"] is False
    assert second["config_backup"]["id"] != first["config_backup"]["id"]
    assert second["config_backup"]["changed"] is True
    assert second["config_backup"]["lines_added"] == 4
    assert second["config_backup"]["lines_removed"] == 1


def test_backup_list_marks_which_backups_changed(client, switch_id, switch_ssh):
    _, conn = switch_ssh
    for config in (BASE, SAME_LATER, NEW_VLAN, NEW_SECRET):
        collect_config(client, switch_id, conn, config)

    backups = client.get(f"/devices/{switch_id}/configs").json()

    # Newest first. Three versions: the unchanged re-read was not stored.
    assert [b["changed"] for b in backups] == [True, True, None]
    assert [(b["lines_added"], b["lines_removed"]) for b in backups] == [(2, 5), (4, 1), (0, 0)]
    detail = client.get(f"/devices/{switch_id}/configs/{backups[1]['id']}").json()
    assert detail["changed"] is True
    assert "vlan 20" in detail["config"]


def test_diff_latest_compares_the_previous_backup_with_the_newest(client, switch_id, switch_ssh):
    _, conn = switch_ssh
    old = collect_config(client, switch_id, conn, BASE)["config_backup"]["id"]
    new = collect_config(client, switch_id, conn, NEW_VLAN)["config_backup"]["id"]

    response = client.get(f"/devices/{switch_id}/configs/diff/latest")

    assert response.status_code == 200
    body = response.json()
    assert body["device_id"] == switch_id
    assert (body["from_backup"]["id"], body["to_backup"]["id"]) == (old, new)
    assert body["changed"] is True
    assert (body["lines_added"], body["lines_removed"]) == (4, 1)
    lines = body["diff"].splitlines()
    assert lines[0].startswith(f"--- backup #{old} (")
    assert lines[1].startswith(f"+++ backup #{new} (")
    assert "+vlan 20" in lines
    assert "- switchport access vlan 10" in lines
    assert "+ switchport access vlan 20" in lines
    # Secrets never leave the server, changed or not.
    assert "fakeHash" not in response.text
    assert "fakeCommunity" not in response.text


def test_diff_between_any_two_backups_in_either_direction(client, switch_id, switch_ssh):
    _, conn = switch_ssh
    ids = [
        collect_config(client, switch_id, conn, config)["config_backup"]["id"]
        for config in (BASE, NEW_VLAN, NEW_SECRET)
    ]

    def diff(from_id, to_id):
        return client.get(
            f"/devices/{switch_id}/configs/diff", params={"from_id": from_id, "to_id": to_id}
        ).json()

    # First to third skips the middle backup: only the secret differs.
    skipping = diff(ids[0], ids[2])
    assert (skipping["lines_added"], skipping["lines_removed"]) == (1, 1)
    assert "+enable secret <redacted>" in skipping["diff"].splitlines()

    backwards = diff(ids[1], ids[0])
    assert (backwards["lines_added"], backwards["lines_removed"]) == (1, 4)

    same = diff(ids[0], ids[0])
    assert same["changed"] is False
    assert same["diff"] == ""


def test_compare_request_is_not_mistaken_for_a_backup_id(client, switch_id, switch_ssh):
    # Regression: served by code without the /configs/diff route, this exact
    # request was matched by /configs/{backup_id} and failed with "Input
    # should be a valid integer". The route must exist and be matched first.
    _, conn = switch_ssh
    collect_config(client, switch_id, conn, BASE)
    older = collect_config(client, switch_id, conn, NEW_VLAN)["config_backup"]["id"]
    newer = collect_config(client, switch_id, conn, NEW_SECRET)["config_backup"]["id"]

    response = client.get(f"/devices/{switch_id}/configs/diff?from_id={older}&to_id={newer}")

    assert response.status_code == 200, response.text
    body = response.json()
    assert (body["from_backup"]["id"], body["to_backup"]["id"]) == (older, newer)
    assert body["changed"] is True
    assert client.get(f"/devices/{switch_id}/configs/diff/latest").json()["diff"] == body["diff"]


def test_every_backup_says_whether_it_changed(client, switch_id, switch_ssh):
    # Regression: the dashboard showed "no change" for a backup that had
    # changed, because the response it got had no "changed" field at all.
    _, conn = switch_ssh
    collect_config(client, switch_id, conn, BASE)
    collect_config(client, switch_id, conn, NEW_VLAN)

    newest, first = client.get(f"/devices/{switch_id}/configs").json()

    assert newest["lines"] > first["lines"]
    assert newest["changed"] is True
    assert (newest["lines_added"], newest["lines_removed"]) == (4, 1)
    assert "changed" in first and first["changed"] is None


def test_unchanged_collection_adds_no_backup_even_after_an_old_style_hash(
    client, session, switch_id, switch_ssh
):
    # Regression: a backup whose stored hash was computed the old way (from
    # the raw text) must still be recognised as the same configuration.
    import hashlib

    _, conn = switch_ssh
    first = collect_config(client, switch_id, conn, BASE)
    stored = session.get(ConfigBackup, first["config_backup"]["id"])
    stored.sha256 = hashlib.sha256(BASE.encode()).hexdigest()
    session.commit()

    for config in (BASE, SAME_LATER, BASE):
        again = collect_config(client, switch_id, conn, config)
        assert again["config_changed"] is False
        assert again["config_backup"]["id"] == first["config_backup"]["id"]

    assert len(client.get(f"/devices/{switch_id}/configs").json()) == 1


def test_diff_errors(client, switch_id, switch_ssh):
    _, conn = switch_ssh
    other = next(d["id"] for d in client.get("/devices").json() if d["id"] != switch_id)
    base = f"/devices/{switch_id}/configs/diff"

    # No backups, then one backup: nothing to compare yet.
    assert client.get(f"{base}/latest").status_code == 404
    only = collect_config(client, switch_id, conn, BASE)["config_backup"]["id"]
    response = client.get(f"{base}/latest")
    assert response.status_code == 404
    assert "two are needed" in response.json()["detail"]

    assert client.get(base, params={"from_id": only, "to_id": 999}).status_code == 404
    assert client.get(base, params={"from_id": only}).status_code == 422
    assert client.get(base, params={"from_id": "x", "to_id": only}).status_code == 422
    # Another device's backups are not reachable through this device.
    wrong = client.get(f"/devices/{other}/configs/diff", params={"from_id": only, "to_id": only})
    assert wrong.status_code == 404
    assert client.get("/devices/999/configs/diff/latest").status_code == 404


def test_collect_refuses_devices_not_classified_as_network_devices(client, switch_ssh):
    connect, _ = switch_ssh
    scan(client, HOST_PC)
    host_pc = client.get("/devices").json()[0]

    response = client.post(f"/devices/{host_pc['id']}/collect")

    assert response.status_code == 400
    assert "classified as 'unknown'" in response.json()["detail"]
    connect.assert_not_called()


def test_collect_refuses_devices_outside_the_allowed_subnets(client, session, switch_ssh):
    connect, _ = switch_ssh
    device = Device(mac="aa:bb:cc:00:02:00", last_ip="192.168.44.5", device_type="network device")
    session.add(device)
    session.commit()

    response = client.post(f"/devices/{device.id}/collect")

    assert response.status_code == 403
    connect.assert_not_called()


@pytest.mark.parametrize(
    "error, status",
    [
        (collector.DeviceUnreachableError("Unreachable: cannot open TCP port 22."), 502),
        (collector.DeviceAuthenticationError("Authentication failed: rejected the login."), 502),
        (collector.DeviceTimeoutError("Timeout: did not answer."), 504),
    ],
)
def test_collect_reports_which_connection_error_happened(client, session, switch_id, error, status):
    with patch.object(collector, "connect", side_effect=error):
        response = client.post(f"/devices/{switch_id}/collect")

    assert response.status_code == status
    assert response.json()["detail"] == str(error)
    assert "test-password" not in response.text
    assert session.query(ConfigBackup).count() == 0


def test_collect_disconnects_when_a_command_fails(client, switch_id, switch_ssh):
    _, conn = switch_ssh
    conn.outputs["show ip arp"] = collector.ReadTimeout()

    response = client.post(f"/devices/{switch_id}/collect")

    assert response.status_code == 504
    assert "show ip arp" in response.json()["detail"]
    assert conn.disconnected == 1
    # Nothing half-collected is stored.
    assert client.get(f"/devices/{switch_id}/interfaces").status_code == 404


# --- CORS ------------------------------------------------------------------


def test_cors_allows_every_method_the_api_uses(client):
    # Regression: PUT /baseline was refused at the preflight ("Disallowed
    # CORS method"), and the dashboard could only report "API not reachable".
    from app.main import ALLOWED_METHODS, app

    used = {method for route in app.routes for method in getattr(route, "methods", set())} - {"HEAD"}
    assert used <= set(ALLOWED_METHODS)

    for method, path in [("PUT", "/baseline"), ("POST", "/drift-checks"), ("POST", "/collections"), ("GET", "/devices")]:
        preflight = client.options(
            path,
            headers={
                "Origin": "http://localhost:5173",
                "Access-Control-Request-Method": method,
                "Access-Control-Request-Headers": "content-type",
            },
        )
        assert preflight.status_code == 200, (method, path, preflight.text)
        assert preflight.headers["access-control-allow-origin"] == "http://localhost:5173"


def test_error_responses_carry_cors_headers_so_the_browser_can_read_them(client):
    response = client.get("/devices/999", headers={"Origin": "http://localhost:5173"})

    assert response.status_code == 404
    assert response.headers["access-control-allow-origin"] == "http://localhost:5173"


def test_an_unhandled_error_is_a_json_500_with_cors_headers(engine):
    from fastapi.testclient import TestClient

    from app.api.deps import get_session
    from app.main import app

    def broken_session():
        raise RuntimeError("database exploded: SELECT secret FROM somewhere")
        yield  # pragma: no cover

    app.dependency_overrides[get_session] = broken_session
    try:
        client = TestClient(app, raise_server_exceptions=False)
        response = client.get("/devices", headers={"Origin": "http://localhost:5173"})
    finally:
        app.dependency_overrides.clear()

    assert response.status_code == 500
    assert response.headers["access-control-allow-origin"] == "http://localhost:5173"
    assert response.json() == {
        "detail": "Internal server error (RuntimeError) while handling GET /devices. The full error is in the backend's log."
    }
    # The exception's own text (SQL, addresses, config) stays in the log.
    assert "SELECT" not in response.text


def test_cors_allows_the_frontend_dev_server_only(client):
    preflight = {"Access-Control-Request-Method": "POST"}

    allowed = client.options("/scans", headers={"Origin": "http://localhost:5173", **preflight})
    other = client.options("/scans", headers={"Origin": "http://evil.example", **preflight})

    assert allowed.headers["access-control-allow-origin"] == "http://localhost:5173"
    assert "access-control-allow-origin" not in other.headers
