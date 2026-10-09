"""Topology builder tests: plain dicts in, nodes and links out. No lab, no database."""

import copy

import pytest

from app.engine import collector, topology
from app.engine.topology import build_topology
from tests.lab import HOSTS, FakeDevice

# --- small hand-built networks ---------------------------------------------


def cdp(local, neighbor, remote, mgmt=""):
    return {
        "local_interface": local,
        "neighbor_name": neighbor,
        "neighbor_interface": remote,
        "mgmt_address": mgmt,
        "platform": "Cisco ",
        "capabilities": "Router Switch IGMP",
    }


def mac(address, port, vlan="20"):
    return {"destination_address": address, "type": "DYNAMIC", "vlan_id": vlan, "destination_port": [port]}


def interface(name, ip="unassigned", up=True):
    state = "up" if up else "down"
    return {"interface": name, "ip_address": ip, "status": state, "proto": state}


def trunk(name, vlans="20,30", forwarding=None):
    return {
        "interface": name,
        "mode": "on",
        "encapsulation": "802.1q",
        "status": "trunking",
        "native_vlan": "1",
        "allowed_vlans": vlans,
        "active_vlans": vlans,
        "forwarding_vlans": vlans if forwarding is None else forwarding,
    }


def stp(vlan, port, role="Desg", status="FWD"):
    return {"vlan_id": str(vlan), "interface": port, "role": role, "status": status}


def vlan(number, name, ports=()):
    return {"vlan_id": str(number), "vlan_name": name, "status": "active", "interfaces": list(ports)}


def arp(ip, address, port, own=False):
    return {"ip_address": ip, "mac_address": address, "age": "-" if own else "5", "interface": port}


def device(name, host, kind, device_id=None, status="success", **data):
    """One device of a collection run, as build_topology() receives it."""
    data.setdefault("interfaces", [])
    if name:
        data["version"] = [{"hostname": name}]
    return {"device_id": device_id, "host": host, "status": status, "device_type": kind, "data": data}


def switch(name, host, **data):
    """A switch managed through an SVI in VLAN 10, with Et0/0 as its management port."""
    data["interfaces"] = [interface("Ethernet0/0"), interface("Vlan10", host), *data.get("interfaces", [])]
    data["vlans"] = [vlan(10, "MGMT", ["Et0/0"]), *data.get("vlans", [])]
    return device(name, host, "switch", **data)


def link_between(result, node_a, node_b):
    return [l for l in result["links"] if {l["a"]["node"], l["b"]["node"]} == {node_a, node_b}]


def node(result, node_id):
    return next(n for n in result["nodes"] if n["id"] == node_id)


# --- links from CDP --------------------------------------------------------


def test_a_link_seen_from_both_ends_is_one_link():
    sw1 = switch("SW1", "192.168.17.10", cdp_neighbors=[cdp("Ethernet0/2", "SW2.netsense.local", "Ethernet0/1")])
    sw2 = switch("SW2", "192.168.17.11", cdp_neighbors=[cdp("Ethernet0/1", "SW1", "Ethernet0/2")])

    result = build_topology([sw1, sw2])

    assert len(result["links"]) == 1
    link = result["links"][0]
    assert link["a"] == {"node": "dev:sw1", "interface": "Et0/2"}
    assert link["b"] == {"node": "dev:sw2", "interface": "Et0/1"}
    assert link["seen_from"] == ["dev:sw1", "dev:sw2"]
    assert link["kind"] == "cdp"
    assert [n["id"] for n in result["nodes"]] == ["dev:sw1", "dev:sw2"]


def test_parallel_links_between_the_same_two_devices_stay_separate():
    sw1 = switch(
        "SW1",
        "192.168.17.10",
        cdp_neighbors=[cdp("Ethernet0/2", "SW2", "Ethernet0/1"), cdp("Ethernet0/3", "SW2", "Ethernet0/2")],
    )
    sw2 = switch(
        "SW2",
        "192.168.17.11",
        cdp_neighbors=[cdp("Ethernet0/2", "SW1", "Ethernet0/3"), cdp("Ethernet0/1", "SW1", "Ethernet0/2")],
    )

    links = link_between(build_topology([sw1, sw2]), "dev:sw1", "dev:sw2")

    assert [(l["a"]["interface"], l["b"]["interface"]) for l in links] == [("Et0/2", "Et0/1"), ("Et0/3", "Et0/2")]
    assert len({l["id"] for l in links}) == 2
    assert all(l["seen_from"] == ["dev:sw1", "dev:sw2"] for l in links)


def test_a_link_reported_by_one_end_only_is_still_a_link():
    # SW2 has CDP switched off, or did not answer in time.
    sw1 = switch("SW1", "192.168.17.10", cdp_neighbors=[cdp("Ethernet0/2", "SW2", "Ethernet0/1")])
    sw2 = switch("SW2", "192.168.17.11", cdp_neighbors=[])

    result = build_topology([sw1, sw2])

    assert len(result["links"]) == 1
    assert result["links"][0]["seen_from"] == ["dev:sw1"]


def test_cdp_neighbor_that_was_not_collected_is_an_unknown_node():
    sw1 = switch("SW1", "192.168.17.10", cdp_neighbors=[cdp("Ethernet0/3", "CORE9.example.net", "GigabitEthernet1/0/24", mgmt="10.9.9.9")])

    result = build_topology([sw1])

    unknown = node(result, "nbr:core9")
    assert (unknown["kind"], unknown["name"], unknown["ip"]) == ("unknown", "CORE9", "10.9.9.9")
    assert unknown["device_id"] is None and unknown["collected"] is False
    assert unknown["platform"] == "Cisco Router Switch IGMP"
    link = result["links"][0]
    assert link["a"] == {"node": "dev:sw1", "interface": "Et0/3"}
    assert link["b"] == {"node": "nbr:core9", "interface": "Gi1/0/24"}
    assert link["seen_from"] == ["dev:sw1"]


def test_a_device_whose_login_failed_is_matched_by_its_known_hostname():
    # R2 is in the inventory, but this run could not log in to it. R1 still
    # sees it in CDP. The address CDP gives (10.0.12.2) is R2's address on
    # that link, not its management address, so the name has to match.
    r1 = device("R1", "192.168.17.3", "router", cdp_neighbors=[cdp("GigabitEthernet0/2", "R2.netsense.local", "GigabitEthernet0/1", mgmt="10.0.12.2")])
    r2 = device(None, "192.168.17.4", "router", device_id=8, status="failed")
    r2["hostname"] = "R2"  # remembered from an earlier collection

    result = build_topology([r1, r2])

    assert [n["id"] for n in result["nodes"]] == ["dev:r1", "dev:r2"]
    failed = node(result, "dev:r2")
    assert (failed["kind"], failed["name"], failed["device_id"], failed["collected"]) == ("router", "R2", 8, False)
    assert result["links"][0]["b"] == {"node": "dev:r2", "interface": "Gi0/1"}
    assert result["links"][0]["seen_from"] == ["dev:r1"]


def test_a_failed_device_never_seen_before_cannot_be_matched_to_its_cdp_entry():
    # Without a remembered name there is nothing to connect 192.168.17.4 with
    # the CDP neighbour "R2": both are shown, and the next successful
    # collection joins them.
    r1 = device("R1", "192.168.17.3", "router", cdp_neighbors=[cdp("GigabitEthernet0/2", "R2", "GigabitEthernet0/1", mgmt="10.0.12.2")])
    r2 = device(None, "192.168.17.4", "router", device_id=8, status="failed")

    result = build_topology([r1, r2])

    assert [(n["id"], n["kind"]) for n in result["nodes"]] == [
        ("dev:192.168.17.4", "router"),
        ("dev:r1", "router"),
        ("nbr:r2", "unknown"),
    ]


def test_a_device_can_also_be_matched_by_an_address_cdp_reports():
    # Switches here are managed in-band enough that CDP reports the same
    # address NetSense uses, so even a nameless failed switch is matched.
    sw1 = switch("SW1", "192.168.17.10", cdp_neighbors=[cdp("Ethernet0/2", "SW2", "Ethernet0/1", mgmt="192.168.17.11")])
    sw2 = device(None, "192.168.17.11", "switch", device_id=9, status="failed")

    result = build_topology([sw1, sw2])

    assert [n["id"] for n in result["nodes"]] == ["dev:192.168.17.11", "dev:sw1"]
    assert node(result, "dev:192.168.17.11")["name"] == "SW2"


# --- hosts from MAC address tables -----------------------------------------


def lab_edge():
    """SW2 with a trunk to SW1 on Et0/1, an access port Et0/3 in VLAN 20, and R1 routing VLAN 20."""
    r1 = device(
        "R1",
        "192.168.17.3",
        "router",
        interfaces=[interface("GigabitEthernet0/0", "192.168.17.3"), interface("GigabitEthernet0/1.20", "10.1.20.1")],
        arp=[
            arp("10.1.20.1", "5254.00a5.3c53", "GigabitEthernet0/1.20", own=True),
            arp("10.1.20.10", "5254.0068.dd64", "GigabitEthernet0/1.20"),
        ],
    )
    sw2 = switch(
        "SW2",
        "192.168.17.11",
        interfaces=[interface("Ethernet0/1"), interface("Ethernet0/3")],
        cdp_neighbors=[cdp("Ethernet0/1", "SW1", "Ethernet0/2", mgmt="192.168.17.10")],
        trunks=[trunk("Et0/1")],
        vlans=[vlan(20, "USERS", ["Et0/3"]), vlan(30, "SERVERS")],
        spanning_tree=[stp(20, "Et0/1", "Root"), stp(20, "Et0/3")],
        mac_table=[],
    )
    return r1, sw2


def test_a_mac_on_an_access_port_is_a_host_on_that_port():
    r1, sw2 = lab_edge()
    sw2["data"]["mac_table"] = [mac("5254.0068.dd64", "Et0/3", vlan="20")]
    scanned = [{"device_id": 4, "ip": "192.168.17.129", "mac": "52:54:00:68:DD:64", "vendor": "QEMU/KVM", "device_type": "Linux/Unix host", "virtualization": "QEMU/KVM"}]

    result = build_topology([r1, sw2], known_hosts=scanned)

    host = node(result, "host:52:54:00:68:dd:64")
    assert host["kind"] == "host"
    assert host["ip"] == "10.1.20.10"  # from R1's ARP table, preferred over the scan
    assert host["name"] == "10.1.20.10"
    assert host["mac"] == "52:54:00:68:dd:64"
    # What a scan knows about that MAC fills in the rest.
    assert (host["device_id"], host["vendor"], host["platform"], host["virtualization"]) == (4, "QEMU/KVM", "Linux/Unix host", "QEMU/KVM")
    (link,) = link_between(result, "dev:sw2", "host:52:54:00:68:dd:64")
    assert link["a"] == {"node": "dev:sw2", "interface": "Et0/3"}
    assert link["b"] == {"node": "host:52:54:00:68:dd:64", "interface": None}
    assert (link["kind"], link["mode"], link["vlans"], link["status"]) == ("host", "access", [20], "up")
    assert link["stp"] == [{"vlan": 20, "state": "forwarding", "blocked_at": None, "roles": {"dev:sw2": "Desg"}}]


def test_host_without_arp_or_scan_data_is_named_by_its_mac_and_vendor():
    _, sw2 = lab_edge()
    sw2["data"]["mac_table"] = [mac("b827.eb11.2233", "Et0/3")]

    host = node(build_topology([sw2]), "host:b8:27:eb:11:22:33")

    assert (host["name"], host["ip"], host["device_id"]) == ("b8:27:eb:11:22:33", None, None)
    assert host["vendor"] == "Raspberry Pi Foundation"  # looked up offline from the OUI


def test_macs_learned_on_trunks_are_not_hosts():
    r1, sw2 = lab_edge()
    # The same host as SW1 would see it: through the trunk towards SW2.
    sw2["data"]["mac_table"] = [
        mac("5254.0068.dd64", "Et0/1", vlan="20"),
        mac("aabb.cc00.0120", "Et0/1", vlan="30"),
    ]

    result = build_topology([r1, sw2])

    assert not [n for n in result["nodes"] if n["kind"] == "host"]
    assert not [l for l in result["links"] if l["kind"] == "host"]


def test_macs_on_a_port_with_a_cdp_neighbor_are_not_hosts():
    # An access port (not a trunk) that leads to a router: the router is the
    # neighbour, and MACs behind it are not plugged into this switch.
    _, sw2 = lab_edge()
    sw2["data"]["trunks"] = []
    sw2["data"]["mac_table"] = [mac("5254.0095.4d8f", "Et0/1")]

    result = build_topology([sw2])

    assert not [n for n in result["nodes"] if n["kind"] == "host"]


def test_macs_in_the_management_vlan_and_internal_ports_are_not_hosts():
    r1, sw2 = lab_edge()
    sw2["data"]["mac_table"] = [
        mac("000c.2923.56f6", "Et0/0", vlan="10"),  # the NetSense machine, on the management port
        mac("5254.0012.3367", "Et0/0", vlan="10"),
        mac("aabb.cc80.0200", "CPU", vlan="20"),  # the switch's own address
        mac("5254.00a5.3c53", "Et0/3", vlan="20"),  # R1's own interface address
    ]

    result = build_topology([r1, sw2])

    assert not [n for n in result["nodes"] if n["kind"] == "host"]


def test_one_mac_in_two_vlans_on_a_port_is_one_host_and_one_link():
    _, sw2 = lab_edge()
    sw2["data"]["mac_table"] = [mac("5254.0068.dd64", "Et0/3", vlan="20"), mac("5254.0068.dd64", "Et0/3", vlan="30")]

    result = build_topology([sw2])

    assert len([n for n in result["nodes"] if n["kind"] == "host"]) == 1
    assert len([l for l in result["links"] if l["kind"] == "host"]) == 1


def test_host_known_from_arp_but_in_no_mac_table_is_reported_as_unplaced_not_guessed():
    # The host has been silent for more than five minutes: SW2 has aged its
    # MAC out, R1 still has the ARP entry.
    r1, sw2 = lab_edge()
    r1["data"]["arp"] += [
        arp("192.168.17.132", "000c.2923.56f6", "GigabitEthernet0/0"),  # management network
        arp("10.0.12.2", "5254.0095.4d8f", "GigabitEthernet0/2"),  # R2, a CDP neighbour
    ]
    r1["data"]["cdp_neighbors"] = [cdp("GigabitEthernet0/2", "R2", "GigabitEthernet0/1", mgmt="10.0.12.2")]

    result = build_topology([r1, sw2])

    assert not [n for n in result["nodes"] if n["kind"] == "host"]
    assert result["unplaced_hosts"] == [
        {"ip": "10.1.20.10", "mac": "52:54:00:68:dd:64", "vendor": "QEMU/KVM", "seen_by": "dev:r1", "interface": "Gi0/1.20"}
    ]


def test_a_host_that_is_on_the_map_is_not_also_listed_as_unplaced():
    r1, sw2 = lab_edge()
    sw2["data"]["mac_table"] = [mac("5254.0068.dd64", "Et0/3")]

    result = build_topology([r1, sw2])

    assert [n["id"] for n in result["nodes"] if n["kind"] == "host"] == ["host:52:54:00:68:dd:64"]
    assert result["unplaced_hosts"] == []


# --- what is attached to a link --------------------------------------------


def two_switches(sw2_stp_status="FWD", sw1_port_up=True):
    sw1 = switch(
        "SW1",
        "192.168.17.10",
        interfaces=[interface("Ethernet0/3", up=sw1_port_up)],
        cdp_neighbors=[cdp("Ethernet0/3", "SW2", "Ethernet0/2")],
        trunks=[trunk("Et0/3", "20,30")],
        vlans=[vlan(20, "USERS"), vlan(30, "SERVERS")],
        spanning_tree=[stp(20, "Et0/3"), stp(30, "Et0/3")],
    )
    role = "Altn" if sw2_stp_status == "BLK" else "Root"
    sw2 = switch(
        "SW2",
        "192.168.17.11",
        interfaces=[interface("Ethernet0/2")],
        cdp_neighbors=[cdp("Ethernet0/2", "SW1", "Ethernet0/3")],
        trunks=[trunk("Et0/2", "20,30")],
        spanning_tree=[stp(20, "Et0/2", role, sw2_stp_status), stp(30, "Et0/2", "Root", "FWD")],
    )
    return sw1, sw2


def test_trunk_link_carries_its_vlans_and_per_vlan_spanning_tree_state():
    (link,) = build_topology(list(two_switches(sw2_stp_status="BLK")))["links"]

    assert (link["mode"], link["vlans"], link["status"]) == ("trunk", [20, 30], "up")
    assert link["stp_blocked"] is True
    by_vlan = {entry["vlan"]: entry for entry in link["stp"]}
    # Blocked for VLAN 20 at SW2's end only; VLAN 30 forwards on the same cable.
    assert by_vlan[20] == {"vlan": 20, "state": "blocking", "blocked_at": "dev:sw2", "roles": {"dev:sw1": "Desg", "dev:sw2": "Altn"}}
    assert (by_vlan[30]["state"], by_vlan[30]["blocked_at"]) == ("forwarding", None)


def test_forwarding_link_is_not_marked_blocked():
    (link,) = build_topology(list(two_switches()))["links"]

    assert link["stp_blocked"] is False
    assert {entry["state"] for entry in link["stp"]} == {"forwarding"}


def test_link_is_down_when_either_end_reports_its_interface_down():
    (link,) = build_topology(list(two_switches(sw1_port_up=False)))["links"]

    assert link["status"] == "down"


def test_link_status_is_unknown_when_neither_end_was_collected():
    sw1 = switch("SW1", "192.168.17.10", cdp_neighbors=[cdp("Ethernet0/9", "X1", "Ethernet0/1")])

    assert build_topology([sw1])["links"][0]["status"] == "unknown"


def routers(r1_state="FULL/DR", r2_address="10.0.12.2"):
    r1 = device(
        "R1",
        "192.168.17.3",
        "router",
        interfaces=[interface("GigabitEthernet0/0", "192.168.17.3"), interface("GigabitEthernet0/2", "10.0.12.1")],
        cdp_neighbors=[cdp("GigabitEthernet0/2", "R2.netsense.local", "GigabitEthernet0/1")],
        ospf_neighbors=[{"neighbor_id": "2.2.2.2", "state": r1_state, "ip_address": "10.0.12.2", "interface": "GigabitEthernet0/2"}],
    )
    r2 = device(
        "R2",
        "192.168.17.4",
        "router",
        interfaces=[interface("GigabitEthernet0/0", "192.168.17.4"), interface("GigabitEthernet0/1", r2_address)],
        cdp_neighbors=[cdp("GigabitEthernet0/1", "R1", "GigabitEthernet0/2")],
    )
    return r1, r2


def test_link_between_ospf_neighbors_is_marked():
    (link,) = build_topology(list(routers()))["links"]

    assert (link["mode"], link["vlans"], link["stp"]) == ("routed", [], [])
    assert (link["ospf"], link["ospf_state"]) == (True, "FULL")


def test_ospf_adjacency_that_is_not_full_is_reported_but_not_marked():
    (link,) = build_topology(list(routers(r1_state="EXSTART/DR")))["links"]

    assert (link["ospf"], link["ospf_state"]) == (False, "EXSTART")


def test_ospf_neighbor_on_the_same_interface_but_another_device_does_not_mark_the_link():
    # R1 has an adjacency on Gi0/2 with 10.0.12.2, but the CDP neighbour on
    # that port has a different address: a third router on a shared segment.
    (link,) = build_topology(list(routers(r2_address="10.0.12.9")))["links"]

    assert (link["ospf"], link["ospf_state"]) == (False, None)


# --- management network and VLAN list --------------------------------------


def test_management_network_is_a_separate_view_not_part_of_the_topology():
    r1, sw2 = lab_edge()
    sw2["data"]["mac_table"] = [mac("000c.2923.56f6", "Et0/0", vlan="10")]
    scanned = [
        {"device_id": 9, "ip": "192.168.17.132", "mac": "00:0c:29:23:56:f6", "vendor": "VMware, Inc.", "device_type": "unknown", "virtualization": "VMware"},
        {"device_id": 2, "ip": "192.168.17.11", "mac": "aa:bb:cc:80:02:00", "vendor": "Locally administered", "device_type": "switch", "virtualization": None},
    ]

    result = build_topology([r1, sw2], known_hosts=scanned, management_network="192.168.17.0/24")

    management = result["management"]
    assert management["network"] == "192.168.17.0/24"
    assert management["members"] == [
        {"node": "dev:r1", "ip": "192.168.17.3", "interface": "Gi0/0", "vlan": None},
        {"node": "dev:sw2", "ip": "192.168.17.11", "interface": "Et0/0", "vlan": 10},
    ]
    # Other machines on that network, known from the scan. SW2 itself is not repeated.
    assert [(h["ip"], h["vendor"]) for h in management["hosts"]] == [("192.168.17.132", "VMware, Inc.")]
    # None of it leaks into the data topology.
    assert "host:00:0c:29:23:56:f6" not in [n["id"] for n in result["nodes"]]
    assert all("Et0/0" not in (l["a"]["interface"], l["b"]["interface"]) for l in result["links"])


def test_vlan_list_holds_the_vlans_carried_on_links_with_their_names():
    r1, sw2 = lab_edge()

    result = build_topology([r1, sw2])

    # VLAN 10 (management) and unused defaults are not on any link.
    assert result["vlans"] == [{"id": 20, "name": "USERS"}, {"id": 30, "name": "SERVERS"}]


# --- robustness ------------------------------------------------------------


def test_output_does_not_depend_on_the_order_devices_were_collected_in():
    sw1, sw2 = two_switches(sw2_stp_status="BLK")
    r1, r2 = routers()

    forwards = build_topology([sw1, sw2, r1, r2])
    backwards = build_topology([r2, r1, sw2, sw1])

    assert forwards == backwards
    assert [n["id"] for n in forwards["nodes"]] == ["dev:r1", "dev:r2", "dev:sw1", "dev:sw2"]


def test_tables_kept_as_raw_text_are_treated_as_missing_not_as_an_error():
    sw1 = switch("SW1", "192.168.17.10")
    sw1["data"].update(cdp_neighbors="% CDP is not enabled", mac_table="raw text", trunks="raw", spanning_tree="raw", arp="raw")

    result = build_topology([sw1, device(None, "192.168.17.4", "router", status="failed")])

    assert [n["id"] for n in result["nodes"]] == ["dev:192.168.17.4", "dev:sw1"]
    assert result["links"] == []


def test_empty_collection_gives_an_empty_topology():
    assert build_topology([]) == {
        "version": 1,
        "nodes": [],
        "links": [],
        "vlans": [],
        "unplaced_hosts": [],
        "management": {"network": None, "members": [], "hosts": []},
    }


@pytest.mark.parametrize(
    "name, short",
    [
        ("GigabitEthernet0/1", "Gi0/1"),
        ("Gi0/1", "Gi0/1"),
        ("GigabitEthernet0/1.20", "Gi0/1.20"),
        ("Ethernet0/3", "Et0/3"),
        ("TenGigabitEthernet1/0/1", "Te1/0/1"),
        ("FastEthernet0/24", "Fa0/24"),
        ("Port-channel1", "Po1"),
        ("Vlan10", "Vl10"),
        ("Loopback1", "Lo1"),
    ],
)
def test_short_interface(name, short):
    assert topology.short_interface(name) == short


def test_helpers():
    assert topology.normalize_mac("5254.0068.DD64") == "52:54:00:68:dd:64"
    assert topology.normalize_mac("52-54-00-68-dd-64") == "52:54:00:68:dd:64"
    assert topology.parse_vlan_list("1-3,20,30") == [1, 2, 3, 20, 30]
    assert topology.parse_vlan_list("none") == []


# --- the recorded lab ------------------------------------------------------


@pytest.fixture(scope="module")
def lab_collection():
    collected = []
    for index, name in enumerate(("R1", "R2", "SW1", "SW2"), start=1):
        outcome = collector.collect_device(FakeDevice(name))
        collected.append({"device_id": index, "host": HOSTS[name], "status": "success", "device_type": outcome.device_type, "data": outcome.data})
    return collected


def test_recorded_lab_gives_the_real_topology(lab_collection):
    result = build_topology(copy.deepcopy(lab_collection), management_network="192.168.17.0/24")

    assert [(n["id"], n["kind"]) for n in result["nodes"]] == [
        ("dev:r1", "router"),
        ("dev:r2", "router"),
        ("dev:sw1", "switch"),
        ("dev:sw2", "switch"),
    ]
    summary = [
        (l["a"]["node"], l["a"]["interface"], l["b"]["node"], l["b"]["interface"], l["mode"], l["stp_blocked"], l["ospf"])
        for l in result["links"]
    ]
    assert summary == [
        ("dev:r1", "Gi0/1", "dev:sw1", "Et0/1", "trunk", False, False),
        ("dev:r1", "Gi0/2", "dev:r2", "Gi0/1", "routed", False, True),
        ("dev:sw1", "Et0/2", "dev:sw2", "Et0/1", "trunk", False, False),
        # The second SW1-SW2 cable: spanning tree blocks it at SW2.
        ("dev:sw1", "Et0/3", "dev:sw2", "Et0/2", "trunk", True, False),
    ]
    assert all(l["seen_from"] == sorted([l["a"]["node"], l["b"]["node"]]) for l in result["links"])
    assert all(l["status"] == "up" for l in result["links"])
    blocked = result["links"][3]
    assert {entry["vlan"]: (entry["state"], entry["blocked_at"]) for entry in blocked["stp"]} == {
        20: ("blocking", "dev:sw2"),
        30: ("blocking", "dev:sw2"),
    }
    assert result["vlans"] == [{"id": 20, "name": "USERS"}, {"id": 30, "name": "SERVERS"}]
    assert [m["interface"] for m in result["management"]["members"]] == ["Gi0/0", "Gi0/0", "Et0/0", "Et0/0"]
    # The Alpine host was silent when the lab was recorded: known to R1's ARP
    # table only, so it is reported rather than drawn.
    assert [(h["ip"], h["seen_by"], h["interface"]) for h in result["unplaced_hosts"]] == [("10.1.20.10", "dev:r1", "Gi0/1.20")]


def test_recorded_lab_with_the_host_talking(lab_collection):
    # In the recording the Alpine host had been silent for over five minutes,
    # so SW2 had aged its MAC out. This is the table while the host is active.
    collected = copy.deepcopy(lab_collection)
    collected[3]["data"]["mac_table"].append(mac("5254.0068.dd64", "Et0/3", vlan="20"))

    result = build_topology(collected)

    host = node(result, "host:52:54:00:68:dd:64")
    assert (host["ip"], host["vendor"], host["virtualization"]) == ("10.1.20.10", "QEMU/KVM", "QEMU/KVM")
    (link,) = link_between(result, "dev:sw2", host["id"])
    assert (link["a"]["interface"], link["mode"], link["vlans"]) == ("Et0/3", "access", [20])
