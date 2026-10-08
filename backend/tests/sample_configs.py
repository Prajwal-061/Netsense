"""Running configs for tests, shaped like the lab switch's (all secrets are fake)."""

BASE = """\
Building configuration...

Current configuration : 3306 bytes
!
! Last configuration change at 19:12:01 UTC Wed Oct 7 2026
!
version 17.18
service timestamps log datetime msec
hostname SW1
!
enable secret 9 $9$fakeHashAAAA
!
vlan 10
 name USERS
!
interface Ethernet0/0
 switchport access vlan 10
 switchport mode access
!
interface Ethernet0/1
 switchport access vlan 10
 switchport mode access
!
interface Vlan10
 ip address 192.168.17.10 255.255.255.0
!
snmp-server community fakeCommunity RO
!
end
"""

# The same configuration read a day later: someone entered and left config
# mode and saved, so only the timestamps and the NVRAM line differ.
SAME_LATER = (
    BASE.replace(
        "! Last configuration change at 19:12:01 UTC Wed Oct 7 2026",
        "! Last configuration change at 08:30:15 UTC Thu Oct 8 2026 by netadmin\n"
        "! NVRAM config last updated at 08:30:20 UTC Thu Oct 8 2026 by netadmin",
    )
    .replace("Current configuration : 3306 bytes", "Current configuration : 3391 bytes")
    .replace("\n", "\r\n")  # and it arrived with Windows line endings
)

# A real change: VLAN 20 is created and Ethernet0/1 is moved into it.
NEW_VLAN = (
    BASE.replace(" name USERS\n!\n", " name USERS\n!\nvlan 20\n name SERVERS\n!\n")
    .replace(
        "interface Ethernet0/1\n switchport access vlan 10",
        "interface Ethernet0/1\n switchport access vlan 20",
    )
    .replace("3306 bytes", "3340 bytes")
    .replace("19:12:01 UTC Wed Oct 7", "09:00:00 UTC Thu Oct 8")
)

# Only the enable secret changed.
NEW_SECRET = BASE.replace("$9$fakeHashAAAA", "$9$fakeHashBBBB")
