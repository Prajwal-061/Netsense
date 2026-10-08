"""A fake lab for tests: the four lab devices, answering from recorded output.

tests/fixtures/lab_outputs.json holds the raw text each show command printed
on the real devices (two IOSv routers, two IOL switches). FakeDevice stands
in for a Netmiko connection and parses that text with the real TextFSM
templates, exactly as Netmiko would. No network is involved.
"""

import json
from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from netmiko.utilities import get_structured_data_textfsm

from app.engine import collector
from tests.sample_configs import BASE

LAB = json.loads((Path(__file__).parent / "fixtures" / "lab_outputs.json").read_text())
HOSTS = {name: device["host"] for name, device in LAB.items()}  # "R1" -> "192.168.17.3"

INVALID_INPUT = "                     ^\n% Invalid input detected at '^' marker."


class FakeDevice:
    """Stands in for a Netmiko connection to one lab device."""

    def __init__(self, name: str):
        self.name = name
        self.host = HOSTS[name]
        # Tests change entries to change what the device "returns". A value
        # that is an exception is raised; anything not a string is returned as is.
        self.outputs = dict(LAB[name]["outputs"])
        self.outputs["show running-config"] = BASE.replace("hostname SW1", f"hostname {name}")
        self.sent: list[str] = []
        self.disconnected = 0
        # IOSv only has an RSA host key used with SHA-1; IOL offers SHA-2.
        host_key = "ssh-rsa" if name.startswith("R") else "rsa-sha2-512"
        transport = SimpleNamespace(host_key_type=host_key)
        self.remote_conn = SimpleNamespace(get_transport=lambda: transport)

    def send_command(self, command, use_textfsm=False):
        self.sent.append(command)
        output = self.outputs.get(command, INVALID_INPUT)
        if isinstance(output, BaseException):
            raise output
        if use_textfsm and isinstance(output, str):
            return get_structured_data_textfsm(output, platform="cisco_ios", command=command)
        return output

    def disconnect(self):
        self.disconnected += 1


class FakeLab:
    """Replaces collector.connect: hands out FakeDevices by IP address."""

    def __init__(self, *names):
        self.devices = {name: FakeDevice(name) for name in names or LAB}
        self.errors: dict[str, Exception] = {}  # host -> error raised on connect
        self.logins: list[tuple] = []  # (host, username, password) of every attempt

    def __getitem__(self, name: str) -> FakeDevice:
        return self.devices[name]

    def fail(self, name: str, error: Exception) -> None:
        self.errors[HOSTS[name]] = error

    def connect(self, host, username, password, port=22, timeout=10):
        self.logins.append((host, username, password))
        if host in self.errors:
            raise self.errors[host]
        for device in self.devices.values():
            if device.host == host:
                return device
        raise collector.DeviceUnreachableError(f"Unreachable: cannot open TCP port 22 on {host}.")


@contextmanager
def fake_lab(*names):
    lab = FakeLab(*names)
    with patch.object(collector, "connect", side_effect=lab.connect) as connect:
        lab.connect_mock = connect
        yield lab
