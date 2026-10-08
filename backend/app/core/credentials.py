"""Login credentials for network devices.

Everything that needs to log in asks credentials_for(host). Today every
device uses the one lab account from .env. When devices get their own
accounts, this function is the single place to change: look the host up in
a per-device store and fall back to the default.
"""

from dataclasses import dataclass, field

from app.core.config import Settings


@dataclass(frozen=True)
class Credentials:
    username: str
    # repr=False keeps the password out of logs, tracebacks and debug output.
    password: str = field(repr=False)


def credentials_for(host: str, settings: Settings) -> Credentials:
    """Return the credentials to use for the device at this address."""
    return Credentials(
        username=settings.lab_switch_username,
        password=settings.lab_switch_password.get_secret_value(),
    )
