"""Application settings, loaded from the .env file in the project root."""

from functools import lru_cache
from pathlib import Path

from pydantic import SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict

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


@lru_cache
def get_settings() -> Settings:
    """Return the settings, reading .env only on the first call."""
    return Settings()
