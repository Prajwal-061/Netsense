"""Drift detection: compare two network collections and explain the differences.

compare_snapshots() is a pure function: two snapshots in (the baseline and the
current state), one report out. Each snapshot is what one network collection
read, one dict per device, plus the topology computed from it.

What counts as drift, and what is noise
---------------------------------------
Only things that reflect configuration or the outcome of a protocol are
compared. Anything that moves on its own in a healthy network is ignored:

  - ARP and MAC address tables: entries age out and are relearned all the
    time. Hosts are compared through the topology instead, and a host that
    is still in an ARP table is quiet, not missing.
  - show version: uptime and similar counters. Only the software version
    is compared.
  - OSPF: dead timers, the DR/BDR/DROTHER part of a neighbour state (an
    election result), neighbour counts. Neighbours, their main state (FULL,
    2WAY, ...), and which area each interface is in are compared.
  - Routes: uptime, metric and administrative distance. Which prefixes
    exist, how they were learned and their next hops are compared. Local
    (/32 "L") routes are left out: they mirror the connected routes.
  - Spanning tree: port cost, port id and link type. Port roles and states
    are compared, and the root bridge per VLAN is derived from them.
  - Trunks: which VLANs are active and forwarding follows from spanning
    tree and the VLAN table, which are compared themselves. The configured
    allowed VLANs and native VLAN are compared.
  - Configuration: compared after config_diff.normalize_config, which drops
    timestamps and other lines that change without a config change.
  - Table order: every table is compared as a set of rows keyed by what
    identifies a row (an interface, a VLAN, a prefix), never by position.

Correlation
-----------
Each finding records where it happened (device, interfaces, VLANs). A
configuration change is linked to a state change as its probable cause when
they are in the same place: the same device and interface, the two ends of
one link in the topology, or (for spanning tree, which is per VLAN across all
switches) the same VLAN. Lost routes are linked to the lost OSPF neighbour
they were learned through, or the interface they were connected to. The
limits are real: two snapshots say what changed, not in which order or why;
a cause outside NetSense's view (a cable, a device it does not manage)
leaves effects with no cause; and changes in the same place are all
offered as candidates rather than one being picked.
"""

import difflib
import re
from dataclasses import dataclass, field
from ipaddress import IPv4Address, IPv4Network

from app.engine.config_diff import diff_configs, normalize_config, redact_config
from app.engine.topology import parse_vlan_list, short_interface

VERSION = 1

CRITICAL, WARNING, INFO = "critical", "warning", "info"
_SEVERITY_RANK = {INFO: 0, WARNING: 1, CRITICAL: 2}


@dataclass
class Finding:
    device: str
    category: str  # reachability, config, interface, vlan, trunk, stp, ospf, route, topology, version
    severity: str
    message: str
    details: list[str] = field(default_factory=list)
    interfaces: set[str] = field(default_factory=set)  # on `device`, short names
    vlans: set[int] = field(default_factory=set)
    links: set[str] = field(default_factory=set)  # topology link ids, for the map
    diff: str | None = None
    # For correlation:
    topics: set[str] = field(default_factory=set)  # config: ospf, stp, vlan, trunk, interface
    neighbor_ip: str | None = None  # ospf: the lost neighbour's address
    neighbor_device: str | None = None
    next_hop: str | None = None  # route: learned through this address...
    via_interface: str | None = None  # ...or connected through this interface
    is_down: bool = False  # interface: went down
    id: str = ""
    caused_by: list[str] = field(default_factory=list)
    effects: list[str] = field(default_factory=list)

    def as_dict(self) -> dict:
        return {
            "id": self.id,
            "device": self.device,
            "category": self.category,
            "severity": self.severity,
            "message": self.message,
            "details": self.details,
            "interfaces": sorted(self.interfaces),
            "vlans": sorted(self.vlans),
            "links": sorted(self.links),
            "diff": self.diff,
            "caused_by": self.caused_by,
            "effects": self.effects,
        }


def _rows(data: dict, key: str) -> list[dict]:
    value = (data or {}).get(key)
    return value if isinstance(value, list) else []


def _has(data: dict, key: str) -> bool:
    """True if the table was collected and parsed (raw text cannot be compared)."""
    return isinstance((data or {}).get(key), list)


class _Device:
    """One device in one snapshot, with its tables indexed for comparison."""

    def __init__(self, entry: dict):
        self.entry = entry
        self.device_id = entry.get("device_id")
        self.host = entry.get("host")
        self.ok = entry.get("status") == "success"
        self.data = entry.get("data") or {}
        version = _rows(self.data, "version")
        self.name = (version[0].get("hostname") if version else None) or entry.get("name") or self.host
        self.node_id = f"dev:{self.name.lower()}"
        self.config = entry.get("config") or ""
        self.software = version[0].get("version") if version else None

        self.interfaces = {short_interface(r["interface"]): r for r in _rows(self.data, "interfaces")}
        self.ips = {
            r["ip_address"]: name for name, r in self.interfaces.items() if r["ip_address"] not in ("unassigned", "")
        }
        self.vlans = {int(r["vlan_id"]): r for r in _rows(self.data, "vlans") if str(r["vlan_id"]).isdigit()}
        self.access_vlan = {
            short_interface(port): vlan for vlan, r in self.vlans.items() for port in r.get("interfaces") or []
        }
        self.trunks = {short_interface(r["interface"]): r for r in _rows(self.data, "trunks")}
        self.stp = {
            (int(r["vlan_id"]), short_interface(r["interface"])): r
            for r in _rows(self.data, "spanning_tree")
            if str(r["vlan_id"]).isdigit()
        }
        self.ospf_neighbors = {
            (r["neighbor_id"], short_interface(r["interface"])): r for r in _rows(self.data, "ospf_neighbors")
        }
        self.ospf_interfaces = {short_interface(r["interface"]): r for r in _rows(self.data, "ospf_interfaces")}
        self.routes: dict[str, list[dict]] = {}
        for r in _rows(self.data, "routes"):
            if r.get("protocol") == "L":
                continue
            self.routes.setdefault(f"{r['network']}/{r['prefix_length']}", []).append(r)

    def stp_roots(self) -> set[int]:
        """VLANs for which this switch is the root bridge.

        The parsed spanning-tree table has no root bridge ID, but the root is
        the one switch whose ports are all designated: every other switch has
        a Root port towards it (and possibly Alternate or Backup ports).
        """
        vlans: dict[int, set[str]] = {}
        for (vlan, _), row in self.stp.items():
            vlans.setdefault(vlan, set()).add(row["role"])
        return {vlan for vlan, roles in vlans.items() if not roles & {"Root", "Altn", "Back"}}


class _Snapshot:
    def __init__(self, snapshot: dict):
        self.collection_id = snapshot.get("collection_id")
        self.devices = [_Device(entry) for entry in snapshot.get("devices", [])]
        self.topology = snapshot.get("topology") or {"nodes": [], "links": [], "unplaced_hosts": []}
        # (node id, interface) -> the link and the far end
        self.link_at: dict[tuple[str, str], tuple[str, tuple[str, str]]] = {}
        for link in self.topology.get("links", []):
            a = (link["a"]["node"], link["a"]["interface"])
            b = (link["b"]["node"], link["b"]["interface"])
            self.link_at[a] = (link["id"], b)
            self.link_at[b] = (link["id"], a)

    partner: "_Snapshot | None" = None  # the other snapshot of the comparison

    def key(self, device: _Device):
        return device.device_id if device.device_id is not None else device.name

    def owner_of(self, ip: str) -> _Device | None:
        return next((d for d in self.devices if ip in d.ips), None)


def _name_for(ip: str, *snapshots: _Snapshot) -> str | None:
    for snapshot in snapshots:
        device = snapshot.owner_of(ip)
        if device is not None:
            return device.name
    return None


def _state(value: str) -> str:
    """'FULL/DR' -> 'FULL': the part after the slash is an election result."""
    return value.split("/")[0].strip()


def _fmt_vlans(vlans) -> str:
    vlans = sorted(vlans)
    return ", ".join(str(v) for v in vlans) if vlans else "none"


# --- configuration -----------------------------------------------------------

_OSPF_NETWORK = re.compile(r"^\s*network\s+(\S+)\s+(\S+)\s+area\s+(\S+)")


def _sections(lines: list[str]) -> list[str]:
    """For each line, the section it belongs to: its nearest unindented line above."""
    current = "(global)"
    result = []
    for line in lines:
        if line and not line[0].isspace() and line != "!":
            current = line
            result.append(line)
        else:
            result.append(current if line.startswith(" ") else "(global)")
    return result


def _matching_interfaces(device: _Device, network: str, wildcard: str) -> set[str]:
    """Interfaces whose address falls in an OSPF 'network <address> <wildcard>' statement."""
    try:
        base, mask = int(IPv4Address(network)), int(IPv4Address(wildcard))
    except ValueError:
        return set()
    return {name for ip, name in device.ips.items() if int(IPv4Address(ip)) & ~mask == base & ~mask}


def _describe_unit(section: str, removed: list[str], added: list[str]) -> str:
    clean = lambda line: redact_config(line).strip()  # noqa: E731
    where = "in the global configuration" if section == "(global)" else f"under '{clean(section)}'"
    if section != "(global)" and not removed and not added:
        return f"changed {where}"
    if len(removed) == 1 and len(added) == 1:
        return f"changed '{clean(removed[0])}' to '{clean(added[0])}' {where}"
    if added and not removed:
        return f"added {', '.join(repr(clean(l)) for l in added[:3])}{' and more' if len(added) > 3 else ''} {where}"
    if removed and not added:
        return f"removed {', '.join(repr(clean(l)) for l in removed[:3])}{' and more' if len(removed) > 3 else ''} {where}"
    return f"changed {len(removed) + len(added)} lines {where}"


def _config_units(old: _Device, new: _Device) -> list[Finding]:
    """The config changes of one device, one finding per section touched.

    Splitting by section lets each change be a probable cause on its own: two
    unrelated edits on one switch should not be blamed for each other's effects.
    """
    a = normalize_config(old.config).splitlines()
    b = normalize_config(new.config).splitlines()
    sec_a, sec_b = _sections(a), _sections(b)
    units: dict[str, dict] = {}
    matcher = difflib.SequenceMatcher(a=a, b=b, autojunk=False)
    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        if tag == "equal":
            continue
        for i in range(i1, i2):
            if a[i].strip() != "!":
                units.setdefault(sec_a[i], {"removed": [], "added": []})["removed"].append(a[i])
        for j in range(j1, j2):
            if b[j].strip() != "!":
                units.setdefault(sec_b[j], {"removed": [], "added": []})["added"].append(b[j])

    # A one-line global command that was edited ('enable secret ...',
    # 'spanning-tree vlan 20 priority ...') shows up as one line removed and
    # another added. Pair them by their first two words so it reads as one change.
    singles = {
        section: change
        for section, change in units.items()
        if section != "(global)" and change["removed"] + change["added"] == [section]
    }
    for gone in [s for s, c in singles.items() if c["removed"]]:
        key = gone.split()[:2]
        partner = next((s for s, c in singles.items() if c["added"] and s.split()[:2] == key and s in units), None)
        if partner and gone in units:
            del units[gone], units[partner]
            units[f"(global) {' '.join(key)}"] = {"removed": [gone], "added": [partner]}

    findings = []
    for section, change in units.items():
        if section.startswith("(global) "):
            section = "(global)"
        removed = [l for l in change["removed"] if l != section]
        added = [l for l in change["added"] if l != section]
        header_added = section in change["added"] and section not in change["removed"]
        header_removed = section in change["removed"] and section not in change["added"]
        lines = [section, *removed, *added] if section != "(global)" else [*removed, *added]
        topics, vlans, interfaces = set(), set(), set()
        if section.startswith("interface "):
            interfaces.add(short_interface(section.split(None, 1)[1]))
            topics.add("interface")
        if section.startswith("router ospf"):
            topics.add("ospf")
        if section.startswith("vlan "):
            topics.add("vlan")
            vlans.update(parse_vlan_list(section.split(None, 1)[1]))
        for line in lines:
            words = line.split()
            if "ospf" in words:
                topics.add("ospf")
            match = _OSPF_NETWORK.match(line)
            if match and section.startswith("router ospf"):
                for device in (old, new):
                    interfaces |= _matching_interfaces(device, match.group(1), match.group(2))
            if line.strip().startswith("spanning-tree vlan"):
                topics.add("stp")
                vlans.update(parse_vlan_list(words[2]) if len(words) > 2 else [])
            if line.strip().startswith("switchport access vlan") and words[-1].isdigit():
                topics.add("vlan")
                vlans.add(int(words[-1]))
            if line.strip().startswith("switchport trunk allowed vlan"):
                topics.add("trunk")
                vlans.update(parse_vlan_list(words[-1]))
            if line.strip() == "shutdown":
                topics.add("interface")
                # Shutting or unshutting a trunk adds or removes a path in
                # every VLAN it carries, so spanning tree recalculates there.
                for device in (old, new):
                    for port in interfaces:
                        trunk = device.trunks.get(port)
                        if trunk:
                            topics.add("stp")
                            vlans.update(parse_vlan_list(trunk["allowed_vlans"]))

        # A new or removed top-level line: a one-line global command, or the
        # first line of a whole new (or deleted) section.
        if header_added or header_removed:
            sign = "+" if header_added else "-"
            body = added if header_added else removed
            diff = "\n".join([f"{sign}{redact_config(section)}", *[f"{sign}{redact_config(l)}" for l in body]])
            what = "added" if header_added else "removed"
            clean = redact_config(section).strip()
            description = f"{what} '{clean}'" + (f" ({len(body)} line{'s' if len(body) > 1 else ''} below it)" if body else "")
        else:
            diff = "\n".join(
                ([f" {redact_config(section)}"] if section != "(global)" else [])
                + [f"-{redact_config(l)}" for l in removed]
                + [f"+{redact_config(l)}" for l in added]
            )
            description = _describe_unit(section, removed, added)
        findings.append(
            Finding(
                device=new.name,
                category="config",
                severity=INFO,
                message=f"{new.name} configuration {description}.",
                interfaces=interfaces,
                vlans=vlans,
                topics=topics,
                diff=diff,
            )
        )
    return findings


# --- operational state ---------------------------------------------------------


def _link_at(snapshot: _Snapshot, device: _Device, interface: str) -> tuple[str | None, str | None]:
    """The topology link on this interface and a description of its far end.

    Looked up in the given snapshot first, then in the other one (a link
    that only exists in the current state, for example one just brought up).
    """
    found = snapshot.link_at.get((device.node_id, interface))
    if not found and snapshot.partner is not None:
        snapshot = snapshot.partner
        found = snapshot.link_at.get((device.node_id, interface))
    if not found:
        return None, None
    link_id, (far_node, far_interface) = found
    far = next((n["name"] for n in snapshot.topology.get("nodes", []) if n["id"] == far_node), far_node)
    return link_id, f"{far} {far_interface}" if far_interface else far


def _compare_interfaces(old: _Device, new: _Device, base: _Snapshot, current: _Snapshot) -> list[Finding]:
    if not (_has(old.data, "interfaces") and _has(new.data, "interfaces")):
        return []
    findings = []
    for name in sorted(set(old.interfaces) | set(new.interfaces)):
        before, after = old.interfaces.get(name), new.interfaces.get(name)
        link_id, far = _link_at(base, old, name)
        towards = f" (the link to {far})" if far else ""
        if before and not after:
            findings.append(Finding(new.name, "interface", WARNING, f"{new.name} {name} no longer exists.", interfaces={name}, links={link_id} if link_id else set(), is_down=True))
            continue
        if after and not before:
            findings.append(Finding(new.name, "interface", INFO, f"{new.name} has a new interface {name} ({after['status']}/{after['proto']}).", interfaces={name}))
            continue
        was_up = before["status"] == "up" and before["proto"] == "up"
        is_up = after["status"] == "up" and after["proto"] == "up"
        if (before["status"], before["proto"]) != (after["status"], after["proto"]):
            if was_up and not is_up:
                how = "was shut down (administratively down)" if after["status"] == "administratively down" else f"went down ({after['status']}/{after['proto']})"
                findings.append(
                    Finding(
                        new.name,
                        "interface",
                        CRITICAL if link_id else WARNING,
                        f"{new.name} {name}{towards} {how}.",
                        details=[f"Baseline: {before['status']}/{before['proto']}; now: {after['status']}/{after['proto']}."],
                        interfaces={name},
                        links={link_id} if link_id else set(),
                        is_down=True,
                    )
                )
            elif is_up:
                findings.append(Finding(new.name, "interface", INFO, f"{new.name} {name}{towards} came up (was {before['status']}/{before['proto']}).", interfaces={name}))
            else:
                findings.append(Finding(new.name, "interface", INFO, f"{new.name} {name} changed from {before['status']}/{before['proto']} to {after['status']}/{after['proto']}.", interfaces={name}))
        if before["ip_address"] != after["ip_address"]:
            findings.append(Finding(new.name, "interface", WARNING, f"{new.name} {name} address changed from {before['ip_address']} to {after['ip_address']}.", interfaces={name}))
    return findings


def _vlan_label(device: _Device, vlan: int) -> str:
    row = device.vlans.get(vlan)
    return f"VLAN {vlan} ({row['vlan_name']})" if row and row.get("vlan_name") else f"VLAN {vlan}"


def _compare_vlans(old: _Device, new: _Device) -> list[Finding]:
    if not (_has(old.data, "vlans") and _has(new.data, "vlans")):
        return []
    findings = []
    for vlan in sorted(set(old.vlans) | set(new.vlans)):
        before, after = old.vlans.get(vlan), new.vlans.get(vlan)
        if before and not after:
            findings.append(Finding(new.name, "vlan", WARNING, f"{_vlan_label(old, vlan)} was removed from {new.name}.", vlans={vlan}))
        elif after and not before:
            findings.append(Finding(new.name, "vlan", INFO, f"{_vlan_label(new, vlan)} was added on {new.name}.", vlans={vlan}))
        else:
            if before["vlan_name"] != after["vlan_name"]:
                findings.append(Finding(new.name, "vlan", INFO, f"VLAN {vlan} on {new.name} was renamed from {before['vlan_name']} to {after['vlan_name']}.", vlans={vlan}))
            if before["status"] != after["status"]:
                findings.append(Finding(new.name, "vlan", WARNING, f"{_vlan_label(new, vlan)} on {new.name} changed from {before['status']} to {after['status']}.", vlans={vlan}))
    # Access ports: in one VLAN in the baseline and another now.
    for port in sorted(set(old.access_vlan) | set(new.access_vlan)):
        before, after = old.access_vlan.get(port), new.access_vlan.get(port)
        if before is not None and after is not None and before != after:
            findings.append(
                Finding(
                    new.name,
                    "vlan",
                    WARNING,
                    f"{new.name} access port {port} moved from {_vlan_label(old, before)} to {_vlan_label(new, after)}.",
                    details=["Whatever is plugged into this port is now in a different subnet."],
                    interfaces={port},
                    vlans={before, after},
                )
            )
        elif before is not None and after is None and port not in new.trunks:
            findings.append(Finding(new.name, "vlan", INFO, f"{new.name} {port} is no longer an access port in {_vlan_label(old, before)}.", interfaces={port}, vlans={before}))
    return findings


def _compare_trunks(old: _Device, new: _Device, base: _Snapshot) -> list[Finding]:
    if not (_has(old.data, "trunks") and _has(new.data, "trunks")):
        return []
    findings = []
    for port in sorted(set(old.trunks) | set(new.trunks)):
        before, after = old.trunks.get(port), new.trunks.get(port)
        link_id, far = _link_at(base, old, port)
        towards = f" (to {far})" if far else ""
        links = {link_id} if link_id else set()
        if before and not after:
            findings.append(Finding(new.name, "trunk", WARNING, f"{new.name} {port}{towards} is no longer a trunk.", details=[f"It carried VLAN {_fmt_vlans(parse_vlan_list(before['allowed_vlans']))}."], interfaces={port}, vlans=set(parse_vlan_list(before["allowed_vlans"])), links=links))
            continue
        if after and not before:
            findings.append(Finding(new.name, "trunk", INFO, f"{new.name} {port}{towards} is a new trunk carrying VLAN {_fmt_vlans(parse_vlan_list(after['allowed_vlans']))}.", interfaces={port}, links=links))
            continue
        allowed_before = set(parse_vlan_list(before["allowed_vlans"]))
        allowed_after = set(parse_vlan_list(after["allowed_vlans"]))
        if removed := allowed_before - allowed_after:
            plural = "s" if len(removed) > 1 else ""
            findings.append(
                Finding(
                    new.name,
                    "trunk",
                    WARNING,
                    f"VLAN{plural} {_fmt_vlans(removed)} {'are' if plural else 'is'} no longer allowed on {new.name} trunk {port}{towards}.",
                    details=[f"Allowed VLANs: baseline {_fmt_vlans(allowed_before)}, now {_fmt_vlans(allowed_after)}."],
                    interfaces={port},
                    vlans=removed,
                    links=links,
                )
            )
        if added := allowed_after - allowed_before:
            findings.append(Finding(new.name, "trunk", INFO, f"VLAN {_fmt_vlans(added)} newly allowed on {new.name} trunk {port}{towards}.", interfaces={port}, vlans=added, links=links))
        if before["native_vlan"] != after["native_vlan"]:
            findings.append(Finding(new.name, "trunk", WARNING, f"Native VLAN on {new.name} trunk {port}{towards} changed from {before['native_vlan']} to {after['native_vlan']}.", interfaces={port}, links=links))
        if before["status"] != after["status"]:
            findings.append(Finding(new.name, "trunk", WARNING, f"{new.name} trunk {port}{towards} changed from {before['status']} to {after['status']}.", interfaces={port}, links=links))
    return findings


_TRANSITIONAL = {"LIS", "LRN"}


def _compare_stp(old: _Device, new: _Device, base: _Snapshot) -> list[Finding]:
    if not (_has(old.data, "spanning_tree") and _has(new.data, "spanning_tree")):
        return []
    findings = []
    # Only ports that are in the same VLAN in both: a port that moved VLAN or
    # stopped being a trunk is reported by the VLAN and trunk comparisons.
    for vlan, port in sorted(set(old.stp) & set(new.stp)):
        before, after = old.stp[(vlan, port)], new.stp[(vlan, port)]
        if (before["role"], before["status"]) == (after["role"], after["status"]):
            continue
        link_id, far = _link_at(base, old, port)
        towards = f" (to {far})" if far else ""
        blocking = after["status"] == "BLK" and before["status"] != "BLK"
        forwarding = after["status"] == "FWD" and before["status"] == "BLK"
        what = "is now blocking" if blocking else "is now forwarding" if forwarding else "changed"
        # A port in listening/learning state was caught mid-convergence:
        # moving out of it in the baseline, or into it now, is not a change
        # of the stable topology.
        settling = before["status"] in _TRANSITIONAL
        transitional = after["status"] in _TRANSITIONAL
        note = (
            " It was still converging when the baseline was collected."
            if settling
            else " It was still converging when collected." if transitional else ""
        )
        findings.append(
            Finding(
                new.name,
                "stp",
                INFO if (transitional or settling) else WARNING,
                f"Spanning tree VLAN {vlan}: {new.name} {port}{towards} {what} "
                f"(role {before['role']} {before['status']} -> {after['role']} {after['status']})." + note,
                interfaces={port},
                vlans={vlan},
                links={link_id} if link_id else set(),
            )
        )
    return findings


def _compare_stp_roots(base: _Snapshot, current: _Snapshot, pairs) -> list[Finding]:
    """The root bridge per VLAN, across all switches compared."""
    def roots(devices) -> dict[int, set[str]]:
        result: dict[int, set[str]] = {}
        for device in devices:
            for vlan in device.stp_roots():
                result.setdefault(vlan, set()).add(device.name)
        return result

    switches = [(o, n) for o, n in pairs if _has(o.data, "spanning_tree") and _has(n.data, "spanning_tree")]
    before = roots([o for o, _ in switches])
    after = roots([n for _, n in switches])
    vlans_before = {v for o, _ in switches for (v, _) in o.stp}
    vlans_after = {v for _, n in switches for (v, _) in n.stp}
    findings = []
    for vlan in sorted(vlans_before & vlans_after):
        was, now = before.get(vlan, set()), after.get(vlan, set())
        if was == now:
            continue
        was_text = " and ".join(sorted(was)) or "a switch NetSense does not manage"
        now_text = " and ".join(sorted(now)) or "a switch NetSense does not manage"
        device = next(iter(sorted(now or was)), switches[0][1].name)
        findings.append(
            Finding(
                device,
                "stp",
                WARNING,
                f"Spanning tree root bridge for VLAN {vlan} changed from {was_text} to {now_text}.",
                details=["Traffic in this VLAN now follows different paths; ports elsewhere may have changed between forwarding and blocking."],
                vlans={vlan},
            )
        )
    return findings


def _compare_ospf(old: _Device, new: _Device, base: _Snapshot, current: _Snapshot) -> list[Finding]:
    findings = []
    if _has(old.data, "ospf_neighbors") and _has(new.data, "ospf_neighbors"):
        for key in sorted(set(old.ospf_neighbors) | set(new.ospf_neighbors)):
            router_id, port = key
            before, after = old.ospf_neighbors.get(key), new.ospf_neighbors.get(key)
            row = before or after
            ip = row["ip_address"]
            name = _name_for(ip, base, current) or router_id
            who = f"{name} ({ip})" if name != ip else ip
            link_id, _ = _link_at(base, old, port)
            links = {link_id} if link_id else set()
            if before and not after:
                findings.append(
                    Finding(
                        new.name,
                        "ospf",
                        CRITICAL,
                        f"{new.name} lost OSPF neighbor {who} on {port}.",
                        details=[f"Router ID {router_id}; it was {_state(before['state'])} in the baseline. Routes learned through it are gone with it."],
                        interfaces={port},
                        links=links,
                        neighbor_ip=ip,
                        neighbor_device=name,
                    )
                )
            elif after and not before:
                findings.append(Finding(new.name, "ospf", INFO, f"{new.name} has a new OSPF neighbor {who} on {port} ({_state(after['state'])}).", interfaces={port}, links=links))
            elif _state(before["state"]) != _state(after["state"]):
                down = _state(before["state"]) == "FULL"
                findings.append(
                    Finding(
                        new.name,
                        "ospf",
                        CRITICAL if down else INFO,
                        f"{new.name} OSPF neighbor {who} on {port} is {_state(after['state'])}"
                        + (", no longer FULL." if down else f" (was {_state(before['state'])})."),
                        interfaces={port},
                        links=links,
                        neighbor_ip=ip if down else None,
                        neighbor_device=name,
                    )
                )
    if _has(old.data, "ospf_interfaces") and _has(new.data, "ospf_interfaces"):
        for port in sorted(set(old.ospf_interfaces) | set(new.ospf_interfaces)):
            before, after = old.ospf_interfaces.get(port), new.ospf_interfaces.get(port)
            if before and not after:
                findings.append(Finding(new.name, "ospf", WARNING, f"{new.name} {port} no longer runs OSPF (was area {before['area']}).", interfaces={port}))
            elif after and not before:
                findings.append(Finding(new.name, "ospf", INFO, f"{new.name} {port} now runs OSPF in area {after['area']}.", interfaces={port}))
            elif before["area"] != after["area"]:
                link_id, far = _link_at(base, old, port)
                findings.append(
                    Finding(
                        new.name,
                        "ospf",
                        WARNING,
                        f"{new.name} {port} moved from OSPF area {before['area']} to area {after['area']}.",
                        details=[f"Its neighbor{' on ' + far if far else ''} must be in the same area, or the adjacency cannot form."],
                        interfaces={port},
                        links={link_id} if link_id else set(),
                    )
                )
            elif before["cost"] != after["cost"]:
                findings.append(Finding(new.name, "ospf", INFO, f"{new.name} {port} OSPF cost changed from {before['cost']} to {after['cost']}.", interfaces={port}))
    return findings


_PROTOCOLS = {"C": "connected", "S": "static", "O": "OSPF", "D": "EIGRP", "B": "BGP", "R": "RIP", "i": "IS-IS"}


def _route_text(prefix: str, rows: list[dict]) -> str:
    protocol = _PROTOCOLS.get(rows[0]["protocol"], rows[0]["protocol"])
    hops = sorted({r["nexthop_ip"] for r in rows if r.get("nexthop_ip")})
    via = f" via {', '.join(hops)}" if hops else f" on {short_interface(rows[0]['nexthop_if'])}" if rows[0].get("nexthop_if") else ""
    return f"{prefix} ({protocol}{via})"


def _compare_routes(old: _Device, new: _Device, base: _Snapshot, current: _Snapshot) -> list[Finding]:
    if not (_has(old.data, "routes") and _has(new.data, "routes")):
        return []
    findings = []
    # Lost routes, grouped by what they depended on, so each group can be
    # linked to its own cause: a next hop (a lost neighbour) or an interface.
    lost: dict[tuple, list[str]] = {}
    for prefix in sorted(set(old.routes) - set(new.routes), key=lambda p: IPv4Network(p, strict=False)):
        rows = old.routes[prefix]
        hop = next((r["nexthop_ip"] for r in rows if r.get("nexthop_ip")), None)
        port = short_interface(rows[0]["nexthop_if"]) if rows[0].get("nexthop_if") else None
        group = ("hop", hop) if hop else ("if", port)
        lost.setdefault(group, []).append(_route_text(prefix, rows))
    for (kind, value), routes in lost.items():
        plural = "s" if len(routes) > 1 else ""
        if kind == "hop":
            name = _name_for(value, base, current)
            where = f" learned via {value}{f' ({name})' if name else ''}"
        else:
            where = f" connected on {value}" if value else ""
        findings.append(
            Finding(
                new.name,
                "route",
                CRITICAL,
                f"{new.name} lost {len(routes)} route{plural}{where}: {', '.join(r.split(' (')[0] for r in routes)}.",
                details=routes,
                interfaces={value} if kind == "if" and value else set(),
                next_hop=value if kind == "hop" else None,
                via_interface=value if kind == "if" else None,
            )
        )
    new_routes = sorted(set(new.routes) - set(old.routes), key=lambda p: IPv4Network(p, strict=False))
    if new_routes:
        findings.append(Finding(new.name, "route", INFO, f"{new.name} has {len(new_routes)} new route{'s' if len(new_routes) > 1 else ''}: {', '.join(new_routes)}.", details=[_route_text(p, new.routes[p]) for p in new_routes]))
    for prefix in sorted(set(old.routes) & set(new.routes), key=lambda p: IPv4Network(p, strict=False)):
        before, after = old.routes[prefix], new.routes[prefix]
        if before[0]["protocol"] != after[0]["protocol"]:
            findings.append(Finding(new.name, "route", WARNING, f"{new.name} now learns {prefix} by {_PROTOCOLS.get(after[0]['protocol'], after[0]['protocol'])} instead of {_PROTOCOLS.get(before[0]['protocol'], before[0]['protocol'])}.", details=[f"Baseline {_route_text(prefix, before)}; now {_route_text(prefix, after)}."]))
            continue
        hops_before = {r["nexthop_ip"] for r in before if r.get("nexthop_ip")}
        hops_after = {r["nexthop_ip"] for r in after if r.get("nexthop_ip")}
        if hops_before != hops_after:
            findings.append(Finding(new.name, "route", WARNING, f"{new.name} route {prefix} next hop changed from {_fmt_vlans_ips(hops_before)} to {_fmt_vlans_ips(hops_after)}.", next_hop=next(iter(sorted(hops_before)), None)))
    return findings


def _fmt_vlans_ips(ips) -> str:
    return ", ".join(sorted(ips)) or "none"


def _compare_topology(base: _Snapshot, current: _Snapshot, unreachable: set[str]) -> list[Finding]:
    findings = []
    names = {n["id"]: n["name"] for t in (base.topology, current.topology) for n in t.get("nodes", [])}
    end = lambda e: f"{names.get(e['node'], e['node'])} {e['interface'] or ''}".strip()  # noqa: E731
    links_before = {l["id"]: l for l in base.topology.get("links", []) if l["kind"] == "cdp"}
    links_after = {l["id"]: l for l in current.topology.get("links", []) if l["kind"] == "cdp"}
    for link_id in sorted(set(links_before) - set(links_after)):
        link = links_before[link_id]
        device = names.get(link["a"]["node"], link["a"]["node"])
        findings.append(
            Finding(
                device,
                "topology",
                CRITICAL,
                f"Link {end(link['a'])} to {end(link['b'])} is no longer seen.",
                details=["Neither end reports the other in CDP any more: the link is down, or a device was replaced."],
                interfaces={link["a"]["interface"]} if link["a"]["interface"] else set(),
                links={link_id},
                neighbor_device=names.get(link["b"]["node"]),
            )
        )
    for link_id in sorted(set(links_after) - set(links_before)):
        link = links_after[link_id]
        findings.append(Finding(names.get(link["a"]["node"], link["a"]["node"]), "topology", INFO, f"New link {end(link['a'])} to {end(link['b'])}.", links={link_id}))

    # Hosts: where each MAC was plugged in.
    def host_ports(topology):
        ports = {}
        for link in topology.get("links", []):
            if link["kind"] == "host":
                ports[link["b"]["node"]] = (link["a"]["node"], link["a"]["interface"], link["id"])
        return ports

    before, after = host_ports(base.topology), host_ports(current.topology)
    quiet = {f"host:{h['mac']}" for h in current.topology.get("unplaced_hosts", [])}
    for host in sorted(set(before) | set(after)):
        label = names.get(host, host)
        if host in before and host in after and before[host][:2] != after[host][:2]:
            findings.append(Finding(names.get(after[host][0], after[host][0]), "topology", WARNING, f"Host {label} moved from {names.get(before[host][0])} {before[host][1]} to {names.get(after[host][0])} {after[host][1]}.", interfaces={after[host][1]}, links={after[host][2]}))
        elif host in before and host not in after and host not in quiet:
            switch = names.get(before[host][0], before[host][0])
            if switch in unreachable:
                continue
            findings.append(Finding(switch, "topology", WARNING, f"Host {label} is no longer seen on {switch} {before[host][1]}, nor in any ARP table.", interfaces={before[host][1]}, links={before[host][2]}))
    return findings


# --- correlation ------------------------------------------------------------------


def _correlate(findings: list[Finding], base: _Snapshot, now: _Snapshot) -> None:
    """Link probable causes to the state changes they explain (see module docstring)."""

    def adjacent(device: str, interfaces: set[str]) -> set[tuple[str, str]]:
        """(device, interface) pairs at the far end of links from these interfaces.

        Both topologies are used: a change can remove a link (it is only in the
        baseline) or bring one up (it is only in the current state).
        """
        node = f"dev:{device.lower()}"
        far = set()
        for snapshot in (base, now):
            for interface in interfaces:
                found = snapshot.link_at.get((node, interface))
                if found:
                    far_node, far_if = found[1]
                    name = next((n["name"] for n in snapshot.topology.get("nodes", []) if n["id"] == far_node), None)
                    if name and far_if:
                        far.add((name, far_if))
        return far

    def place(f: Finding) -> set[tuple[str, str]]:
        return {(f.device, i) for i in f.interfaces}

    def link(cause: Finding, effect: Finding) -> None:
        if cause is effect or cause.id in effect.caused_by:
            return
        effect.caused_by.append(cause.id)
        cause.effects.append(effect.id)

    configs = [f for f in findings if f.category == "config"]
    unreachable = [f for f in findings if f.category == "reachability" and f.severity == CRITICAL]
    states = [f for f in findings if f.category not in ("config", "reachability")]

    # 1. Configuration changes -> state changes in the same place.
    for cause in configs:
        here = place(cause)
        there = adjacent(cause.device, cause.interfaces)
        for effect in states:
            if effect.category == "route":
                continue  # through their neighbour or interface, below
            same_place = bool(place(effect) & (here | there))
            same_vlan_stp = "stp" in cause.topics and effect.category == "stp" and bool(effect.vlans & cause.vlans)
            if same_place or same_vlan_stp:
                link(cause, effect)

    # 2. An unreachable device -> neighbours that lost it.
    for cause in unreachable:
        for effect in states:
            if effect.neighbor_device == cause.device and effect.category in ("ospf", "topology"):
                link(cause, effect)

    # 3. A downed interface or lost neighbour -> routes that depended on it.
    for effect in [f for f in states if f.category == "route"]:
        for cause in states:
            if cause.device != effect.device:
                continue
            if effect.next_hop and cause.category == "ospf" and cause.neighbor_ip == effect.next_hop:
                link(cause, effect)
            if effect.via_interface and cause.category == "interface" and cause.is_down and effect.via_interface in cause.interfaces:
                link(cause, effect)

    # 4. A downed interface -> OSPF neighbours lost on it.
    for cause in [f for f in states if f.category == "interface" and f.is_down]:
        for effect in states:
            if effect.category == "ospf" and effect.neighbor_ip and place(effect) & (place(cause) | adjacent(cause.device, cause.interfaces)):
                link(cause, effect)


def _root_causes(findings: list[Finding]) -> list[dict]:
    """Every finding that explains others and is not itself explained, with all it explains."""
    by_id = {f.id: f for f in findings}
    chains = []
    for root in findings:
        if root.caused_by or not root.effects:
            continue
        seen, todo = [], list(root.effects)
        while todo:
            current = todo.pop(0)
            if current in seen:
                continue
            seen.append(current)
            todo.extend(by_id[current].effects)
        chains.append({"cause": root.id, "effects": seen})
    return chains


# --- the comparison ---------------------------------------------------------------


def compare_snapshots(baseline: dict, current: dict) -> dict:
    """Compare a network collection with the baseline and explain the differences.

    Each snapshot: {"collection_id", "topology", "devices": [{"device_id",
    "host", "name", "status", "error", "data", "config"}]}; data is the
    collector's output by key, config the running config text.

    Returns {"version", "baseline_collection_id", "collection_id", "summary",
    "devices", "findings", "chains", "config_diffs", "highlight"}.
    """
    base, now = _Snapshot(baseline), _Snapshot(current)
    base.partner, now.partner = now, base
    findings: list[Finding] = []
    devices: list[dict] = []
    pairs: list[tuple[_Device, _Device]] = []
    unreachable: set[str] = set()
    config_diffs: dict[str, str] = {}

    current_by_key = {now.key(d): d for d in now.devices}
    for old in base.devices:
        new = current_by_key.pop(base.key(old), None)
        if not old.ok:
            devices.append({"name": old.name, "device_id": old.device_id, "host": old.host, "status": "not in baseline"})
            findings.append(Finding(old.name, "reachability", INFO, f"{old.name} could not be collected from when the baseline was taken, so it is not compared.", details=[old.entry.get("error") or ""]))
            continue
        if new is None or not new.ok:
            reason = (new.entry.get("error") if new else None) or "it was not part of this collection"
            unreachable.add(old.name)
            devices.append({"name": old.name, "device_id": old.device_id, "host": old.host, "status": "unreachable"})
            findings.append(
                Finding(
                    old.name,
                    "reachability",
                    CRITICAL,
                    f"{old.name} ({old.host}) could not be collected from: {reason}",
                    details=["Nothing else on this device could be compared. Its neighbours' view of it is compared below."],
                    neighbor_device=old.name,
                )
            )
            continue
        pairs.append((old, new))
        devices.append({"name": new.name, "device_id": new.device_id, "host": new.host, "status": "compared"})

        diff = diff_configs(old.config, new.config, "baseline", "current")
        if diff.changed:
            config_diffs[new.name] = diff.diff
            findings.extend(_config_units(old, new))
        if old.software and new.software and old.software != new.software:
            findings.append(Finding(new.name, "version", INFO, f"{new.name} software changed from {old.software} to {new.software}."))
        findings.extend(_compare_interfaces(old, new, base, now))
        findings.extend(_compare_vlans(old, new))
        findings.extend(_compare_trunks(old, new, base))
        findings.extend(_compare_stp(old, new, base))
        findings.extend(_compare_ospf(old, new, base, now))
        findings.extend(_compare_routes(old, new, base, now))

    for new in current_by_key.values():
        devices.append({"name": new.name, "device_id": new.device_id, "host": new.host, "status": "new"})
        findings.append(Finding(new.name, "reachability", INFO, f"{new.name} ({new.host}) is new: it was not in the baseline."))

    findings.extend(_compare_stp_roots(base, now, pairs))
    findings.extend(_compare_topology(base, now, unreachable))

    order = {name: index for index, name in enumerate(d["name"] for d in devices)}
    findings.sort(key=lambda f: (order.get(f.device, len(order)), -_SEVERITY_RANK[f.severity], f.category, f.message))
    for number, finding in enumerate(findings, start=1):
        finding.id = f"f{number}"
    _correlate(findings, base, now)

    # A config change is "info" unless something it probably caused is worse.
    by_id = {f.id: f for f in findings}
    for chain in _root_causes(findings):
        root = by_id[chain["cause"]]
        worst = max((by_id[e].severity for e in chain["effects"]), key=_SEVERITY_RANK.get)
        if _SEVERITY_RANK[worst] > _SEVERITY_RANK[root.severity]:
            root.severity = worst

    changed = {f.device for f in findings if f.category != "reachability" or f.severity == CRITICAL}
    for device in devices:
        device["findings"] = [f.id for f in findings if f.device == device["name"]]
        if device["status"] == "compared":
            device["status"] = "changed" if device["name"] in changed else "unchanged"

    summary = {severity: sum(f.severity == severity for f in findings) for severity in (CRITICAL, WARNING, INFO)}
    summary["devices_compared"] = len(pairs)
    summary["devices_with_drift"] = sum(d["status"] in ("changed", "unreachable") for d in devices)
    return {
        "version": VERSION,
        "baseline_collection_id": base.collection_id,
        "collection_id": now.collection_id,
        "summary": summary,
        "devices": devices,
        "findings": [f.as_dict() for f in findings],
        "chains": _root_causes(findings),
        "config_diffs": config_diffs,
        "highlight": {
            "nodes": sorted({f"dev:{f.device.lower()}" for f in findings if f.severity != INFO or f.category == "config"}),
            "links": sorted({link for f in findings for link in f.links}),
        },
    }
