"""Create the NetSense admin user, or set a new password for it.

Usage, from backend/ with the venv active (not with sudo):
    python scripts/create_admin.py              # user "admin"
    python scripts/create_admin.py --username alice

The password is asked for twice and never echoed or stored in plain text.
Setting a new password logs out every browser that was logged in.
"""

import argparse
import getpass
import sys
from pathlib import Path

# Make the "app" package importable when this file is run as a script.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sqlalchemy.orm import Session  # noqa: E402

from app.db.database import create_db_engine, is_migrated  # noqa: E402
from app.services import auth_service  # noqa: E402


def main(argv=None, ask=getpass.getpass) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--username", default="admin")
    args = parser.parse_args(argv)

    engine = create_db_engine()
    if not is_migrated(engine):
        print("ERROR: the database is not set up. Run: alembic upgrade head", file=sys.stderr)
        return 1

    password = ask(f"New password for {args.username} (at least {auth_service.MIN_PASSWORD_LENGTH} characters): ")
    if password != ask("Same password again: "):
        print("ERROR: the two passwords are different. Nothing was changed.", file=sys.stderr)
        return 1
    with Session(engine) as session:
        existed = auth_service.admin_exists(session)
        try:
            auth_service.set_admin_password(session, args.username, password)
        except auth_service.PasswordTooWeakError as exc:
            print(f"ERROR: {exc} Nothing was changed.", file=sys.stderr)
            return 1
    print(f"Password {'changed' if existed else 'set'} for {args.username}. Log in to the dashboard with it.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
