"""Scan service tests: fake engine results, a real (in-memory) database."""

from contextlib import contextmanager
from ipaddress import IPv4Network
from unittest.mock import patch

import pytest
from sqlalchemy import select

from app.db.models import Device, Scan, ScanResult
from app.engine import discovery, scanner
from app.services import scan_service

ALLOWED = [IPv4Network("192.168.17.0/24")]
SUBNET = "192.168.17.0/24"

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
LAPTOP = ("192.168.17.50", "b8:27:eb:11:22:33", [])
VM = ("192.168.17.129", "52:54:00:12:34:56", [])


@contextmanager
def fake_network(*hosts):
    """Make the engine 'see' the given (ip, mac, ports) hosts. No packets are sent."""
    found = [{"ip": ip, "mac": mac, "vendor": discovery.lookup_vendor(mac)} for ip, mac, _ in hosts]
    scanned = [{"ip": ip, "ports": ports, "timed_out": False} for ip, _, ports in hosts]
    with (
        patch.object(discovery, "arp_scan", return_value=found),
        patch.object(scanner, "scan_hosts", return_value=scanned),
    ):
        yield


def run(session, *hosts, subnet=SUBNET):
    with fake_network(*hosts):
        return scan_service.run_scan(session, subnet, "ens256", allowed=ALLOWED)


def macs(devices):
    return sorted(device["mac"] for device in devices)


# --- saving ----------------------------------------------------------------


def test_run_scan_saves_one_completed_scan_with_a_result_per_device(session):
    scan, _ = run(session, SWITCH, HOST_PC)

    assert scan.subnet == SUBNET
    assert scan.status == Scan.STATUS_COMPLETED
    assert scan.started_at <= scan.finished_at
    assert scan.error is None

    switch = next(result for result in scan.results if result.ip == "192.168.17.10")
    assert switch.device.mac == "aa:bb:cc:00:01:00"
    assert switch.open_ports == [SSH]
    assert switch.device_type == "network device"
    assert "Cisco SSH 1.25" in switch.reason
    assert len(scan.results) == 2


def test_devices_are_created_once_and_updated_on_later_scans(session):
    run(session, SWITCH)
    first = session.scalars(select(Device)).one()
    first_seen, last_seen = first.first_seen, first.last_seen

    # Same MAC, new IP: still the same device row.
    run(session, ("192.168.17.20", "AA:BB:CC:00:01:00", [SSH]))

    device = session.scalars(select(Device)).one()
    assert device.first_seen == first_seen
    assert device.last_seen >= last_seen
    assert device.last_ip == "192.168.17.20"
    assert device.device_type == "network device"
    assert [result.ip for result in device.results] == ["192.168.17.10", "192.168.17.20"]


def test_one_mac_answering_for_two_ips_gets_a_single_result(session):
    scan, _ = run(session, SWITCH, ("192.168.17.11", "aa:bb:cc:00:01:00", []))

    assert [result.ip for result in scan.results] == ["192.168.17.10"]


def test_scan_with_no_devices_is_still_recorded(session):
    scan, report = run(session)

    assert scan.status == Scan.STATUS_COMPLETED
    assert scan.results == []
    assert not report.has_changes


def test_failed_scan_is_recorded_with_its_error_and_no_results(session):
    with (
        patch.object(discovery, "arp_scan", return_value=[{"ip": "192.168.17.10", "mac": "aa:bb:cc:00:01:00", "vendor": "x"}]),
        patch.object(scanner, "scan_hosts", side_effect=scanner.ScannerError("Nmap failed: boom")),
    ):
        with pytest.raises(scanner.ScannerError):
            scan_service.run_scan(session, SUBNET, "ens256", allowed=ALLOWED)

    scan = session.scalars(select(Scan)).one()
    assert scan.status == Scan.STATUS_FAILED
    assert scan.error == "Nmap failed: boom"
    assert scan.finished_at is not None
    assert session.scalars(select(ScanResult)).all() == []


def test_subnet_outside_allowed_list_is_refused_and_nothing_is_saved(session):
    with patch.object(discovery, "arp_scan") as arp_scan:
        with pytest.raises(discovery.SubnetNotAllowedError):
            scan_service.run_scan(session, "192.168.44.0/24", "ens160", allowed=ALLOWED)

    arp_scan.assert_not_called()
    assert session.scalars(select(Scan)).all() == []


# --- change report ---------------------------------------------------------


def test_first_scan_is_a_baseline_where_every_device_is_new(session):
    scan, report = run(session, SWITCH, HOST_PC)

    assert report.scan_id == scan.id
    assert report.previous_scan_id is None
    assert macs(report.new_devices) == ["00:50:56:c0:00:01", "aa:bb:cc:00:01:00"]
    assert report.missing_devices == []
    assert report.ip_changes == []


def test_two_scans_report_new_missing_and_ip_changed_devices(session):
    first, _ = run(session, SWITCH, HOST_PC, LAPTOP)

    # Second scan: the laptop is gone, a VM has appeared, the host PC got a
    # new IP from DHCP, and the switch is exactly as before.
    second, report = run(
        session,
        SWITCH,
        ("192.168.17.77", "00:50:56:c0:00:01", []),
        VM,
    )

    assert report.scan_id == second.id
    assert report.previous_scan_id == first.id
    assert report.new_devices == [
        {
            "mac": "52:54:00:12:34:56",
            "ip": "192.168.17.129",
            "vendor": "QEMU/KVM",
            "type": "unknown",
        }
    ]
    assert report.missing_devices == [
        {
            "mac": "b8:27:eb:11:22:33",
            "ip": "192.168.17.50",
            "vendor": "Raspberry Pi Foundation",
            "type": "unknown",
        }
    ]
    assert report.ip_changes == [
        {
            "mac": "00:50:56:c0:00:01",
            "vendor": "VMware, Inc.",
            "old_ip": "192.168.17.1",
            "new_ip": "192.168.17.77",
        }
    ]
    assert report.has_changes


def test_identical_scans_report_no_changes(session):
    run(session, SWITCH, HOST_PC)
    _, report = run(session, SWITCH, HOST_PC)

    assert report.previous_scan_id is not None
    assert not report.has_changes


def test_a_device_that_comes_back_is_reported_as_new_again(session):
    run(session, SWITCH, LAPTOP)
    run(session, SWITCH)
    _, report = run(session, SWITCH, LAPTOP)

    assert macs(report.new_devices) == ["b8:27:eb:11:22:33"]


def test_comparison_skips_failed_scans(session):
    first, _ = run(session, SWITCH, LAPTOP)
    with patch.object(discovery, "arp_scan", side_effect=discovery.DiscoveryError("no root")):
        with pytest.raises(discovery.DiscoveryError):
            scan_service.run_scan(session, SUBNET, "ens256", allowed=ALLOWED)

    # Compared with the last *completed* scan, not the failed (empty) one.
    _, report = run(session, SWITCH)

    assert report.previous_scan_id == first.id
    assert macs(report.missing_devices) == ["b8:27:eb:11:22:33"]
    assert report.new_devices == []


def test_comparison_only_uses_scans_of_the_same_subnet(session):
    run(session, SWITCH, LAPTOP)

    _, report = run(session, SWITCH, subnet="192.168.17.0/28")

    assert report.previous_scan_id is None


# --- one scan at a time ----------------------------------------------------


def test_a_scan_cannot_start_while_another_is_running(session):
    session.add(Scan(subnet=SUBNET, status=Scan.STATUS_RUNNING))
    session.commit()

    with fake_network(SWITCH):
        with pytest.raises(scan_service.ScanInProgressError, match="still running"):
            scan_service.run_scan(session, SUBNET, "ens256", allowed=ALLOWED)

    assert len(session.scalars(select(Scan)).all()) == 1


def test_interrupting_a_scan_marks_it_failed_instead_of_leaving_it_running(session):
    with patch.object(discovery, "arp_scan", side_effect=KeyboardInterrupt):
        with pytest.raises(KeyboardInterrupt):
            scan_service.run_scan(session, SUBNET, "ens256", allowed=ALLOWED)

    scan = session.scalars(select(Scan)).one()
    assert scan.status == Scan.STATUS_FAILED
    assert scan.error == "KeyboardInterrupt"
    # So the next scan is not blocked.
    assert run(session, SWITCH)[0].status == Scan.STATUS_COMPLETED


def test_scans_left_running_by_a_crash_are_failed_at_startup(session):
    finished, _ = run(session, SWITCH)
    session.add(Scan(subnet=SUBNET, status=Scan.STATUS_RUNNING))
    session.commit()

    assert scan_service.fail_interrupted_scans(session) == 1

    statuses = [scan.status for scan in session.scalars(select(Scan).order_by(Scan.id))]
    assert statuses == [Scan.STATUS_COMPLETED, Scan.STATUS_FAILED]
    assert scan_service.fail_interrupted_scans(session) == 0
    assert finished.error is None


# --- virtualisation and confirmed types ------------------------------------


def test_scan_saves_virtualization_separately_from_the_type(session):
    iosv_router = ("192.168.17.3", "52:54:00:12:33:67", [SSH])
    alpine = ("192.168.17.129", "52:54:00:68:dd:64", [])
    run(session, SWITCH, iosv_router, alpine)

    by_ip = {device.last_ip: device for device in session.scalars(select(Device))}

    router = by_ip["192.168.17.3"]
    assert (router.device_type, router.virtualization) == ("network device", "QEMU/KVM")
    assert router.type_source == Device.TYPE_FROM_SCAN
    assert "Cisco SSH 1.25" in router.type_reason
    assert (by_ip["192.168.17.129"].device_type, by_ip["192.168.17.129"].virtualization) == (
        "unknown",
        "QEMU/KVM",
    )
    assert (by_ip["192.168.17.10"].device_type, by_ip["192.168.17.10"].virtualization) == (
        "network device",
        None,
    )


def test_a_type_confirmed_by_login_survives_later_scans(session):
    from app.services import collection_service

    run(session, SWITCH)
    device = session.scalars(select(Device)).one()
    version = [{"software_image": "X86_64BI_LINUX_L2-ADVENTERPRISEK9-M", "hardware": []}]
    collection_service.confirm_device_type(session, device, version, vlans=[{"vlan_id": "1"}])
    assert (device.device_type, device.type_source) == ("switch", Device.TYPE_FROM_COLLECTION)

    # Later scans: one sees the SSH banner, one sees no open ports at all.
    second, _ = run(session, SWITCH)
    third, _ = run(session, ("192.168.17.10", "aa:bb:cc:00:01:00", []))

    session.refresh(device)
    assert device.device_type == "switch"
    assert device.type_reason.startswith("confirmed by login")
    assert device.type_source == Device.TYPE_FROM_COLLECTION
    # Each scan still records what it could tell by itself.
    assert second.results[0].device_type == "network device"
    assert third.results[0].device_type == "unknown"
