"""Classifier tests: plain dicts in; a type, a reason and a virtualisation out."""

import pytest

from app.engine import classifier, discovery

QEMU_MAC = "52:54:00:12:33:67"  # QEMU/KVM prefix: IOSv and Alpine nodes in CML
IOL_MAC = "aa:bb:cc:80:01:00"  # locally administered: the IOL switch
VMWARE_MAC = "00:0c:29:d6:6b:33"
PI_MAC = "b8:27:eb:11:22:33"
CISCO_MAC = "00:1b:54:aa:bb:cc"


def port(number, service="", product="", version="", extra_info="", os_type=""):
    return {
        "port": number,
        "protocol": "tcp",
        "service": service,
        "product": product,
        "version": version,
        "extra_info": extra_info,
        "os_type": os_type,
    }


def device(mac, ip="192.168.17.10"):
    """A discovery result, with the vendor discovery would report for the MAC."""
    return {"ip": ip, "mac": mac, "vendor": discovery.lookup_vendor(mac)}


def scan(*ports, timed_out=False, ip="192.168.17.10"):
    return {"ip": ip, "ports": list(ports), "timed_out": timed_out}


CISCO_SSH = port(22, "ssh", "Cisco SSH", "1.25", "protocol 2.0", "IOS")
PLAIN_SSH = port(22, "ssh", "OpenSSH", "10.2", "protocol 2.0")
UBUNTU_SSH = port(22, "ssh", "OpenSSH", "9.6p1 Ubuntu 3ubuntu13", "Ubuntu Linux; protocol 2.0", "Linux")
NGINX = port(80, "http", "nginx", "1.24.0")

# --- the lab's devices -----------------------------------------------------


def test_iosv_router_qemu_mac_with_cisco_ssh_banner_is_a_network_device():
    result = classifier.classify(device(QEMU_MAC, ip="192.168.17.3"), scan(CISCO_SSH))

    assert result == {
        "type": classifier.NETWORK_DEVICE,
        "reason": "ssh banner on port 22 is 'Cisco SSH 1.25', OS IOS",
        "virtualization": "QEMU/KVM",
    }


def test_alpine_qemu_mac_with_openssh_is_a_linux_host():
    result = classifier.classify(device(QEMU_MAC, ip="192.168.17.129"), scan(PLAIN_SSH))

    assert result == {
        "type": classifier.LINUX_HOST,
        "reason": "ssh banner on port 22 is 'OpenSSH 10.2', which suggests Linux/Unix",
        "virtualization": "QEMU/KVM",
    }


def test_iol_switch_locally_administered_mac_with_cisco_ssh_is_a_network_device():
    result = classifier.classify(device(IOL_MAC), scan(CISCO_SSH))

    assert result == {
        "type": classifier.NETWORK_DEVICE,
        "reason": "ssh banner on port 22 is 'Cisco SSH 1.25', OS IOS",
        "virtualization": None,
    }


def test_same_qemu_prefix_gives_different_types_for_different_services():
    # The point of the redesign: the MAC prefix is shared, the type is not.
    router = classifier.classify(device(QEMU_MAC), scan(CISCO_SSH))
    alpine = classifier.classify(device(QEMU_MAC), scan(PLAIN_SSH))

    assert router["virtualization"] == alpine["virtualization"] == "QEMU/KVM"
    assert router["type"] != alpine["type"]


def test_iosv_router_with_no_open_ports_is_unknown_not_virtual():
    # The lab router before SSH was enabled on it: nothing but a MAC to go on.
    result = classifier.classify(device(QEMU_MAC, ip="192.168.17.3"), scan())

    assert result["type"] == classifier.UNKNOWN
    assert result["virtualization"] == "QEMU/KVM"
    assert result["reason"] == (
        "no open ports found, and MAC vendor 'QEMU/KVM' does not indicate a device type"
    )


# --- virtualisation is an attribute, never a type --------------------------


@pytest.mark.parametrize(
    "mac, virtualization",
    [
        (QEMU_MAC, "QEMU/KVM"),
        (VMWARE_MAC, "VMware"),
        ("00:50:56:c0:00:01", "VMware"),
        ("08:00:27:aa:bb:cc", "VirtualBox"),
        ("00:15:5d:01:02:03", "Hyper-V"),
        ("02:42:ac:11:00:02", "Docker"),
        ("00:16:3e:01:02:03", "Xen"),
        (IOL_MAC, None),
        (PI_MAC, None),
    ],
)
def test_virtualization_comes_from_the_mac_prefix(mac, virtualization):
    assert classifier.classify(device(mac), scan())["virtualization"] == virtualization
    # The type is the same with or without open ports to judge by: unknown.
    assert classifier.classify(device(mac), scan())["type"] == classifier.UNKNOWN


def test_no_type_is_named_after_a_virtualisation_platform():
    types = {
        classifier.classify(device(mac), ports)["type"]
        for mac in (QEMU_MAC, VMWARE_MAC, IOL_MAC)
        for ports in (scan(), scan(PLAIN_SSH), scan(CISCO_SSH), scan(NGINX))
    }

    assert types == {
        classifier.UNKNOWN,
        classifier.LINUX_HOST,
        classifier.NETWORK_DEVICE,
        classifier.SERVER,
    }


# --- priority of scan evidence ---------------------------------------------


def test_cisco_banner_beats_every_mac_vendor_hint():
    for mac in (QEMU_MAC, VMWARE_MAC, PI_MAC, IOL_MAC):
        assert classifier.classify(device(mac), scan(CISCO_SSH))["type"] == classifier.NETWORK_DEVICE


def test_cisco_banner_beats_server_services_on_the_same_device():
    cisco_http = port(80, "http", "Cisco IOS http config", "", "", "IOS")

    result = classifier.classify(device(QEMU_MAC), scan(NGINX, cisco_http))

    assert result["type"] == classifier.NETWORK_DEVICE
    assert "Cisco IOS http config" in result["reason"]


def test_other_cisco_service_fingerprints_count_too():
    telnet = port(23, "telnet", "Cisco router telnetd")

    assert classifier.classify(device(QEMU_MAC), scan(telnet))["type"] == classifier.NETWORK_DEVICE


def test_a_port_number_alone_is_not_a_cisco_fingerprint():
    # Nmap names port 2000 "cisco-sccp" from its table when it cannot
    # identify the service. That is a port number, not evidence.
    unidentified = port(2000, "cisco-sccp")

    assert classifier.classify(device(QEMU_MAC), scan(unidentified))["type"] == classifier.UNKNOWN


def test_ios_keyword_needs_a_whole_word():
    result = classifier.classify(device(PI_MAC), scan(port(80, "upnp", "AwardBIOS httpd")))

    assert result["type"] == classifier.UNKNOWN


def test_server_services_beat_a_linux_banner():
    result = classifier.classify(device(VMWARE_MAC), scan(UBUNTU_SSH, NGINX))

    assert result["type"] == classifier.SERVER
    assert result["reason"] == "offers server services: http (80)"
    assert result["virtualization"] == "VMware"


def test_linux_banner_reports_linux():
    result = classifier.classify(device(VMWARE_MAC), scan(UBUNTU_SSH))

    assert result["type"] == classifier.LINUX_HOST
    assert "which reports Linux" in result["reason"]


def test_openssh_for_windows_is_not_a_linux_unix_host():
    windows_ssh = port(22, "ssh", "OpenSSH", "for_Windows_9.5", "protocol 2.0")

    assert classifier.classify(device(PI_MAC), scan(windows_ssh))["type"] == classifier.UNKNOWN


def test_service_evidence_beats_a_cisco_mac_vendor():
    # A Cisco-made network card in a machine that serves web pages.
    assert discovery.lookup_vendor(CISCO_MAC).lower().startswith("cisco")

    assert classifier.classify(device(CISCO_MAC), scan(NGINX))["type"] == classifier.SERVER
    assert classifier.classify(device(CISCO_MAC), scan(PLAIN_SSH))["type"] == classifier.LINUX_HOST


def test_cisco_mac_vendor_is_used_when_there_is_no_service_evidence():
    result = classifier.classify(device(CISCO_MAC), scan())

    assert result["type"] == classifier.NETWORK_DEVICE
    assert result["reason"].startswith("MAC vendor is Cisco")


def test_unknown_reasons():
    no_ports = classifier.classify(device(PI_MAC), scan())
    odd_port = classifier.classify(device(PI_MAC), scan(port(9999)))
    timed_out = classifier.classify(device(PI_MAC), scan(timed_out=True))
    never_scanned = classifier.classify(device(PI_MAC))

    assert no_ports["reason"].startswith("no open ports found, and MAC vendor 'Raspberry Pi")
    assert odd_port["reason"].startswith("1 open port(s) with no recognisable banner")
    assert timed_out["reason"] == "port scan timed out before it finished"
    assert {r["type"] for r in (no_ports, odd_port, timed_out, never_scanned)} == {classifier.UNKNOWN}


# --- classification after a login ------------------------------------------

IOL_SWITCH_VERSION = [
    {
        "software_image": "X86_64BI_LINUX_L2-ADVENTERPRISEK9-M",
        "version": "17.18.2",
        "hostname": "SW1",
        "running_image": "/binary.iol",
        "hardware": [],
    }
]
IOSV_ROUTER_VERSION = [
    {
        "software_image": "VIOS-ADVENTERPRISEK9-M",
        "version": "15.9(3)M9",
        "hostname": "R1",
        "running_image": "/vios-adventerprisek9-m",
        "hardware": ["IOSv"],
    }
]
VLANS = [{"vlan_id": "1", "vlan_name": "default"}, {"vlan_id": "10", "vlan_name": "USERS"}]
NO_VLAN_COMMAND = "% Invalid input detected at '^' marker."


def test_collected_iol_switch_is_a_switch():
    result = classifier.classify_collected(IOL_SWITCH_VERSION, VLANS)

    assert result["type"] == classifier.SWITCH
    assert result["reason"] == (
        "confirmed by login: show version reports software image "
        "'X86_64BI_LINUX_L2-ADVENTERPRISEK9-M', a switch image"
    )


def test_collected_iosv_router_is_a_router():
    result = classifier.classify_collected(IOSV_ROUTER_VERSION, NO_VLAN_COMMAND)

    assert result["type"] == classifier.ROUTER
    assert "VIOS-ADVENTERPRISEK9-M" in result["reason"]
    assert result["reason"].startswith("confirmed by login")


@pytest.mark.parametrize(
    "image, hardware, expected",
    [
        ("X86_64BI_LINUX-ADVENTERPRISEK9-M", [], classifier.ROUTER),  # IOL Layer 3 image
        ("vios_l2-ADVENTERPRISEK9-M", ["IOSv"], classifier.SWITCH),  # IOSvL2
        ("C2960-LANBASEK9-M", ["WS-C2960-24TT-L"], classifier.SWITCH),
        ("CAT9K_IOSXE", ["C9300-24T"], classifier.ROUTER),  # no keyword: decided by VLANs below
        ("C2900-UNIVERSALK9-M", ["CISCO2911/K9"], classifier.ROUTER),
        ("ISR4300-UNIVERSALK9", ["ISR4321/K9"], classifier.ROUTER),
    ],
)
def test_collected_type_from_image_and_model_names(image, hardware, expected):
    version = [{"software_image": image, "running_image": "", "hardware": hardware}]

    assert classifier.classify_collected(version, NO_VLAN_COMMAND)["type"] == expected


def test_collected_device_with_a_vlan_table_is_a_switch_whatever_its_image_name():
    version = [{"software_image": "CAT9K_IOSXE", "running_image": "", "hardware": ["C9300-24T"]}]

    result = classifier.classify_collected(version, VLANS)

    assert result["type"] == classifier.SWITCH
    assert result["reason"].endswith("show vlan brief lists 2 VLANs")


def test_collected_type_from_unparsed_show_version_text():
    switch_text = "Cisco IOS Software, Linux Software (X86_64BI_LINUX_L2-ADVENTERPRISEK9-M), Version 17.18"
    router_text = "Cisco IOS Software, IOSv Software (VIOS-ADVENTERPRISEK9-M), Version 15.9(3)M9"

    assert classifier.classify_collected(switch_text, NO_VLAN_COMMAND)["type"] == classifier.SWITCH
    assert classifier.classify_collected(router_text, NO_VLAN_COMMAND)["type"] == classifier.ROUTER


# --- classify_all() --------------------------------------------------------


def test_classify_all_merges_discovery_and_scan_results_by_ip():
    devices = [device(VMWARE_MAC, ip="192.168.17.1"), device(IOL_MAC)]
    scans = [scan(CISCO_SSH, ip="192.168.17.10")]  # nothing for .1

    combined = classifier.classify_all(devices, scans)

    assert [row["ip"] for row in combined] == ["192.168.17.1", "192.168.17.10"]
    assert combined[0]["ports"] == []
    assert (combined[0]["type"], combined[0]["virtualization"]) == (classifier.UNKNOWN, "VMware")
    assert combined[1]["mac"] == IOL_MAC
    assert combined[1]["ports"] == [CISCO_SSH]
    assert (combined[1]["type"], combined[1]["virtualization"]) == (classifier.NETWORK_DEVICE, None)
