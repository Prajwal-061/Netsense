"""Topology builder: turn one network collection into nodes and links.

build_topology() is a pure function. It takes what was collected from each
device (plain dicts) and returns plain dicts: no database, no network, no
clock. The same input always gives the same output, with stable ids, so
topologies of different runs can be compared later.

How the picture is put together:

  - Devices NetSense logged in to are nodes.
  - CDP gives device-to-device links. Each cable is reported twice, once by
    each end, and the two reports are merged into one link.
  - A MAC address a switch learned on an access port is a host plugged into
    that port. Trunks and ports with a CDP neighbour lead to other network
    devices, so MACs learned there are somebody else's hosts.
  - A CDP neighbour that was not collected from is an "unknown" node.
  - The management network is how NetSense reaches the devices, not part of
    the network being drawn. It is recognised (the port or VLAN holding the
    address NetSense logged in to) and returned as a separate view.
"""

import re

from app.engine import discovery

VERSION = 1

ROUTER = "router"
SWITCH = "switch"
HOST = "host"
UNKNOWN = "unknown"

# Long interface names (CDP, show ip interface brief) and the short forms
# used by the trunk, spanning-tree and MAC tables.
_INTERFACE_PREFIXES = (
    ("TenGigabitEthernet", "Te"),
    ("GigabitEthernet", "Gi"),
    ("FastEthernet", "Fa"),
    ("Ethernet", "Et"),
    ("Port-channel", "Po"),
    ("Loopback", "Lo"),
    ("Vlan", "Vl"),
)
_PHYSICAL_PORT = re.compile(r"^(Te|Gi|Fa|Et|Po)\d")


def short_interface(name: str) -> str:
    """Canonical short interface name: 'GigabitEthernet0/1' and 'Gi0/1' -> 'Gi0/1'."""
    name = name.strip()
    for long, short in _INTERFACE_PREFIXES:
        if name.startswith(long):
            return short + name[len(long) :]
    return name


def normalize_mac(mac: str) -> str:
    """'5254.0068.dd64' (Cisco) or any other notation -> '52:54:00:68:dd:64'."""
    digits = re.sub(r"[^0-9a-f]", "", mac.lower())
    return ":".join(digits[i : i + 2] for i in range(0, 12, 2))


def parse_vlan_list(text: str) -> list[int]:
    """'1-3,20,30' -> [1, 2, 3, 20, 30]; 'none' or '' -> []."""
    vlans: list[int] = []
    for part in text.replace(" ", "").split(","):
        if "-" in part:
            first, last = part.split("-", 1)
            if first.isdigit() and last.isdigit():
                vlans.extend(range(int(first), int(last) + 1))
        elif part.isdigit():
            vlans.append(int(part))
    return vlans


def _rows(data: dict, key: str) -> list[dict]:
    """A collected table, or nothing if it is missing or was kept as raw text."""
    value = data.get(key)
    return value if isinstance(value, list) else []


class _Device:
    """One collected device, with its tables indexed by interface."""

    def __init__(self, entry: dict):
        self.entry = entry
        self.host = entry["host"]
        self.collected = entry.get("status") == "success"
        data = entry.get("data") or {}
        version = _rows(data, "version")
        # A device that could not be logged in to this time has no data, but
        # its name may be known from an earlier collection ("hostname").
        self.hostname = (version[0].get("hostname") if version else None) or entry.get("hostname") or None
        self.kind = entry.get("device_type") if entry.get("device_type") in (ROUTER, SWITCH) else UNKNOWN
        self.id = f"dev:{(self.hostname or self.host).lower()}"

        self.interfaces = {short_interface(r["interface"]): r for r in _rows(data, "interfaces")}
        self.ips = {r["ip_address"] for r in self.interfaces.values() if r["ip_address"] != "unassigned"}
        self.ips.add(self.host)
        self.cdp = _rows(data, "cdp_neighbors")
        self.cdp_ports = {short_interface(r["local_interface"]) for r in self.cdp}
        self.arp = _rows(data, "arp")
        # ARP entries with age "-" are the device's own interface addresses.
        self.own_macs = {normalize_mac(r["mac_address"]) for r in self.arp if r["age"] == "-"}
        self.trunks = {
            short_interface(r["interface"]): r
            for r in _rows(data, "trunks")
            if r.get("status") == "trunking"
        }
        self.access_vlan: dict[str, int] = {}
        self.vlan_names: dict[int, str] = {}
        for row in _rows(data, "vlans"):
            if not row["vlan_id"].isdigit():
                continue
            self.vlan_names[int(row["vlan_id"])] = row["vlan_name"]
            for port in row.get("interfaces") or []:
                self.access_vlan[short_interface(port)] = int(row["vlan_id"])
        self.stp: dict[str, dict[int, dict]] = {}
        for row in _rows(data, "spanning_tree"):
            if row["vlan_id"].isdigit():
                self.stp.setdefault(short_interface(row["interface"]), {})[int(row["vlan_id"])] = row
        self.mac_table = _rows(data, "mac_table")
        self.ospf_neighbors = _rows(data, "ospf_neighbors")

        # Where the address NetSense logs in to lives: a routed port, or an
        # SVI (interface VlanN), in which case VLAN N is the management VLAN.
        self.mgmt_interface = next(
            (name for name, row in self.interfaces.items() if row["ip_address"] == self.host), None
        )
        self.mgmt_vlan = None
        if self.mgmt_interface and self.mgmt_interface.startswith("Vl") and self.mgmt_interface[2:].isdigit():
            self.mgmt_vlan = int(self.mgmt_interface[2:])
        self.mgmt_ports = (
            {port for port, vlan in self.access_vlan.items() if vlan == self.mgmt_vlan}
            if self.mgmt_vlan is not None
            else ({self.mgmt_interface} if self.mgmt_interface else set())
        )

    def port_status(self, interface: str) -> str | None:
        row = self.interfaces.get(interface)
        if row is None:
            return None
        return "up" if row["status"] == "up" and row["proto"] == "up" else "down"

    def node(self) -> dict:
        return {
            "id": self.id,
            "kind": self.kind,
            "name": self.hostname or self.host,
            "device_id": self.entry.get("device_id"),
            "ip": self.host,
            "mac": None,
            "vendor": None,
            "virtualization": None,
            "platform": None,
            # False: in the inventory, but this run could not log in to it.
            "collected": self.collected,
        }


def _link_id(end_a: tuple[str, str | None], end_b: tuple[str, str | None]) -> str:
    return "--".join(f"{node}|{interface or ''}" for node, interface in (end_a, end_b))


def _stp_for(ends: list[tuple[_Device | None, str | None]], vlans: list[int]) -> list[dict]:
    """Spanning-tree state of a link per VLAN, from whichever ends are switches."""
    seen = sorted({vlan for device, port in ends if device for vlan in device.stp.get(port, {})})
    states = []
    for vlan in vlans or seen:
        rows = [(device, device.stp[port][vlan]) for device, port in ends if device and vlan in device.stp.get(port, {})]
        if not rows:
            continue
        blocked_at = [device.id for device, row in rows if row["status"] == "BLK"]
        if blocked_at:
            state = "blocking"
        elif all(row["status"] == "FWD" for _, row in rows):
            state = "forwarding"
        else:
            state = "transitioning"  # listening or learning
        states.append(
            {
                "vlan": vlan,
                "state": state,
                "blocked_at": blocked_at[0] if blocked_at else None,
                "roles": {device.id: row["role"] for device, row in rows},
            }
        )
    return states


def _describe_link(ends: list[tuple[str, _Device | None, str | None]]) -> dict:
    """Status, trunk/access and VLANs, spanning tree and OSPF for one link."""
    devices = [(device, port) for _, device, port in ends]

    statuses = [device.port_status(port) for device, port in devices if device and port]
    statuses = [status for status in statuses if status]
    status = "down" if "down" in statuses else "up" if statuses else "unknown"

    mode, vlans = "unknown", []
    trunk = next((device.trunks[port] for device, port in devices if device and port in device.trunks), None)
    access = next((device.access_vlan[port] for device, port in devices if device and port in device.access_vlan), None)
    if trunk is not None:
        # Carried = allowed on the trunk and existing on the switch.
        mode, vlans = "trunk", parse_vlan_list(trunk.get("active_vlans") or trunk.get("allowed_vlans") or "")
    elif access is not None:
        mode, vlans = "access", [access]
    elif all(device is not None and device.kind == ROUTER for device, _ in devices):
        mode = "routed"

    stp = _stp_for(devices, vlans)

    # OSPF neighbours: one end lists an adjacency on this interface whose
    # address belongs to the device at the other end.
    ospf_state = None
    for (device, port), (other, _) in (devices, devices[::-1]):
        if device is None or other is None:
            continue
        for row in device.ospf_neighbors:
            if short_interface(row["interface"]) == port and row["ip_address"] in other.ips:
                ospf_state = row["state"].split("/")[0]
    return {
        "status": status,
        "mode": mode,
        "vlans": vlans,
        "stp": stp,
        "stp_blocked": any(entry["state"] == "blocking" for entry in stp),
        "ospf": ospf_state == "FULL",
        "ospf_state": ospf_state,
    }


def build_topology(
    collected: list[dict],
    known_hosts: list[dict] | None = None,
    management_network: str | None = None,
) -> dict:
    """Build the topology of one network collection.

    collected: one dict per device of the run:
        {"device_id", "host" (management IP), "status", "device_type", "data"}
      where data is the collector's output by key ("cdp_neighbors", ...).
      A failed device may carry "hostname", its name from an earlier run:
      CDP neighbours are matched by name, because the address CDP reports is
      the neighbour's address on that link, not its management address.
    known_hosts: devices a scan has seen, for naming hosts:
        {"device_id", "ip", "mac", "vendor", "device_type", "virtualization"}
    management_network: label for the management view, e.g. "192.168.17.0/24".

    Returns {"version", "nodes", "links", "vlans", "unplaced_hosts", "management"}.
    """
    devices = [_Device(entry) for entry in collected]
    by_name = {device.hostname.lower(): device for device in devices if device.hostname}
    by_ip = {ip: device for device in devices for ip in device.ips}
    scanned = {normalize_mac(host["mac"]): host for host in known_hosts or [] if host.get("mac")}

    nodes: dict[str, dict] = {device.id: device.node() for device in devices}
    by_id = {device.id: device for device in devices}

    # --- device-to-device links, from CDP ----------------------------------
    # Keyed by the unordered pair of (node, interface) ends: SW1's report of
    # "my Et0/2 connects to SW2 Et0/1" and SW2's report of the same cable
    # give the same key, so they merge. Two cables between the same pair of
    # devices use different interfaces, so they stay two links.
    cdp_links: dict[frozenset, set[str]] = {}
    for device in devices:
        for row in device.cdp:
            name = row["neighbor_name"].split(".")[0]
            neighbor = by_name.get(name.lower()) or by_ip.get(row.get("mgmt_address", ""))
            if neighbor is not None:
                neighbor_id = neighbor.id
                if nodes[neighbor_id]["name"] == neighbor.host:
                    nodes[neighbor_id]["name"] = name  # a device that was not logged in to
            else:
                neighbor_id = f"nbr:{name.lower()}"
                nodes.setdefault(
                    neighbor_id,
                    {
                        "id": neighbor_id,
                        "kind": UNKNOWN,
                        "name": name,
                        "device_id": None,
                        "ip": row.get("mgmt_address") or None,
                        "mac": None,
                        "vendor": None,
                        "virtualization": None,
                        "platform": " ".join(
                            part for part in (row.get("platform", "").strip(), row.get("capabilities", "").strip()) if part
                        )
                        or None,
                        "collected": False,
                    },
                )
            ends = frozenset(
                {
                    (device.id, short_interface(row["local_interface"])),
                    (neighbor_id, short_interface(row["neighbor_interface"])),
                }
            )
            cdp_links.setdefault(ends, set()).add(device.id)

    links = []
    for ends, seen_from in cdp_links.items():
        if len(ends) < 2:
            continue  # a device reporting itself: not a link
        (node_a, port_a), (node_b, port_b) = sorted(ends)
        links.append(
            {
                "id": _link_id((node_a, port_a), (node_b, port_b)),
                "kind": "cdp",
                "a": {"node": node_a, "interface": port_a},
                "b": {"node": node_b, "interface": port_b},
                # Both ends reported it, or only one (the other end was not collected).
                "seen_from": sorted(seen_from),
                **_describe_link([(node_a, by_id.get(node_a), port_a), (node_b, by_id.get(node_b), port_b)]),
            }
        )

    # --- hosts, from switch MAC address tables -----------------------------
    arp_ip: dict[str, str] = {}
    for device in devices:
        for row in device.arp:
            if row["age"] != "-":
                arp_ip.setdefault(normalize_mac(row["mac_address"]), row["ip_address"])
    device_macs = {mac for device in devices for mac in device.own_macs}

    for device in devices:
        for row in device.mac_table:
            vlan = int(row["vlan_id"]) if str(row.get("vlan_id", "")).isdigit() else None
            mac = normalize_mac(row["destination_address"])
            ports = row.get("destination_port") or []
            for port in [ports] if isinstance(ports, str) else ports:
                port = short_interface(port)
                if (
                    not _PHYSICAL_PORT.match(port)  # "CPU" and the like
                    or port in device.trunks  # leads to another switch
                    or port in device.cdp_ports  # leads to another network device
                    or port in device.mgmt_ports  # the management network
                    or (vlan is not None and vlan == device.mgmt_vlan)
                    or mac in device_macs  # an interface of a device already drawn
                ):
                    continue
                known = scanned.get(mac, {})
                host_id = f"host:{mac}"
                ip = arp_ip.get(mac) or known.get("ip")
                nodes.setdefault(
                    host_id,
                    {
                        "id": host_id,
                        "kind": HOST,
                        "name": ip or mac,
                        "device_id": known.get("device_id"),
                        "ip": ip,
                        "mac": mac,
                        "vendor": known.get("vendor") or discovery.lookup_vendor(mac),
                        "virtualization": known.get("virtualization") or discovery.lookup_virtualization(mac),
                        "platform": known.get("device_type"),
                        "collected": False,
                    },
                )
                link_id = _link_id((device.id, port), (host_id, None))
                if any(link["id"] == link_id for link in links):
                    continue  # the same MAC in a second VLAN on the same port
                described = _describe_link([(device.id, device, port), (host_id, None, None)])
                if described["mode"] == "unknown" and vlan is not None:
                    described["mode"], described["vlans"] = "access", [vlan]
                    described["stp"] = _stp_for([(device, port)], [vlan])
                    described["stp_blocked"] = any(e["state"] == "blocking" for e in described["stp"])
                links.append(
                    {
                        "id": link_id,
                        "kind": "host",
                        "a": {"node": device.id, "interface": port},
                        "b": {"node": host_id, "interface": None},
                        "seen_from": [device.id],
                        **described,
                    }
                )

    # --- hosts that are known but cannot be placed --------------------------
    # A router's ARP table remembers a host for hours; a switch forgets a MAC
    # after five minutes of silence. A quiet host is therefore often in ARP
    # but in no MAC table. It exists, but which port it is on is not known,
    # and guessing one would be drawing something nobody reported.
    cdp_addresses = {row.get("mgmt_address") for device in devices for row in device.cdp}
    unplaced: dict[str, dict] = {}
    for device in devices:
        for row in device.arp:
            mac = normalize_mac(row["mac_address"])
            port = short_interface(row["interface"])
            if (
                row["age"] == "-"  # the device's own address
                or mac in device_macs
                or f"host:{mac}" in nodes  # already on the map
                or port == device.mgmt_interface  # the management network
                or row["ip_address"] in cdp_addresses  # a neighbouring network device
            ):
                continue
            known = scanned.get(mac, {})
            unplaced.setdefault(
                mac,
                {
                    "ip": row["ip_address"],
                    "mac": mac,
                    "vendor": known.get("vendor") or discovery.lookup_vendor(mac),
                    "seen_by": device.id,
                    "interface": port,
                },
            )

    # --- VLANs carried somewhere, for the dashboard's filter ----------------
    names: dict[int, str] = {}
    for device in devices:
        for vlan, name in device.vlan_names.items():
            names.setdefault(vlan, name)
    carried = sorted({vlan for link in links for vlan in link["vlans"]})
    vlans = [{"id": vlan, "name": names.get(vlan, "")} for vlan in carried]

    # --- the management network, kept apart ---------------------------------
    members = [
        {
            "node": device.id,
            "ip": device.host,
            "interface": ", ".join(sorted(device.mgmt_ports)) or device.mgmt_interface,
            "vlan": device.mgmt_vlan,
        }
        for device in devices
    ]
    drawn_ips = {node["ip"] for node in nodes.values() if node["ip"]}
    others = [
        {
            "id": f"host:{normalize_mac(host['mac'])}",
            "kind": HOST,
            "name": host.get("ip") or normalize_mac(host["mac"]),
            "device_id": host.get("device_id"),
            "ip": host.get("ip"),
            "mac": normalize_mac(host["mac"]),
            "vendor": host.get("vendor"),
            "virtualization": host.get("virtualization"),
            "platform": host.get("device_type"),
            "collected": False,
        }
        for host in known_hosts or []
        if host.get("mac") and host.get("ip") not in drawn_ips and f"host:{normalize_mac(host['mac'])}" not in nodes
    ]

    kind_order = {ROUTER: 0, SWITCH: 1, UNKNOWN: 2, HOST: 3}
    return {
        "version": VERSION,
        "nodes": sorted(nodes.values(), key=lambda node: (kind_order[node["kind"]], node["id"])),
        "links": sorted(links, key=lambda link: link["id"]),
        "vlans": vlans,
        "unplaced_hosts": sorted(unplaced.values(), key=lambda host: host["mac"]),
        "management": {
            "network": management_network,
            "members": sorted(members, key=lambda member: member["node"]),
            "hosts": sorted(others, key=lambda node: node["id"]),
        },
    }
