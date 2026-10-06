"""Scanner tests. Nmap is mocked with sample XML, so no root or lab is needed."""

import subprocess
from ipaddress import IPv4Network
from unittest.mock import MagicMock, patch

import pytest

from app.engine import discovery, scanner

ALLOWED = [IPv4Network("192.168.17.0/24")]

# Trimmed from a real scan of the lab: the switch, a Linux web server with a
# closed port, and a host that hit --host-timeout.
NMAP_XML = """<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE nmaprun>
<nmaprun scanner="nmap" args="nmap -sT -sV" version="7.94SVN" xmloutputversion="1.05">
<host starttime="1791315192" endtime="1791315193"><status state="up" reason="user-set"/>
<address addr="192.168.17.10" addrtype="ipv4"/>
<address addr="AA:BB:CC:00:01:00" addrtype="mac"/>
<ports><extraports state="closed" count="99"/>
<port protocol="tcp" portid="22"><state state="open" reason="syn-ack"/><service name="ssh" product="Cisco SSH" version="1.25" extrainfo="protocol 2.0" ostype="IOS" method="probed" conf="10"><cpe>cpe:/o:cisco:ios</cpe></service></port>
</ports>
</host>
<host><status state="up" reason="user-set"/>
<address addr="192.168.17.50" addrtype="ipv4"/>
<ports>
<port protocol="tcp" portid="22"><state state="open" reason="syn-ack"/><service name="ssh" product="OpenSSH" version="9.6p1 Ubuntu 3ubuntu13" extrainfo="Ubuntu Linux; protocol 2.0" ostype="Linux" method="probed" conf="10"/></port>
<port protocol="tcp" portid="80"><state state="open" reason="syn-ack"/><service name="http" product="nginx" version="1.24.0" method="probed" conf="10"/></port>
<port protocol="tcp" portid="443"><state state="closed" reason="conn-refused"/><service name="https" method="table" conf="3"/></port>
<port protocol="tcp" portid="8080"><state state="open" reason="syn-ack"/></port>
</ports>
</host>
<host timedout="true"><status state="up" reason="user-set"/>
<address addr="192.168.17.60" addrtype="ipv4"/>
</host>
<runstats><finished exit="success"/></runstats>
</nmaprun>
"""


@pytest.fixture
def nmap():
    """Replace the Nmap subprocess with one that returns the sample XML."""
    with patch("app.engine.scanner.subprocess.run") as run:
        run.return_value = MagicMock(returncode=0, stdout=NMAP_XML, stderr="")
        yield run


# --- parse_nmap_xml() ------------------------------------------------------


def test_parse_returns_service_details_for_open_ports():
    switch = scanner.parse_nmap_xml(NMAP_XML)[0]

    assert switch == {
        "ip": "192.168.17.10",
        "timed_out": False,
        "ports": [
            {
                "port": 22,
                "protocol": "tcp",
                "service": "ssh",
                "product": "Cisco SSH",
                "version": "1.25",
                "extra_info": "protocol 2.0",
                "os_type": "IOS",
            }
        ],
    }


def test_parse_skips_closed_ports():
    server = scanner.parse_nmap_xml(NMAP_XML)[1]

    assert [port["port"] for port in server["ports"]] == [22, 80, 8080]


def test_parse_open_port_with_no_identified_service():
    port = scanner.parse_nmap_xml(NMAP_XML)[1]["ports"][2]

    assert port["port"] == 8080
    assert port["service"] == port["product"] == port["version"] == ""


def test_parse_marks_a_host_that_timed_out():
    slow = scanner.parse_nmap_xml(NMAP_XML)[2]

    assert slow == {"ip": "192.168.17.60", "ports": [], "timed_out": True}


# --- scan_hosts() ----------------------------------------------------------


def test_scan_hosts_returns_one_entry_per_ip_in_the_order_given(nmap):
    # .99 is not in the XML at all: it still gets an (empty) entry.
    ips = ["192.168.17.99", "192.168.17.50", "192.168.17.10"]

    hosts = scanner.scan_hosts(ips, allowed=ALLOWED)

    assert [host["ip"] for host in hosts] == ips
    assert hosts[0] == {"ip": "192.168.17.99", "ports": [], "timed_out": False}
    assert hosts[2]["ports"][0]["product"] == "Cisco SSH"


def test_scan_hosts_builds_the_nmap_command(nmap):
    scanner.scan_hosts(["192.168.17.10"], top_ports=50, host_timeout=20, allowed=ALLOWED)

    command = nmap.call_args.args[0]
    assert command[0] == "nmap"
    assert "-sV" in command
    assert "-Pn" in command
    assert command[command.index("--top-ports") + 1] == "50"
    assert command[command.index("--host-timeout") + 1] == "20s"
    assert command[command.index("-oX") + 1] == "-"
    assert command[-1] == "192.168.17.10"
    # A hard limit on the whole subprocess, on top of Nmap's own per-host one.
    assert nmap.call_args.kwargs["timeout"] == 50


@pytest.mark.parametrize("euid, scan_type", [(0, "-sS"), (1000, "-sT")])
def test_scan_hosts_uses_syn_scan_only_as_root(nmap, euid, scan_type):
    with patch("app.engine.scanner.os.geteuid", return_value=euid):
        scanner.scan_hosts(["192.168.17.10"], allowed=ALLOWED)

    assert scan_type in nmap.call_args.args[0]


@pytest.mark.parametrize("ip", ["192.168.44.2", "8.8.8.8", "192.168.18.1"])
def test_scan_hosts_refuses_ips_outside_allowed_subnets(nmap, ip):
    # One bad address refuses the whole scan, including the allowed host.
    with pytest.raises(discovery.SubnetNotAllowedError, match="ALLOWED_SUBNETS"):
        scanner.scan_hosts(["192.168.17.10", ip], allowed=ALLOWED)

    nmap.assert_not_called()


def test_scan_hosts_uses_allowed_subnets_from_settings_by_default(nmap):
    settings = MagicMock(allowed_subnets=ALLOWED)
    with patch("app.engine.discovery.get_settings", return_value=settings):
        with pytest.raises(discovery.SubnetNotAllowedError):
            scanner.scan_hosts(["192.168.44.2"])


@pytest.mark.parametrize("target", ["192.168.17.0/24", "-iL", "192.168.17.1-50", "switch.lab"])
def test_scan_hosts_rejects_anything_that_is_not_a_single_ip(nmap, target):
    with pytest.raises(ValueError):
        scanner.scan_hosts([target], allowed=ALLOWED)

    nmap.assert_not_called()


def test_scan_hosts_with_no_ips_does_not_run_nmap(nmap):
    assert scanner.scan_hosts([], allowed=ALLOWED) == []

    nmap.assert_not_called()


def test_scan_hosts_nmap_not_installed(nmap):
    nmap.side_effect = FileNotFoundError()

    with pytest.raises(scanner.ScannerError, match="not installed"):
        scanner.scan_hosts(["192.168.17.10"], allowed=ALLOWED)


def test_scan_hosts_nmap_hangs(nmap):
    nmap.side_effect = subprocess.TimeoutExpired(cmd="nmap", timeout=90)

    with pytest.raises(scanner.ScannerError, match="did not finish within 90s"):
        scanner.scan_hosts(["192.168.17.10"], allowed=ALLOWED)


def test_scan_hosts_nmap_fails(nmap):
    nmap.return_value = MagicMock(returncode=1, stdout="", stderr="You requested a scan type which requires root privileges.\n")

    with pytest.raises(scanner.ScannerError, match="requires root"):
        scanner.scan_hosts(["192.168.17.10"], allowed=ALLOWED)


def test_scan_hosts_bad_xml(nmap):
    nmap.return_value = MagicMock(returncode=0, stdout="<nmaprun><host>", stderr="")

    with pytest.raises(scanner.ScannerError, match="parse"):
        scanner.scan_hosts(["192.168.17.10"], allowed=ALLOWED)
