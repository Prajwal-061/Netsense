"""Discovery tests. Scapy's send/receive is mocked, so no root or lab is needed."""

import json
from ipaddress import IPv4Network
from unittest.mock import MagicMock, patch

import pytest
from scapy.layers.l2 import ARP, Ether

from app.engine import discovery

LAB = IPv4Network("192.168.17.0/24")
NAT = IPv4Network("192.168.44.0/24")
ALLOWED = [LAB]

# The same shape as this VM: a NAT interface first, then the lab interface.
LOCAL = [("ens160", NAT), ("ens256", LAB)]


def arp_reply(ip: str, mac: str):
    """A (sent, received) pair shaped like the ones srp() returns."""
    return (MagicMock(), Ether(src=mac) / ARP(op="is-at", psrc=ip, hwsrc=mac))


@pytest.fixture
def srp():
    with patch("app.engine.discovery.srp") as fake:
        fake.return_value = ([], [])
        yield fake


@pytest.fixture
def local():
    with patch("app.engine.discovery.local_networks", return_value=LOCAL):
        yield


# --- arp_scan() ------------------------------------------------------------


def test_arp_scan_returns_ip_mac_vendor_sorted_by_ip(srp):
    srp.return_value = (
        [
            arp_reply("192.168.17.132", "00:0C:29:23:56:F6"),
            arp_reply("192.168.17.10", "aa:bb:cc:00:01:00"),
            arp_reply("192.168.17.9", "b8:27:eb:11:22:33"),
        ],
        [],
    )

    devices = discovery.arp_scan("192.168.17.0/24", "ens256", allowed=ALLOWED)

    assert devices == [
        {"ip": "192.168.17.9", "mac": "b8:27:eb:11:22:33", "vendor": "Raspberry Pi Foundation"},
        {"ip": "192.168.17.10", "mac": "aa:bb:cc:00:01:00", "vendor": "Locally administered"},
        {"ip": "192.168.17.132", "mac": "00:0c:29:23:56:f6", "vendor": "VMware, Inc."},
    ]


def test_arp_scan_sends_broadcast_arp_request_on_the_interface(srp):
    discovery.arp_scan("192.168.17.0/24", "ens256", timeout=5, allowed=ALLOWED)

    request = srp.call_args.args[0]
    assert request[Ether].dst == "ff:ff:ff:ff:ff:ff"
    assert request[ARP].op == 1  # who-has
    assert srp.call_args.kwargs["iface"] == "ens256"
    assert srp.call_args.kwargs["timeout"] == 5


def test_arp_scan_drops_duplicate_replies(srp):
    reply = arp_reply("192.168.17.10", "aa:bb:cc:00:01:00")
    srp.return_value = ([reply, reply], [])

    assert len(discovery.arp_scan("192.168.17.0/24", "ens256", allowed=ALLOWED)) == 1


def test_arp_scan_with_no_replies_returns_empty_list(srp):
    assert discovery.arp_scan("192.168.17.0/24", "ens256", allowed=ALLOWED) == []


@pytest.mark.parametrize("subnet", ["192.168.44.0/24", "192.168.0.0/16", "10.0.0.0/8"])
def test_arp_scan_refuses_subnets_not_on_the_allowed_list(srp, subnet):
    with pytest.raises(discovery.SubnetNotAllowedError, match="ALLOWED_SUBNETS"):
        discovery.arp_scan(subnet, "ens160", allowed=ALLOWED)

    srp.assert_not_called()


def test_arp_scan_allows_a_smaller_subnet_inside_an_allowed_one(srp):
    discovery.arp_scan("192.168.17.0/28", "ens256", allowed=ALLOWED)

    srp.assert_called_once()


def test_arp_scan_uses_allowed_subnets_from_settings_by_default(srp):
    settings = MagicMock(allowed_subnets=ALLOWED)
    with patch("app.engine.discovery.get_settings", return_value=settings):
        with pytest.raises(discovery.SubnetNotAllowedError):
            discovery.arp_scan("192.168.44.0/24", "ens160")


def test_arp_scan_without_root_explains_why(srp):
    srp.side_effect = PermissionError(1, "Operation not permitted")

    with pytest.raises(discovery.DiscoveryError, match="needs root"):
        discovery.arp_scan("192.168.17.0/24", "ens256", allowed=ALLOWED)


# --- resolve_target() ------------------------------------------------------


def test_resolve_target_picks_the_allowed_network_not_the_first_one(local):
    assert discovery.resolve_target(allowed=ALLOWED) == (LAB, "ens256")


def test_resolve_target_explicit_values_are_used_as_given():
    assert discovery.resolve_target("192.168.17.0/28", "eth9", allowed=ALLOWED) == (
        IPv4Network("192.168.17.0/28"),
        "eth9",
    )


def test_resolve_target_finds_the_interface_for_a_subnet(local):
    assert discovery.resolve_target(subnet="192.168.17.0/24", allowed=ALLOWED) == (LAB, "ens256")


def test_resolve_target_finds_the_subnet_for_an_interface(local):
    assert discovery.resolve_target(interface="ens256", allowed=ALLOWED) == (LAB, "ens256")


def test_resolve_target_subnet_not_directly_connected(local):
    with pytest.raises(discovery.DiscoveryError, match="cannot cross a router"):
        discovery.resolve_target(subnet="10.1.1.0/24", allowed=ALLOWED)


def test_resolve_target_no_allowed_network_on_this_machine():
    with patch("app.engine.discovery.local_networks", return_value=[("ens160", NAT)]):
        with pytest.raises(discovery.DiscoveryError, match="nothing to scan"):
            discovery.resolve_target(allowed=ALLOWED)


def test_local_networks_parses_ip_output_and_skips_loopback():
    ip_json = json.dumps(
        [
            {
                "ifname": "lo",
                "flags": ["LOOPBACK", "UP"],
                "addr_info": [{"local": "127.0.0.1", "prefixlen": 8}],
            },
            {
                "ifname": "ens256",
                "flags": ["BROADCAST", "UP"],
                "addr_info": [{"local": "192.168.17.132", "prefixlen": 24}],
            },
        ]
    )
    with patch("app.engine.discovery.subprocess.run") as run:
        run.return_value.stdout = ip_json

        assert discovery.local_networks() == [("ens256", LAB)]


# --- lookup_vendor() -------------------------------------------------------


@pytest.mark.parametrize(
    "mac, vendor",
    [
        ("00:0c:29:23:56:f6", "VMware, Inc."),
        ("B8:27:EB:11:22:33", "Raspberry Pi Foundation"),
        ("aa:bb:cc:00:01:00", "Locally administered"),
        # Virtualization prefixes win over both the OUI list and the
        # locally administered check.
        ("52:54:00:12:34:56", "QEMU/KVM"),
        ("52:54:00:AB:CD:EF", "QEMU/KVM"),
        ("08:00:27:aa:bb:cc", "VirtualBox"),
        ("00:15:5d:01:02:03", "Hyper-V"),
        ("02:42:ac:11:00:02", "Docker"),
        ("52:54:01:12:34:56", "Locally administered"),
        ("00:00:00:00:00:01", None),
    ],
)
def test_lookup_vendor(mac, vendor):
    result = discovery.lookup_vendor(mac)

    if vendor is not None:
        assert result == vendor
    assert result != mac


@pytest.mark.parametrize(
    "mac, platform",
    [
        ("52:54:00:12:33:67", "QEMU/KVM"),
        ("52:54:00:AB:CD:EF", "QEMU/KVM"),
        ("00:0c:29:23:56:f6", "VMware"),
        ("00:50:56:c0:00:01", "VMware"),
        ("08:00:27:aa:bb:cc", "VirtualBox"),
        ("00:15:5d:01:02:03", "Hyper-V"),
        ("02:42:ac:11:00:02", "Docker"),
        ("00:16:3e:01:02:03", "Xen"),
        ("aa:bb:cc:00:01:00", None),  # locally administered, but no known platform
        ("52:54:01:12:34:56", None),
        ("b8:27:eb:11:22:33", None),
    ],
)
def test_lookup_virtualization(mac, platform):
    assert discovery.lookup_virtualization(mac) == platform
