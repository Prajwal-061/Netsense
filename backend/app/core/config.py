"""Application settings, loaded from the .env file in the project root."""

from functools import lru_cache
from ipaddress import IPv4Network
from pathlib import Path
from typing import Annotated

from pydantic import SecretStr, field_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict

# config.py -> core -> app -> backend -> project root
PROJECT_ROOT = Path(__file__).resolve().parents[3]


class Settings(BaseSettings):
    """Each field is read from the environment variable of the same name
    (case-insensitive), e.g. lab_switch_host <- LAB_SWITCH_HOST."""

    model_config = SettingsConfigDict(env_file=PROJECT_ROOT / ".env", extra="ignore")

    lab_switch_host: str
    lab_switch_username: str
    # SecretStr shows as '**********' in repr(), print() and logs. The real
    # value is only available through .get_secret_value().
    lab_switch_password: SecretStr

    # The only networks discovery is allowed to scan, comma-separated in .env.
    # NoDecode stops pydantic-settings expecting JSON, so the validator below
    # can split a plain "a,b" string instead.
    allowed_subnets: Annotated[list[IPv4Network], NoDecode] = [IPv4Network("192.168.17.0/24")]

    # SQLAlchemy database URL. SQLite is one file; switching to PostgreSQL is
    # only a different URL, e.g. postgresql+psycopg://user:pass@host/netsense
    database_url: str = f"sqlite:///{PROJECT_ROOT / 'backend' / 'netsense.db'}"

    # Web pages allowed to call the API from a browser (CORS), comma-separated.
    # The defaults are the Vite dev server (port 5173) on a laptop or on this VM.
    # Only the dashboard's own origin: the API sends cookies cross-origin to
    # whatever is listed here, so keep it to the one page that needs them.
    cors_origins: Annotated[list[str], NoDecode] = ["http://192.168.17.132:5173"]

    # How long a login lasts before the admin has to log in again.
    session_hours: int = 8
    # Send the session cookie over HTTPS only. Leave off in the lab (plain
    # HTTP); turn on once NetSense is served over HTTPS.
    session_cookie_secure: bool = False

    @field_validator("allowed_subnets", "cors_origins", mode="before")
    @classmethod
    def _split_commas(cls, value):
        if isinstance(value, str):
            return [part.strip() for part in value.split(",") if part.strip()]
        return value


@lru_cache
def get_settings() -> Settings:
    """Return the settings, reading .env only on the first call."""
    return Settings()
