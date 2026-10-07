"""Collection service tests on an in-memory database."""

from app.db.models import ConfigBackup, Device
from app.services import collection_service

HOST = "192.168.17.10"
CONFIG_A = "hostname SW1\n!\ninterface Vlan10\n ip address 192.168.17.10 255.255.255.0\n!\nend"
CONFIG_B = CONFIG_A.replace("SW1", "SW1-CORE")


def test_identical_config_is_not_stored_twice(session):
    first, created_first = collection_service.save_config_backup(session, HOST, CONFIG_A)
    second, created_second = collection_service.save_config_backup(session, HOST, CONFIG_A)

    assert created_first and not created_second
    assert second.id == first.id
    assert second.last_seen_at >= second.collected_at
    assert session.query(ConfigBackup).count() == 1


def test_changed_config_is_stored_as_a_new_version(session):
    collection_service.save_config_backup(session, HOST, CONFIG_A)
    backup, created = collection_service.save_config_backup(session, HOST, CONFIG_B)

    assert created
    assert backup.config == CONFIG_B
    assert len(backup.sha256) == 64
    assert session.query(ConfigBackup).count() == 2


def test_reverting_to_an_old_config_is_kept_as_history(session):
    for config in (CONFIG_A, CONFIG_B, CONFIG_A):
        collection_service.save_config_backup(session, HOST, config)

    backups = session.query(ConfigBackup).order_by(ConfigBackup.id).all()
    assert [backup.config for backup in backups] == [CONFIG_A, CONFIG_B, CONFIG_A]
    assert backups[0].sha256 == backups[2].sha256


def test_same_config_on_two_hosts_is_stored_for_each(session):
    collection_service.save_config_backup(session, HOST, CONFIG_A)
    _, created = collection_service.save_config_backup(session, "192.168.17.11", CONFIG_A)

    assert created


def test_backup_and_collection_link_to_the_scanned_device_at_that_address(session):
    device = Device(mac="aa:bb:cc:00:01:00", last_ip=HOST)
    session.add(device)
    session.commit()

    backup, _ = collection_service.save_config_backup(session, HOST, CONFIG_A)
    collection = collection_service.save_collection(session, HOST, [], [], [])

    assert backup.device == device
    assert collection.device == device


def test_collection_keeps_structured_data_and_raw_text_fallback(session):
    interfaces = [{"interface": "Vlan10", "ip_address": "192.168.17.10", "status": "up"}]
    vlans = [{"vlan_id": "10", "vlan_name": "VLAN0010", "interfaces": ["Et0/0", "Et0/1"]}]
    raw_mac_table = "Mac Address Table\n(output TextFSM could not parse)"

    saved = collection_service.save_collection(session, HOST, interfaces, vlans, raw_mac_table)
    session.expire_all()

    assert saved.device is None  # no scan has found this host yet
    assert saved.interfaces == interfaces
    assert saved.vlans == vlans
    assert saved.mac_table == raw_mac_table
    assert saved.collected_at.tzinfo is not None


IOS_CONFIG = """\
service password-encryption
hostname SW1
enable secret 9 $9$abcDEF123
enable password 7 0822455D0A16
username netsense privilege 15 secret 9 $9$xyz789
snmp-server community s3cretRO RO
snmp-server community s3cretRW RW 10
key chain OSPF-KEYS
 key 1
  key-string 7 094F471A1A0A
crypto isakmp key MyPSK address 10.0.0.1
ntp authentication-key 1 md5 15060E1F10 7
tacacs-server key 7 1234ABCD
interface Vlan10
 ip address 192.168.17.10 255.255.255.0
 ip ospf message-digest-key 1 md5 7 AAAA1111
line vty 0 4
 password 7 110A1016141D
 transport input ssh
"""


def test_redact_config_masks_secrets_and_keeps_everything_else():
    redacted = collection_service.redact_config(IOS_CONFIG)

    for secret in (
        "$9$abcDEF123", "0822455D0A16", "$9$xyz789", "s3cretRO", "s3cretRW",
        "094F471A1A0A", "MyPSK", "15060E1F10", "1234ABCD", "AAAA1111", "110A1016141D",
    ):  # fmt: skip
        assert secret not in redacted

    lines = redacted.splitlines()
    assert len(lines) == len(IOS_CONFIG.splitlines())
    # Structure and non-secret settings survive, so the config stays readable.
    assert "service password-encryption" in lines
    assert "enable secret <redacted>" in lines
    assert "username netsense privilege 15 secret <redacted>" in lines
    assert "snmp-server community <redacted>" in lines
    assert "key chain OSPF-KEYS" in lines
    assert "ntp authentication-key <redacted>" in lines
    assert " ip ospf message-digest-key <redacted>" in lines
    assert "crypto isakmp key <redacted>" in lines
    assert " ip address 192.168.17.10 255.255.255.0" in lines
    assert " transport input ssh" in lines
