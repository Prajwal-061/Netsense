"""Collector tests against the recorded output of the four lab devices."""

import paramiko
import pytest
from netmiko.exceptions import NetmikoTimeoutException

from app.engine import classifier, collector
from tests.lab import FakeDevice, fake_lab

COMMON = {"version", "interfaces", "cdp_neighbors", "arp"}
SWITCH_ONLY = {"vlans", "trunks", "spanning_tree", "mac_table"}
ROUTER_ONLY = {"routes", "ospf_neighbors", "ospf_interfaces"}

# --- SSH to old devices ----------------------------------------------------


def test_paramiko_can_still_talk_to_iosv_routers():
    # IOSv offers only these. Paramiko 4+ removed them, so this fails if the
    # pin in requirements.txt is ever lifted without replacing the routers.
    assert "diffie-hellman-group14-sha1" in paramiko.Transport._kex_info
    assert "ssh-rsa" in paramiko.Transport._key_info


def test_ssh_negotiation_failure_is_reported_as_such_not_as_a_timeout():
    error = NetmikoTimeoutException(
        "A paramiko SSHException occurred during connection creation:\n\n"
        "Incompatible ssh peer (no acceptable kex algorithm)"
    )
    with (
        pytest.MonkeyPatch.context() as patcher,
        pytest.raises(collector.DeviceSshError, match="SSH negotiation failed: 192.168.17.3"),
    ):
        patcher.setattr(collector.socket, "create_connection", lambda *a, **k: FakeSocket())
        patcher.setattr(collector, "ConnectHandler", raising(error))
        collector.connect("192.168.17.3", "admin", "pw")


def test_a_real_ssh_timeout_is_still_a_timeout():
    with (
        pytest.MonkeyPatch.context() as patcher,
        pytest.raises(collector.DeviceTimeoutError, match="SSH session"),
    ):
        patcher.setattr(collector.socket, "create_connection", lambda *a, **k: FakeSocket())
        patcher.setattr(collector, "ConnectHandler", raising(NetmikoTimeoutException("timed out")))
        collector.connect("192.168.17.3", "admin", "pw")


class FakeSocket:
    def close(self):
        pass


def raising(error):
    def handler(**kwargs):
        raise error

    return handler


# --- collect_device() ------------------------------------------------------


@pytest.mark.parametrize("name", ["R1", "R2"])
def test_iosv_router_is_collected_as_a_router(name):
    device = FakeDevice(name)

    result = collector.collect_device(device)

    assert result.device_type == classifier.ROUTER
    assert "VIOS-ADVENTERPRISEK9-M" in result.type_reason
    assert set(result.data) == COMMON | ROUTER_ONLY
    assert all(isinstance(rows, list) for rows in result.data.values())
    assert result.config.startswith("Building configuration")
    assert "legacy SSH (ssh-rsa host key, SHA-1)" in result.note
    # The one switch command a router is asked is the VLAN probe; the rest
    # of the switch commands are never sent.
    assert device.sent.count("show vlan brief") == 1
    assert not {"show interfaces trunk", "show spanning-tree", "show mac address-table"} & set(device.sent)
    assert all(command.startswith("show ") for command in device.sent)


@pytest.mark.parametrize("name", ["SW1", "SW2"])
def test_iol_switch_is_collected_as_a_switch(name):
    device = FakeDevice(name)

    result = collector.collect_device(device)

    assert result.device_type == classifier.SWITCH
    assert "X86_64BI_LINUX_L2-ADVENTERPRISEK9-M" in result.type_reason
    assert set(result.data) == COMMON | SWITCH_ONLY
    assert all(isinstance(rows, list) for rows in result.data.values())
    assert result.note is None  # modern SSH algorithms
    assert not {"show ip route", "show ip ospf neighbor"} & set(device.sent)
    assert len(device.sent) == len(set(device.sent))  # nothing asked twice


def test_router_data_describes_the_lab():
    data = collector.collect_device(FakeDevice("R1")).data

    assert data["version"][0]["hostname"] == "R1"
    neighbor = data["ospf_neighbors"][0]
    assert (neighbor["neighbor_id"], neighbor["ip_address"]) == ("2.2.2.2", "10.0.12.2")
    assert neighbor["state"].startswith("FULL")
    assert neighbor["interface"] == "GigabitEthernet0/2"
    # R2's loopback networks are learned through OSPF, via R2.
    ospf_routes = [route for route in data["routes"] if route["protocol"] == "O"]
    assert ospf_routes and {route["nexthop_ip"] for route in ospf_routes} == {"10.0.12.2"}
    assert {"10.1.20.1", "10.1.30.1"} <= {row["ip_address"] for row in data["interfaces"]}
    assert {row["interface"] for row in data["ospf_interfaces"]} >= {"Gi0/2"}
    # CDP sees the neighbours on the data links (it is off on management ports).
    assert {row["neighbor_name"].split(".")[0] for row in data["cdp_neighbors"]} == {"SW1", "R2"}


def test_switch_data_describes_the_lab():
    sw1 = collector.collect_device(FakeDevice("SW1")).data
    sw2 = collector.collect_device(FakeDevice("SW2")).data

    assert {"20": "USERS", "30": "SERVERS"}.items() <= {v["vlan_id"]: v["vlan_name"] for v in sw1["vlans"]}.items()
    assert [trunk["interface"] for trunk in sw1["trunks"]] == ["Et0/1", "Et0/2", "Et0/3"]
    assert all(trunk["status"] == "trunking" and trunk["allowed_vlans"] == "20,30" for trunk in sw1["trunks"])
    # SW1 is the root for the data VLANs: all its ports are designated and forwarding.
    assert {row["role"] for row in sw1["spanning_tree"] if row["vlan_id"] in ("20", "30")} == {"Desg"}
    # SW2 has two links to SW1, so spanning tree blocks one of them...
    sw2_roles = {(row["vlan_id"], row["interface"]): row["role"] for row in sw2["spanning_tree"]}
    assert sw2_roles[("20", "Et0/1")] == "Root"
    assert sw2_roles[("20", "Et0/2")] == "Altn"
    # ...which the trunk table shows as no VLANs forwarding on that port.
    blocked = next(trunk for trunk in sw2["trunks"] if trunk["interface"] == "Et0/2")
    assert (blocked["status"], blocked["forwarding_vlans"]) == ("trunking", "none")
    assert {row["neighbor_name"].split(".")[0] for row in sw1["cdp_neighbors"]} == {"R1", "SW2"}


def test_a_command_with_no_output_is_an_empty_table():
    device = FakeDevice("R1")
    device.outputs["show ip ospf neighbor"] = ""

    assert collector.collect_device(device).data["ospf_neighbors"] == []


def test_output_textfsm_cannot_parse_is_kept_as_raw_text():
    device = FakeDevice("SW1")
    device.outputs["show cdp neighbors detail"] = "% CDP is not enabled"

    assert collector.collect_device(device).data["cdp_neighbors"] == "% CDP is not enabled"


def test_layer3_image_with_a_vlan_table_is_still_a_switch():
    # A multilayer switch: nothing in its image name says "switch".
    device = FakeDevice("SW1")
    device.outputs["show version"] = [
        {"software_image": "CAT9K_IOSXE", "hostname": "CORE1", "running_image": "", "hardware": ["C9300-24T"]}
    ]

    result = collector.collect_device(device)

    assert result.device_type == classifier.SWITCH
    assert "show vlan brief lists" in result.type_reason
    assert device.sent.count("show vlan brief") == 1


# --- collect_host() --------------------------------------------------------


def test_collect_host_disconnects_after_success_and_after_failure():
    with fake_lab("SW1", "R1") as lab:
        collector.collect_host("192.168.17.10", "user", "pw")
        lab["R1"].outputs["show ip route"] = collector.ReadTimeout()
        with pytest.raises(collector.DeviceTimeoutError, match="show ip route"):
            collector.collect_host("192.168.17.3", "user", "pw")

    assert (lab["SW1"].disconnected, lab["R1"].disconnected) == (1, 1)


# --- parse_interfaces_trunk() ----------------------------------------------


def test_trunk_parser_joins_wrapped_vlan_lists():
    raw = (
        "\nPort        Mode             Encapsulation  Status        Native vlan\n"
        "Gi1/0/1     on               802.1q         trunking      99\n"
        "Po1         desirable        n-802.1q       trunking      1\n"
        "\nPort        Vlans allowed on trunk\n"
        "Gi1/0/1     1-100,200,300,400,500,600,700,800,900,1000,1100,1200,1300,\n"
        "            1400,1500\n"
        "Po1         1-4094\n"
        "\nPort        Vlans allowed and active in management domain\n"
        "Gi1/0/1     1,10,20\n"
        "Po1         1,10,20\n"
        "\nPort        Vlans in spanning tree forwarding state and not pruned\n"
        "Gi1/0/1     1,10,20\n"
        "Po1         none\n"
    )

    trunks = collector.parse_interfaces_trunk(raw)

    assert trunks == [
        {
            "interface": "Gi1/0/1",
            "mode": "on",
            "encapsulation": "802.1q",
            "status": "trunking",
            "native_vlan": "99",
            "allowed_vlans": "1-100,200,300,400,500,600,700,800,900,1000,1100,1200,1300,1400,1500",
            "active_vlans": "1,10,20",
            "forwarding_vlans": "1,10,20",
        },
        {
            "interface": "Po1",
            "mode": "desirable",
            "encapsulation": "n-802.1q",
            "status": "trunking",
            "native_vlan": "1",
            "allowed_vlans": "1-4094",
            "active_vlans": "1,10,20",
            "forwarding_vlans": "none",
        },
    ]


@pytest.mark.parametrize("raw", ["% Invalid input detected at '^' marker.", "something else entirely\nline two"])
def test_trunk_parser_returns_unrecognised_text_unchanged(raw):
    assert collector.parse_interfaces_trunk(raw) == raw


def test_switch_with_no_trunks_has_an_empty_trunk_table():
    device = FakeDevice("SW1")
    device.outputs["show interfaces trunk"] = "\n"

    assert collector.collect_device(device).data["trunks"] == []
