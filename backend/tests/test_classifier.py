"""Classifier tests: plain dicts in, a guess and a reason out."""

from app.engine import classifier


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


def device(vendor, ip="192.168.17.10", mac="aa:bb:cc:00:01:00"):
    return {"ip": ip, "mac": mac, "vendor": vendor}


def scan(*ports, timed_out=False, ip="192.168.17.10"):
    return {"ip": ip, "ports": list(ports), "timed_out": timed_out}


CISCO_SSH = port(22, "ssh", "Cisco SSH", "1.25", "protocol 2.0", "IOS")
UBUNTU_SSH = port(22, "ssh", "OpenSSH", "9.6p1 Ubuntu 3ubuntu13", "Ubuntu Linux; protocol 2.0", "Linux")
PLAIN_SSH = port(22, "ssh", "OpenSSH", "10.2", "protocol 2.0")
NGINX = port(80, "http", "nginx", "1.24.0")


def test_lab_switch_is_classified_from_its_ssh_banner_not_its_mac():
    # The vendor lookup is useless here: the MAC is locally administered.
    result = classifier.classify(device("Locally administered"), scan(CISCO_SSH))

    assert result["type"] == classifier.NETWORK_DEVICE
    assert result["reason"] == "ssh banner on port 22 is 'Cisco SSH 1.25', OS IOS"


def test_network_device_from_mac_vendor_when_no_ports_are_open():
    result = classifier.classify(device("Cisco Systems, Inc"), scan())

    assert result == {"type": classifier.NETWORK_DEVICE, "reason": "MAC vendor is Cisco Systems, Inc"}


def test_server_when_it_offers_server_services():
    result = classifier.classify(device("VMware, Inc."), scan(UBUNTU_SSH, NGINX))

    assert result == {
        "type": classifier.SERVER,
        "reason": "offers server services: http (80); MAC prefix is VMware, Inc.",
    }


def test_linux_host_when_only_ssh_reports_linux():
    result = classifier.classify(device("VMware, Inc."), scan(UBUNTU_SSH))

    assert result["type"] == classifier.LINUX_HOST
    assert "OpenSSH 9.6p1 Ubuntu" in result["reason"]


def test_virtual_when_vmware_mac_is_the_only_evidence():
    result = classifier.classify(device("VMware, Inc."), scan())

    assert result == {"type": classifier.VIRTUAL, "reason": "MAC prefix is VMware, Inc."}


def test_qemu_vm_with_plain_openssh_is_a_linux_unix_host():
    # Host 192.168.17.129 in the lab: a 52:54:00 MAC and an SSH banner that
    # names no OS. It used to come out as "unknown".
    result = classifier.classify(
        device("QEMU/KVM virtual machine", ip="192.168.17.129", mac="52:54:00:12:34:56"),
        scan(PLAIN_SSH, ip="192.168.17.129"),
    )

    assert result == {
        "type": classifier.LINUX_HOST,
        "reason": "ssh banner on port 22 is 'OpenSSH 10.2', which suggests Linux/Unix; "
        "MAC prefix is QEMU/KVM virtual machine",
    }


def test_plain_openssh_suggests_linux_unix_without_any_mac_hint():
    result = classifier.classify(device("Unknown"), scan(PLAIN_SSH))

    assert result == {
        "type": classifier.LINUX_HOST,
        "reason": "ssh banner on port 22 is 'OpenSSH 10.2', which suggests Linux/Unix",
    }


def test_openssh_for_windows_is_not_a_linux_unix_host():
    windows_ssh = port(22, "ssh", "OpenSSH", "for_Windows_9.5", "protocol 2.0")

    assert classifier.classify(device("Unknown"), scan(windows_ssh))["type"] == classifier.UNKNOWN


def test_qemu_vm_with_no_open_ports_is_virtual():
    result = classifier.classify(device("QEMU/KVM virtual machine"), scan())

    assert result == {
        "type": classifier.VIRTUAL,
        "reason": "MAC prefix is QEMU/KVM virtual machine",
    }


def test_virtual_mac_is_noted_on_a_network_device_too():
    result = classifier.classify(device("QEMU/KVM virtual machine"), scan(CISCO_SSH))

    assert result["type"] == classifier.NETWORK_DEVICE
    assert result["reason"].endswith("; MAC prefix is QEMU/KVM virtual machine")


def test_banner_beats_mac_vendor():
    # A Cisco image running as a VMware VM is still a network device.
    result = classifier.classify(device("VMware, Inc."), scan(CISCO_SSH))

    assert result["type"] == classifier.NETWORK_DEVICE


def test_ios_keyword_needs_a_whole_word():
    result = classifier.classify(device("Unknown"), scan(port(80, "upnp", "AwardBIOS httpd")))

    assert result["type"] == classifier.UNKNOWN


def test_unknown_with_no_ports_and_no_vendor_hint():
    result = classifier.classify(device("Unknown"), scan())

    assert result["type"] == classifier.UNKNOWN
    assert result["reason"] == "no open ports found, and MAC vendor 'Unknown' gives no hint"


def test_unknown_with_unrecognised_open_ports():
    result = classifier.classify(device("Unknown"), scan(port(9999)))

    assert result["type"] == classifier.UNKNOWN
    assert "1 open port(s) with no recognisable banner" in result["reason"]


def test_unknown_says_when_the_scan_timed_out():
    result = classifier.classify(device("Unknown"), scan(timed_out=True))

    assert result == {"type": classifier.UNKNOWN, "reason": "port scan timed out before it finished"}


def test_device_with_no_scan_result_falls_back_to_vendor():
    assert classifier.classify(device("VMware, Inc."))["type"] == classifier.VIRTUAL


def test_classify_all_merges_discovery_and_scan_results_by_ip():
    devices = [
        device("VMware, Inc.", ip="192.168.17.1", mac="00:50:56:c0:00:01"),
        device("Locally administered"),
    ]
    scans = [scan(CISCO_SSH, ip="192.168.17.10")]  # nothing for .1

    combined = classifier.classify_all(devices, scans)

    assert [row["ip"] for row in combined] == ["192.168.17.1", "192.168.17.10"]
    assert combined[0]["ports"] == []
    assert combined[0]["type"] == classifier.VIRTUAL
    assert combined[1]["mac"] == "aa:bb:cc:00:01:00"
    assert combined[1]["ports"] == [CISCO_SSH]
    assert combined[1]["type"] == classifier.NETWORK_DEVICE
