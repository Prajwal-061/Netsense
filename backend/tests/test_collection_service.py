"""Collection service tests on an in-memory database."""

from app.db.models import ConfigBackup, Device
from app.engine import config_diff
from app.services import collection_service
from tests.sample_configs import BASE, NEW_VLAN, SAME_LATER

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


def test_backup_links_to_the_scanned_device_at_that_address(session):
    device = Device(mac="aa:bb:cc:00:01:00", last_ip=HOST)
    session.add(device)
    session.commit()

    backup, _ = collection_service.save_config_backup(session, HOST, CONFIG_A)

    assert backup.device == device


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
    redacted = config_diff.redact_config(IOS_CONFIG)

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


def test_config_with_only_new_timestamps_is_not_stored_again(session):
    first, _ = collection_service.save_config_backup(session, HOST, BASE)
    second, created = collection_service.save_config_backup(session, HOST, SAME_LATER)

    assert not created
    assert second.id == first.id
    assert session.query(ConfigBackup).count() == 1
    # The stored text is the raw config as first collected, header included.
    assert first.config == BASE
    assert first.sha256 == config_diff.config_hash(BASE)


def test_real_change_is_stored_even_when_timestamps_changed_too(session):
    collection_service.save_config_backup(session, HOST, BASE)
    backup, created = collection_service.save_config_backup(session, HOST, NEW_VLAN)

    assert created
    assert session.query(ConfigBackup).count() == 2
    assert collection_service.latest_backup(session, HOST).id == backup.id
    assert collection_service.latest_backup(session, HOST, before_id=backup.id).config == BASE


def test_comparison_does_not_trust_a_stale_stored_hash(session):
    # A backup saved before normalisation existed: its hash is of the raw text.
    old = ConfigBackup(host=HOST, sha256="0" * 64, config=BASE)
    session.add(old)
    session.commit()

    _, created = collection_service.save_config_backup(session, HOST, SAME_LATER)

    assert not created
