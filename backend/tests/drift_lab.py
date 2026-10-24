"""A healthy lab snapshot for drift tests, and helpers to break it in known ways.

The device data is the recorded output of the four lab devices (tests/lab.py),
the configs are shortened versions of their real running configs.
"""

import copy

from app.engine import collector, topology
from tests.lab import HOSTS, FakeDevice

HEADER = "Building configuration...\n\nCurrent configuration : {size} bytes\n!\n! Last configuration change at {when}\n!\n"

CONFIGS = {
    "R1": """version 15.9
hostname R1
!
enable secret 9 $9$fakeR1hash
!
interface GigabitEthernet0/0
 ip address 192.168.17.3 255.255.255.0
!
interface GigabitEthernet0/1
 no ip address
!
interface GigabitEthernet0/1.20
 encapsulation dot1Q 20
 ip address 10.1.20.1 255.255.255.0
!
interface GigabitEthernet0/1.30
 encapsulation dot1Q 30
 ip address 10.1.30.1 255.255.255.0
!
interface GigabitEthernet0/2
 description to-R2
 ip address 10.0.12.1 255.255.255.252
!
router ospf 1
 router-id 1.1.1.1
 passive-interface GigabitEthernet0/1.20
 passive-interface GigabitEthernet0/1.30
 network 10.0.12.0 0.0.0.3 area 0
 network 10.1.20.0 0.0.0.255 area 0
 network 10.1.30.0 0.0.0.255 area 0
!
end
""",
    "R2": """version 15.9
hostname R2
!
interface Loopback1
 ip address 10.2.1.1 255.255.255.0
 ip ospf network point-to-point
!
interface Loopback2
 ip address 10.2.2.1 255.255.255.0
 ip ospf network point-to-point
!
interface GigabitEthernet0/0
 ip address 192.168.17.4 255.255.255.0
!
interface GigabitEthernet0/1
 description to-R1
 ip address 10.0.12.2 255.255.255.252
!
router ospf 1
 router-id 2.2.2.2
 network 10.0.12.0 0.0.0.3 area 0
 network 10.2.0.0 0.0.255.255 area 0
!
end
""",
    "SW1": """version 17.18
hostname SW1
!
spanning-tree mode rapid-pvst
spanning-tree extend system-id
spanning-tree vlan 20,30 priority 4096
!
interface Ethernet0/0
 switchport access vlan 10
 switchport mode access
!
interface Ethernet0/1
 description to-R1
 switchport trunk encapsulation dot1q
 switchport trunk allowed vlan 20,30
 switchport mode trunk
!
interface Ethernet0/2
 description to-SW2
 switchport trunk encapsulation dot1q
 switchport trunk allowed vlan 20,30
 switchport mode trunk
!
interface Ethernet0/3
 description to-SW2
 switchport trunk encapsulation dot1q
 switchport trunk allowed vlan 20,30
 switchport mode trunk
!
interface Vlan10
 ip address 192.168.17.10 255.255.255.0
!
end
""",
    "SW2": """version 17.18
hostname SW2
!
spanning-tree mode rapid-pvst
spanning-tree extend system-id
!
snmp-server community fakeCommunity RO
!
interface Ethernet0/0
 switchport access vlan 10
 switchport mode access
!
interface Ethernet0/1
 switchport trunk encapsulation dot1q
 switchport trunk allowed vlan 20,30
 switchport mode trunk
!
interface Ethernet0/2
 switchport trunk encapsulation dot1q
 switchport trunk allowed vlan 20,30
 switchport mode trunk
!
interface Ethernet0/3
 description to-Alpine
 switchport access vlan 20
 switchport mode access
 spanning-tree portfast
!
interface Vlan10
 ip address 192.168.17.11 255.255.255.0
!
end
""",
}

DEVICE_IDS = {"R1": 7, "R2": 8, "SW1": 2, "SW2": 9}
_RECORDED = {name: collector.collect_device(FakeDevice(name)).data for name in HOSTS}


class Lab:
    """One state of the lab: per-device data and configs, editable."""

    def __init__(self, when="10:00:00 UTC Fri Oct 9 2026", size=3000):
        self.data = copy.deepcopy(_RECORDED)
        self.config = {name: HEADER.format(size=size, when=when) + text for name, text in CONFIGS.items()}
        self.failed: dict[str, str] = {}  # name -> error

    # --- editing helpers -----------------------------------------------------
    def rows(self, device, key):
        return self.data[device][key]

    def row(self, device, key, **match):
        return next(r for r in self.rows(device, key) if all(r.get(k) == v for k, v in match.items()))

    def drop(self, device, key, **match):
        self.data[device][key] = [r for r in self.rows(device, key) if not all(r.get(k) == v for k, v in match.items())]

    def edit_config(self, device, old, new):
        assert old in self.config[device], old
        self.config[device] = self.config[device].replace(old, new)

    # --- what the drift engine receives --------------------------------------
    def snapshot(self, collection_id):
        devices = []
        for name, host in HOSTS.items():
            ok = name not in self.failed
            devices.append(
                {
                    "device_id": DEVICE_IDS[name],
                    "host": host,
                    "name": name,
                    "status": "success" if ok else "failed",
                    "error": self.failed.get(name),
                    "data": self.data[name] if ok else {},
                    "config": self.config[name] if ok else "",
                }
            )
        collected = [
            {
                "device_id": d["device_id"],
                "host": d["host"],
                "status": d["status"],
                "device_type": "router" if d["name"].startswith("R") else "switch",
                "data": d["data"],
                "hostname": d["name"],
            }
            for d in devices
        ]
        return {
            "collection_id": collection_id,
            "devices": devices,
            "topology": topology.build_topology(collected, management_network="192.168.17.0/24"),
        }


# --- the five changes made to the lab on 24 October ---------------------------


def ospf_area_mismatch(lab: Lab):
    """R1's link to R2 put in OSPF area 1: the adjacency drops, and its routes with it."""
    lab.edit_config("R1", " network 10.0.12.0 0.0.0.3 area 0", " network 10.0.12.0 0.0.0.3 area 1")
    lab.row("R1", "ospf_interfaces", interface="Gi0/2").update(area="1", state="DR", neighbors_fc="0/0")
    lab.data["R1"]["ospf_neighbors"] = []
    lab.data["R2"]["ospf_neighbors"] = []
    lab.row("R2", "ospf_interfaces", interface="Gi0/1").update(neighbors_fc="0/0")
    lab.drop("R1", "routes", protocol="O")
    lab.drop("R2", "routes", protocol="O")


def access_port_moved(lab: Lab):
    """SW2 Et0/3 (the Alpine host) moved from VLAN 20 to VLAN 30."""
    lab.edit_config("SW2", " switchport access vlan 20\n", " switchport access vlan 30\n")
    lab.row("SW2", "vlans", vlan_id="20")["interfaces"] = []
    lab.row("SW2", "vlans", vlan_id="30")["interfaces"] = ["Et0/3"]
    lab.row("SW2", "spanning_tree", vlan_id="20", interface="Et0/3")["vlan_id"] = "30"


def stp_root_change(lab: Lab):
    """SW2 given priority 0 for VLAN 20, so it takes over as root from SW1."""
    lab.edit_config("SW2", "spanning-tree extend system-id\n", "spanning-tree extend system-id\nspanning-tree vlan 20 priority 0\n")
    lab.row("SW1", "spanning_tree", vlan_id="20", interface="Et0/2").update(role="Root")
    lab.row("SW1", "spanning_tree", vlan_id="20", interface="Et0/3").update(role="Altn", status="BLK")
    lab.row("SW2", "spanning_tree", vlan_id="20", interface="Et0/1").update(role="Desg")
    lab.row("SW2", "spanning_tree", vlan_id="20", interface="Et0/2").update(role="Desg", status="FWD")


def vlan_removed_from_trunk(lab: Lab):
    """VLAN 20 removed from SW1's trunk to R1."""
    lab.edit_config("SW1", " description to-R1\n switchport trunk encapsulation dot1q\n switchport trunk allowed vlan 20,30", " description to-R1\n switchport trunk encapsulation dot1q\n switchport trunk allowed vlan 30")
    lab.row("SW1", "trunks", interface="Et0/1").update(allowed_vlans="30", active_vlans="30", forwarding_vlans="30")
    lab.drop("SW1", "spanning_tree", vlan_id="20", interface="Et0/1")


def loopback_shut(lab: Lab):
    """R2 Loopback1 shut down: its connected network disappears."""
    lab.edit_config("R2", " ip address 10.2.1.1 255.255.255.0\n ip ospf network point-to-point\n", " ip address 10.2.1.1 255.255.255.0\n ip ospf network point-to-point\n shutdown\n")
    lab.row("R2", "interfaces", interface="Loopback1").update(status="administratively down", proto="down")
    lab.row("R2", "ospf_interfaces", interface="Lo1").update(state="DOWN")
    lab.drop("R2", "routes", network="10.2.1.0")
    lab.drop("R2", "routes", network="10.2.1.1")
    lab.drop("R1", "routes", network="10.2.1.0")


def unreachable(lab: Lab, name="R2"):
    """A device stops answering: its neighbours lose it."""
    lab.failed[name] = f"Timeout: {HOSTS[name]} did not answer on TCP port 22 within 10s."
    if name == "R2":
        lab.data["R1"]["ospf_neighbors"] = []
        lab.drop("R1", "routes", protocol="O")


def healthy_noise(lab: Lab):
    """Everything that changes on its own in a healthy network, all at once."""
    for name, data in lab.data.items():
        for row in data["arp"]:
            if row["age"] != "-":
                row["age"] = str(int(row["age"]) + 777)
        data["arp"].reverse()
        for row in data["version"]:
            row["uptime"] = "2 days, 4 hours, 1 minute"
            row["uptime_days"] = "2"
        for key in ("interfaces", "cdp_neighbors"):
            data[key].reverse()
    for name in ("SW1", "SW2"):
        lab.data[name]["mac_table"] = lab.data[name]["mac_table"][1:]  # one entry aged out
        lab.data[name]["mac_table"].append({"destination_address": "0050.5600.1234", "type": "DYNAMIC", "vlan_id": "10", "destination_port": ["Et0/0"]})
        lab.data[name]["spanning_tree"].reverse()
    for name in ("R1", "R2"):
        for row in lab.data[name]["ospf_neighbors"]:
            row["dead_time"] = "00:00:31"
            row["state"] = "FULL/DROTHER"  # a DR re-election
        for row in lab.data[name]["ospf_interfaces"]:
            row["state"] = {"DR": "BDR", "BDR": "DR"}.get(row["state"], row["state"])
        for row in lab.data[name]["routes"]:
            if row["uptime"]:
                row["uptime"] = "1d02h"
            if row["metric"]:
                row["metric"] = "3"
        lab.data[name]["routes"].reverse()
    lab.config = {
        name: text.replace("10:00:00 UTC Fri Oct 9 2026", "08:31:00 UTC Sat Oct 24 2026").replace("3000 bytes", "3017 bytes")
        for name, text in lab.config.items()
    }
