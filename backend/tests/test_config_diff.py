"""Config normalisation, hashing and diffing."""

from app.engine import config_diff
from tests.sample_configs import BASE, NEW_SECRET, NEW_VLAN, SAME_LATER

# --- normalisation ---------------------------------------------------------


def test_normalize_removes_volatile_lines_and_keeps_the_configuration():
    lines = config_diff.normalize_config(SAME_LATER).splitlines()

    assert lines[0] == "!"  # the banner, blank line and byte count are gone
    assert not any("Building configuration" in line for line in lines)
    assert not any("Current configuration" in line for line in lines)
    assert not any("Last configuration change" in line for line in lines)
    assert not any("NVRAM config last updated" in line for line in lines)
    assert not any(line.endswith("\r") for line in lines)
    # Real configuration survives, with its indentation and order.
    assert lines[lines.index("interface Ethernet0/1") + 1] == " switchport access vlan 10"
    assert "service timestamps log datetime msec" in lines  # a setting, not a timestamp
    assert lines[-1] == "end"


def test_normalize_only_drops_whole_matching_lines():
    config = (
        "ntp clock-period 17179738\n"
        "ntp server 10.0.0.1\n"
        "banner motd ^Building configuration... please wait^\n"
        " description Current configuration : 9 bytes\n"
    )

    assert config_diff.normalize_config(config).splitlines() == [
        "ntp server 10.0.0.1",
        "banner motd ^Building configuration... please wait^",
        " description Current configuration : 9 bytes",
    ]


def test_unchanged_config_read_twice_has_the_same_hash():
    assert BASE != SAME_LATER
    assert config_diff.config_hash(BASE) == config_diff.config_hash(SAME_LATER)
    assert len(config_diff.config_hash(BASE)) == 64


def test_changed_config_has_a_different_hash():
    assert config_diff.config_hash(BASE) != config_diff.config_hash(NEW_VLAN)
    # Indentation is meaningful in IOS, so it must change the hash too.
    assert config_diff.config_hash("interface Vlan10\n shutdown") != config_diff.config_hash(
        "interface Vlan10\nshutdown"
    )


# --- diff ------------------------------------------------------------------


def test_timestamp_only_differences_give_no_diff():
    diff = config_diff.diff_configs(BASE, SAME_LATER)

    assert diff.changed is False
    assert diff.diff == ""
    assert (diff.lines_added, diff.lines_removed) == (0, 0)


def test_new_vlan_and_moved_interface_show_up_in_the_diff():
    diff = config_diff.diff_configs(BASE, NEW_VLAN, "backup #1", "backup #2")
    lines = diff.diff.splitlines()

    assert diff.changed is True
    assert lines[:2] == ["--- backup #1", "+++ backup #2"]
    # The VLAN that was created (with the "!" separator that follows it).
    assert "+vlan 20" in lines
    assert "+ name SERVERS" in lines
    # The interface that moved: old line removed, new line added, and the
    # interface it belongs to shown as unchanged context just above.
    moved = lines.index("- switchport access vlan 10")
    assert lines[moved + 1] == "+ switchport access vlan 20"
    assert lines[moved - 1] == " interface Ethernet0/1"
    # Ethernet0/0 also has "switchport access vlan 10" and did not change.
    assert lines.count("- switchport access vlan 10") == 1
    assert (diff.lines_added, diff.lines_removed) == (4, 1)
    # Changed timestamps and byte count are not reported.
    assert "bytes" not in diff.diff
    assert "Last configuration change" not in diff.diff


def test_diff_is_reversible():
    diff = config_diff.diff_configs(NEW_VLAN, BASE)

    assert (diff.lines_added, diff.lines_removed) == (1, 4)
    assert "-vlan 20" in diff.diff.splitlines()


def test_changed_secret_is_reported_without_revealing_either_value():
    diff = config_diff.diff_configs(BASE, NEW_SECRET)

    assert diff.changed is True
    assert (diff.lines_added, diff.lines_removed) == (1, 1)
    assert "-enable secret <redacted>" in diff.diff.splitlines()
    assert "+enable secret <redacted>" in diff.diff.splitlines()
    assert "fakeHash" not in diff.diff


def test_secrets_in_unchanged_context_lines_are_masked_too():
    changed = BASE.replace("192.168.17.10 255.255.255.0", "192.168.17.11 255.255.255.0")

    diff = config_diff.diff_configs(BASE, changed)

    assert "+ ip address 192.168.17.11 255.255.255.0" in diff.diff.splitlines()
    assert " snmp-server community <redacted>" in diff.diff.splitlines()
    assert "fakeCommunity" not in diff.diff


def test_identical_configs_give_no_diff():
    assert config_diff.diff_configs(BASE, BASE).changed is False
