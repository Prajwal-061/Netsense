"""Drift detection tests: a healthy lab, broken in the ways it was broken on 24 October."""

import pytest

from app.engine.drift import compare_snapshots
from tests import drift_lab
from tests.drift_lab import Lab


def check(*changes, noise=False):
    """Compare a healthy lab with a copy that has the given changes applied."""
    baseline, current = Lab(), Lab()
    if noise:
        drift_lab.healthy_noise(current)
    for change in changes:
        change(current)
    return compare_snapshots(baseline.snapshot(1), current.snapshot(2))


def messages(report, severity=None, category=None):
    return [
        f["message"]
        for f in report["findings"]
        if (severity is None or f["severity"] == severity) and (category is None or f["category"] == category)
    ]


def finding(report, text):
    """The one finding whose message contains this text."""
    (match,) = [f for f in report["findings"] if text in f["message"]]
    return match


def causes_of(report, text):
    by_id = {f["id"]: f for f in report["findings"]}
    return [by_id[c]["message"] for c in finding(report, text)["caused_by"]]


# --- no change ---------------------------------------------------------------


def test_identical_collections_report_no_drift():
    report = check()

    assert report["findings"] == []
    assert report["summary"] == {"critical": 0, "warning": 0, "info": 0, "devices_compared": 4, "devices_with_drift": 0}
    assert {d["status"] for d in report["devices"]} == {"unchanged"}
    assert report["chains"] == [] and report["config_diffs"] == {}
    assert report["highlight"] == {"nodes": [], "links": []}


def test_things_that_change_on_their_own_are_not_drift():
    # ARP and MAC table churn, uptime, OSPF dead timers and DR election,
    # route uptime and metric, config timestamps, table order.
    report = check(noise=True)

    assert report["findings"] == []
    assert report["summary"]["devices_with_drift"] == 0


# --- the scenarios -----------------------------------------------------------


def test_ospf_area_mismatch():
    report = check(drift_lab.ospf_area_mismatch)

    assert messages(report, "critical", "ospf") == [
        "R1 lost OSPF neighbor R2 (10.0.12.2) on Gi0/2.",
        "R2 lost OSPF neighbor R1 (10.0.12.1) on Gi0/1.",
    ]
    assert "R1 Gi0/2 moved from OSPF area 0 to area 1." in messages(report, "warning", "ospf")
    assert messages(report, "critical", "route") == [
        "R1 lost 2 routes learned via 10.0.12.2 (R2): 10.2.1.0/24, 10.2.2.0/24.",
        "R2 lost 2 routes learned via 10.0.12.1 (R1): 10.1.20.0/24, 10.1.30.0/24.",
    ]
    config = finding(report, "R1 configuration")
    assert config["message"] == (
        "R1 configuration changed 'network 10.0.12.0 0.0.0.3 area 0' to "
        "'network 10.0.12.0 0.0.0.3 area 1' under 'router ospf 1'."
    )
    # The network statement covers Gi0/2, so the change is placed there.
    assert config["interfaces"] == ["Gi0/2"]
    assert config["diff"] == " router ospf 1\n- network 10.0.12.0 0.0.0.3 area 0\n+ network 10.0.12.0 0.0.0.3 area 1"
    # Probable cause: R2's loss is linked through the topology (R1 Gi0/2 is cabled to R2 Gi0/1).
    assert causes_of(report, "R2 lost OSPF neighbor") == [config["message"]]
    assert causes_of(report, "R1 lost OSPF neighbor") == [config["message"]]
    # Lost routes go back to the lost neighbour they were learned through.
    assert causes_of(report, "R2 lost 2 routes") == ["R2 lost OSPF neighbor R1 (10.0.12.1) on Gi0/1."]
    # The whole chain, and the cause rated by its worst effect.
    (chain,) = report["chains"]
    assert chain["cause"] == config["id"]
    assert len(chain["effects"]) == 5
    assert config["severity"] == "critical"
    assert report["highlight"]["links"] == ["dev:r1|Gi0/2--dev:r2|Gi0/1"]


def test_access_port_moved_to_another_vlan():
    report = check(drift_lab.access_port_moved)

    moved = finding(report, "access port")
    assert moved["message"] == "SW2 access port Et0/3 moved from VLAN 20 (USERS) to VLAN 30 (SERVERS)."
    assert moved["severity"] == "warning"
    assert causes_of(report, "access port") == [
        "SW2 configuration changed 'switchport access vlan 20' to 'switchport access vlan 30' under 'interface Ethernet0/3'."
    ]
    # Moving VLAN is not reported a second time as a spanning-tree change.
    assert messages(report, category="stp") == []
    assert len(report["findings"]) == 2


def test_stp_root_change():
    report = check(drift_lab.stp_root_change)

    root = finding(report, "root bridge")
    assert root["message"] == "Spanning tree root bridge for VLAN 20 changed from SW1 to SW2."
    assert root["severity"] == "warning"
    assert messages(report, "warning", "stp") == [
        "Spanning tree VLAN 20: SW1 Et0/2 (to SW2 Et0/1) changed (role Desg FWD -> Root FWD).",
        "Spanning tree VLAN 20: SW1 Et0/3 (to SW2 Et0/2) is now blocking (role Desg FWD -> Altn BLK).",
        "Spanning tree VLAN 20: SW2 Et0/1 (to SW1 Et0/2) changed (role Root FWD -> Desg FWD).",
        "Spanning tree VLAN 20: SW2 Et0/2 (to SW1 Et0/3) is now forwarding (role Altn BLK -> Desg FWD).",
        "Spanning tree root bridge for VLAN 20 changed from SW1 to SW2.",
    ]
    cause = "SW2 configuration added 'spanning-tree vlan 20 priority 0'."
    # Spanning tree is per VLAN across all switches: SW1's ports are linked to SW2's change too.
    assert all(f["caused_by"] for f in report["findings"] if f["category"] == "stp")
    assert causes_of(report, "SW1 Et0/3 (to") == [cause]
    assert causes_of(report, "root bridge") == [cause]
    # VLAN 30 still has SW1 as root: untouched.
    assert not [m for m in messages(report) if "VLAN 30" in m]


def test_vlan_removed_from_a_trunk():
    report = check(drift_lab.vlan_removed_from_trunk)

    trunk = finding(report, "no longer allowed")
    assert trunk["message"] == "VLAN 20 is no longer allowed on SW1 trunk Et0/1 (to R1 Gi0/1)."
    assert trunk["severity"] == "warning"
    assert trunk["details"] == ["Allowed VLANs: baseline 20, 30, now 30."]
    assert trunk["links"] == ["dev:r1|Gi0/1--dev:sw1|Et0/1"]
    assert causes_of(report, "no longer allowed") == [
        "SW1 configuration changed 'switchport trunk allowed vlan 20,30' to "
        "'switchport trunk allowed vlan 30' under 'interface Ethernet0/1'."
    ]
    # Editing the allowed list is not blamed for spanning-tree changes elsewhere.
    assert messages(report, category="stp") == []


def test_unreachable_device():
    report = check(drift_lab.unreachable)

    down = finding(report, "could not be collected")
    assert down["message"] == "R2 (192.168.17.4) could not be collected from: Timeout: 192.168.17.4 did not answer on TCP port 22 within 10s."
    assert down["severity"] == "critical"
    assert next(d for d in report["devices"] if d["name"] == "R2")["status"] == "unreachable"
    # Nothing else is compared for R2...
    assert not [f for f in report["findings"] if f["device"] == "R2" and f is not down]
    # ...but its neighbour noticed, and that is linked to it.
    assert causes_of(report, "R1 lost OSPF neighbor R2") == [down["message"]]
    assert causes_of(report, "R1 lost 2 routes") == ["R1 lost OSPF neighbor R2 (10.0.12.2) on Gi0/2."]
    (chain,) = report["chains"]
    assert chain["cause"] == down["id"] and len(chain["effects"]) == 2
    assert report["summary"]["devices_compared"] == 3


def test_all_five_changes_of_24_october_together():
    report = check(
        drift_lab.ospf_area_mismatch,
        drift_lab.access_port_moved,
        drift_lab.stp_root_change,
        drift_lab.vlan_removed_from_trunk,
        drift_lab.loopback_shut,
        noise=True,
    )

    by_id = {f["id"]: f for f in report["findings"]}
    chains = {by_id[c["cause"]]["message"]: sorted(by_id[e]["message"] for e in c["effects"]) for c in report["chains"]}
    assert sorted(chains) == [
        "R1 configuration changed 'network 10.0.12.0 0.0.0.3 area 0' to 'network 10.0.12.0 0.0.0.3 area 1' under 'router ospf 1'.",
        "R2 configuration added 'shutdown' under 'interface Loopback1'.",
        "SW1 configuration changed 'switchport trunk allowed vlan 20,30' to 'switchport trunk allowed vlan 30' under 'interface Ethernet0/1'.",
        "SW2 configuration added 'spanning-tree vlan 20 priority 0'.",
        "SW2 configuration changed 'switchport access vlan 20' to 'switchport access vlan 30' under 'interface Ethernet0/3'.",
    ]
    loopback = chains["R2 configuration added 'shutdown' under 'interface Loopback1'."]
    assert loopback == ["R2 Lo1 was shut down (administratively down).", "R2 lost 1 route connected on Lo1: 10.2.1.0/24."]
    # Two separate changes on SW2 stay separate causes with their own effects.
    assert len(chains["SW2 configuration added 'spanning-tree vlan 20 priority 0'."]) == 5
    assert chains["SW2 configuration changed 'switchport access vlan 20' to 'switchport access vlan 30' under 'interface Ethernet0/3'."] == [
        "SW2 access port Et0/3 moved from VLAN 20 (USERS) to VLAN 30 (SERVERS)."
    ]
    # Every finding is either a cause or explained by one.
    unexplained = [f["message"] for f in report["findings"] if not f["caused_by"] and not f["effects"]]
    assert unexplained == []
    assert report["summary"] == {"critical": 7, "warning": 12, "info": 0, "devices_compared": 4, "devices_with_drift": 4}
    assert set(report["config_diffs"]) == {"R1", "R2", "SW1", "SW2"}


# --- other cases and rules -----------------------------------------------------


def test_a_downed_link_interface_is_critical():
    def shut_trunk(lab):
        lab.row("SW1", "interfaces", interface="Ethernet0/1").update(status="down", proto="down")

    report = check(shut_trunk)

    down = finding(report, "SW1 Et0/1")
    assert down["message"] == "SW1 Et0/1 (the link to R1 Gi0/1) went down (down/down)."
    assert down["severity"] == "critical"
    assert down["links"] == ["dev:r1|Gi0/1--dev:sw1|Et0/1"]


def test_a_downed_interface_without_a_link_is_a_warning():
    report = check(drift_lab.loopback_shut)

    assert finding(report, "Lo1 was shut down")["severity"] == "warning"
    assert finding(report, "connected on Lo1")["severity"] == "critical"


def test_a_config_change_with_no_visible_effect_is_info():
    def description(lab):
        lab.edit_config("R2", " description to-R1", " description to-R1-core")

    report = check(description)

    (config,) = report["findings"]
    assert config["severity"] == "info"
    assert config["message"] == "R2 configuration changed 'description to-R1' to 'description to-R1-core' under 'interface GigabitEthernet0/1'."
    assert report["summary"]["info"] == 1


def test_secrets_never_appear_in_the_report():
    def new_secrets(lab):
        lab.edit_config("R1", "$9$fakeR1hash", "$9$fakeR1other")
        lab.edit_config("SW2", "fakeCommunity", "fakeOtherCommunity")

    report = check(new_secrets)

    text = str(report)
    assert "fakeR1" not in text and "Community" not in text
    assert finding(report, "R1 configuration")["message"] == "R1 configuration changed 'enable secret <redacted>' to 'enable secret <redacted>' in the global configuration."


def test_spanning_tree_caught_converging_in_the_baseline_is_info():
    baseline, current = Lab(), Lab()
    baseline.row("SW2", "spanning_tree", vlan_id="20", interface="Et0/1").update(role="Desg", status="LRN")

    report = compare_snapshots(baseline.snapshot(1), current.snapshot(2))

    (stp,) = report["findings"]
    assert stp["severity"] == "info"
    assert stp["message"].endswith("It was still converging when the baseline was collected.")


def test_a_route_with_a_new_next_hop_is_a_warning():
    def reroute(lab):
        for row in lab.rows("R1", "routes"):
            if row["network"] == "10.2.2.0":
                row["nexthop_ip"] = "10.0.13.2"

    report = check(reroute)

    assert messages(report, "warning", "route") == ["R1 route 10.2.2.0/24 next hop changed from 10.0.12.2 to 10.0.13.2."]


def test_a_device_missing_from_the_baseline_is_not_compared():
    baseline, current = Lab(), Lab()
    baseline.failed["SW2"] = "Timeout"

    report = compare_snapshots(baseline.snapshot(1), current.snapshot(2))

    assert messages(report) == ["SW2 could not be collected from when the baseline was taken, so it is not compared."]
    assert report["summary"]["critical"] == 0


def test_vlan_and_trunk_and_link_changes_are_found():
    def changes(lab):
        lab.drop("SW1", "vlans", vlan_id="30")
        lab.row("SW2", "vlans", vlan_id="20")["vlan_name"] = "STAFF"
        lab.drop("SW2", "trunks", interface="Et0/2")

    report = check(changes)

    assert "VLAN 30 (SERVERS) was removed from SW1." in messages(report, "warning", "vlan")
    assert "VLAN 20 on SW2 was renamed from USERS to STAFF." in messages(report, "info", "vlan")
    assert "SW2 Et0/2 (to SW1 Et0/3) is no longer a trunk." in messages(report, "warning", "trunk")


def test_a_link_no_longer_seen_is_critical():
    def unplug(lab):
        lab.drop("SW1", "cdp_neighbors", local_interface="Ethernet0/1")
        lab.drop("R1", "cdp_neighbors", local_interface="GigabitEthernet0/1")

    report = check(unplug)

    link = finding(report, "no longer seen")
    assert link["message"] == "Link R1 Gi0/1 to SW1 Et0/1 is no longer seen."
    assert link["severity"] == "critical"


def test_host_moves_are_found_and_quiet_hosts_are_not_missing():
    alpine = {"destination_address": "5254.0068.dd64", "type": "DYNAMIC", "vlan_id": "20"}
    baseline = Lab()
    baseline.data["SW2"]["mac_table"].append({**alpine, "destination_port": ["Et0/3"]})

    moved = Lab()
    moved.row("SW1", "vlans", vlan_id="20")["interfaces"] = ["Et0/0"]
    moved.data["SW1"]["mac_table"].append({**alpine, "destination_port": ["Et0/0"]})
    moved.data["SW1"]["vlans"][1]["interfaces"] = []  # Et0/0 no longer in the management VLAN
    report = compare_snapshots(baseline.snapshot(1), moved.snapshot(2))
    assert "Host 10.1.20.10 moved from SW2 Et0/3 to SW1 Et0/0." in messages(report, "warning", "topology")

    # Gone from the MAC table, but R1's ARP table still has it: quiet, not missing.
    quiet = compare_snapshots(baseline.snapshot(1), Lab().snapshot(2))
    assert messages(quiet, category="topology") == []

    gone = Lab()
    gone.drop("R1", "arp", ip_address="10.1.20.10")
    report = compare_snapshots(baseline.snapshot(1), gone.snapshot(2))
    assert messages(report, "warning", "topology") == ["Host 10.1.20.10 is no longer seen on SW2 Et0/3, nor in any ARP table."]


def test_report_is_the_same_every_time():
    first = check(drift_lab.stp_root_change, drift_lab.ospf_area_mismatch)
    second = check(drift_lab.stp_root_change, drift_lab.ospf_area_mismatch)

    assert first == second
    assert [f["id"] for f in first["findings"]] == [f"f{n}" for n in range(1, len(first["findings"]) + 1)]


@pytest.mark.parametrize("change", [drift_lab.ospf_area_mismatch, drift_lab.access_port_moved, drift_lab.stp_root_change, drift_lab.vlan_removed_from_trunk, drift_lab.loopback_shut, drift_lab.unreachable])
def test_every_finding_is_a_sentence_about_a_device(change):
    report = check(change)

    assert report["findings"]
    for f in report["findings"]:
        assert f["message"][0].isupper() and f["message"].endswith(".")
        assert f["device"] in {"R1", "R2", "SW1", "SW2"}
        assert f["severity"] in {"critical", "warning", "info"}
