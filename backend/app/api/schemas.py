"""Pydantic schemas: the shape of every request and response body.

These are deliberately separate from the database models. They are the
API's public contract: FastAPI validates input against them, strips anything
not listed from output, and generates the /docs page from them.
"""

from datetime import datetime
from typing import Any

from pydantic import BaseModel, Field


class Health(BaseModel):
    status: str
    api_revision: int = Field(
        description="Version of the API contract. The dashboard compares it with the "
        "revision it was built for, to detect a backend that needs restarting."
    )
    database: bool = Field(description="The database is reachable and migrated.")
    collection_running: bool
    raw_sockets: bool = Field(
        description="This process may open raw sockets, which ARP scans need "
        "(it runs as root or has CAP_NET_RAW)."
    )
    scan_running: bool


class ScanCreate(BaseModel):
    subnet: str | None = Field(
        default=None,
        description="CIDR to scan. Must be inside ALLOWED_SUBNETS. "
        "Default: this machine's own allowed network.",
        examples=["192.168.17.0/24"],
    )
    top_ports: int = Field(default=100, ge=1, le=1000, description="Common ports to scan per host.")
    host_timeout: int = Field(default=60, ge=5, le=600, description="Seconds allowed per host.")


class Port(BaseModel):
    port: int
    protocol: str
    service: str = ""
    product: str = ""
    version: str = ""
    extra_info: str = ""
    os_type: str = ""


class ScanResult(BaseModel):
    """What one scan saw for one device."""

    scan_id: int
    device_id: int
    ip: str
    mac: str
    vendor: str
    open_ports: list[Port]
    device_type: str
    reason: str
    seen_at: datetime


class DeviceChange(BaseModel):
    mac: str
    ip: str
    vendor: str
    type: str


class IpChange(BaseModel):
    mac: str
    vendor: str
    old_ip: str
    new_ip: str


class ChangeReport(BaseModel):
    previous_scan_id: int | None = Field(
        description="The scan this one was compared with. Null for the first scan of a "
        "subnet, where every device counts as new."
    )
    new_devices: list[DeviceChange]
    missing_devices: list[DeviceChange]
    ip_changes: list[IpChange]


class ScanSummary(BaseModel):
    id: int
    status: str = Field(description="running, completed or failed")
    subnet: str
    started_at: datetime
    finished_at: datetime | None
    error: str | None
    device_count: int


class ScanDetail(ScanSummary):
    results: list[ScanResult]
    changes: ChangeReport | None = Field(description="Null unless the scan completed.")


class Device(BaseModel):
    id: int
    mac: str
    first_seen: datetime
    last_seen: datetime
    last_ip: str
    vendor: str
    virtualization: str | None = Field(
        description="Virtualisation platform read from the MAC prefix (e.g. QEMU/KVM), "
        "or null. Says how the device is hosted, not what it is."
    )
    device_type: str
    type_source: str = Field(
        description="'collected' if the type was confirmed by logging in to the device, "
        "'scan' if it is a guess from scan results."
    )
    type_reason: str
    latest_result: ScanResult | None


class ConfigBackup(BaseModel):
    """A stored running-config version. The text itself is not exposed."""

    id: int
    collected_at: datetime = Field(description="When this version was first seen.")
    last_seen_at: datetime = Field(description="When it was last confirmed unchanged.")
    sha256: str = Field(description="Hash of the config with timestamp lines removed.")
    lines: int
    changed: bool | None = Field(
        description="Whether this backup differs from the one before it. "
        "Null for a device's first backup, which has nothing to compare with."
    )
    lines_added: int = Field(description="Lines added since the previous backup.")
    lines_removed: int = Field(description="Lines removed since the previous backup.")


class ConfigBackupDetail(ConfigBackup):
    config: str = Field(
        description="The config text with password hashes, SNMP communities and "
        "keys replaced by <redacted>. Best effort, for display only."
    )


class ConfigDiff(BaseModel):
    """What changed between two config backups of a device."""

    device_id: int
    from_backup: ConfigBackup
    to_backup: ConfigBackup
    changed: bool
    lines_added: int
    lines_removed: int
    diff: str = Field(
        description="Unified diff, empty when nothing changed. Lines starting with "
        "'+' were added and '-' removed. Timestamp lines are ignored and secrets masked."
    )


class CollectResult(BaseModel):
    device_id: int
    host: str
    device_type: str = Field(description="router or switch, as confirmed by this login.")
    type_reason: str
    collection_id: int
    collected_at: datetime
    collected: dict[str, int | None] = Field(
        description="What was read, by kind: the number of rows parsed, or null if the "
        "output was stored as raw text."
    )
    note: str | None = Field(description="Something to be aware of, e.g. legacy SSH algorithms.")
    config_backup: ConfigBackup = Field(
        description="The backup that now holds the device's current config."
    )
    first_backup: bool = Field(description="True if the device had no backup before this.")
    config_changed: bool = Field(
        description="True if the config differs from the previous backup, so a new "
        "backup was stored. False if unchanged, and for a first backup."
    )


class DeviceCollectionResult(BaseModel):
    """One device's part in a collection run."""

    id: int
    device_id: int | None
    host: str
    hostname: str | None = Field(description="The device's own name, once it has been read.")
    device_type: str | None
    status: str = Field(description="pending, success or failed")
    error: str | None
    note: str | None
    collected_at: datetime
    collected: dict[str, int | None]
    config_changed: bool | None


class NetworkCollectionSummary(BaseModel):
    id: int
    status: str = Field(description="running, completed or failed")
    started_at: datetime
    finished_at: datetime | None
    device_count: int
    succeeded: int
    failed: int
    pending: int


class NetworkCollectionDetail(NetworkCollectionSummary):
    results: list[DeviceCollectionResult]


class CollectedData(BaseModel):
    device_id: int
    collected_at: datetime
    data: list[dict[str, Any]] | str = Field(
        description="A list of rows when TextFSM parsed the output, otherwise the raw CLI text."
    )


class TopologyNode(BaseModel):
    id: str = Field(description="Stable across runs: dev:<hostname>, host:<mac> or nbr:<name>.")
    kind: str = Field(description="router, switch, host or unknown")
    name: str
    device_id: int | None = Field(description="The device's page in NetSense, if it has one.")
    ip: str | None
    mac: str | None
    vendor: str | None
    virtualization: str | None
    platform: str | None
    collected: bool = Field(description="True if this run logged in to the device.")


class TopologyEnd(BaseModel):
    node: str
    interface: str | None


class TopologyStp(BaseModel):
    vlan: int
    state: str = Field(description="forwarding, blocking or transitioning")
    blocked_at: str | None = Field(description="Node whose port is blocking, if any.")
    roles: dict[str, str] = Field(description="Spanning-tree port role at each switch end.")


class TopologyLink(BaseModel):
    id: str
    kind: str = Field(description="cdp (between network devices) or host (a MAC on an access port)")
    a: TopologyEnd
    b: TopologyEnd
    seen_from: list[str] = Field(description="Nodes whose own data reported this link.")
    status: str = Field(description="up, down or unknown")
    mode: str = Field(description="trunk, access, routed or unknown")
    vlans: list[int] = Field(description="VLANs carried on the link.")
    stp: list[TopologyStp]
    stp_blocked: bool = Field(description="Spanning tree blocks at least one VLAN on this link.")
    ospf: bool = Field(description="The two ends are OSPF neighbours in state FULL.")
    ospf_state: str | None


class TopologyVlan(BaseModel):
    id: int
    name: str


class UnplacedHost(BaseModel):
    """A host in a router's ARP table that no switch has in its MAC table."""

    ip: str
    mac: str
    vendor: str | None
    seen_by: str = Field(description="Node whose ARP table lists it.")
    interface: str = Field(description="That node's interface towards the host.")


class ManagementMember(BaseModel):
    node: str
    ip: str
    interface: str | None
    vlan: int | None


class ManagementView(BaseModel):
    """The out-of-band network NetSense reaches devices over. Not a CDP link."""

    network: str | None
    members: list[ManagementMember]
    hosts: list[TopologyNode] = Field(description="Other hosts a scan saw on that network.")


class Topology(BaseModel):
    collection_id: int
    collected_at: datetime
    version: int
    nodes: list[TopologyNode]
    links: list[TopologyLink]
    vlans: list[TopologyVlan]
    unplaced_hosts: list[UnplacedHost] = Field(
        default=[],
        description="Known from ARP but silent for long enough that no switch remembers "
        "which port they are on, so they cannot be drawn.",
    )
    management: ManagementView
