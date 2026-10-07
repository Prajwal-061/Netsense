# NetSense

Raspberry Pi-based network discovery and diagnostics system. College project and portfolio piece.

## About the user

Networking student studying for CCNA. Briefly explain what you are doing at each step, including the networking or Python concept behind it.

## What NetSense will do

- Discover devices on the local network with ARP (Scapy) and scan services with Nmap
- SSH into authorized Cisco devices with Netmiko to collect interfaces, VLANs, MAC tables and running configs
- Store scan results and history in a database (SQLAlchemy 2.0, SQLite file `backend/netsense.db`, git-ignored)
- Expose everything through a FastAPI backend and a React dashboard (both built)
- Eventually run on a Raspberry Pi

## Environment

- Dev machine: Ubuntu Server 24.04 VM that stands in for the Pi, Python 3.12
- VM address: 192.168.17.132 on a VMware host-only network (the lab), plus a NAT adapter for internet
- Lab: Cisco CML with a switch at 192.168.17.10 (SSH enabled, VLAN10) on the same host-only network
- System packages installed: git, python3-venv, python3-pip, nmap
- Node.js 24 LTS installed with nvm in the user's home (no sudo). In a non-interactive shell, load it first: `. ~/.nvm/nvm.sh`

## Layout

```
backend/app/engine/   discovery, scanning, classification, device collection
backend/app/api/      FastAPI routes (scans.py, devices.py, health.py), schemas.py, deps.py
backend/app/main.py   FastAPI app: CORS, startup checks, routers
backend/app/db/       database models (models.py) and engine setup (database.py)
backend/app/services/ glue between engine and database (scan_service.py, collection_service.py)
backend/migrations/   Alembic migrations (config in backend/alembic.ini)
backend/app/core/     settings/config
backend/scripts/      runnable scripts (collect_switch.py, discover.py, scan.py)
backend/tests/
backend/.venv/        virtual environment (not committed)
frontend/             React dashboard: Vite + React + TypeScript, Tailwind CSS, TanStack Query
frontend/src/api.ts       typed API client (mirrors backend/app/api/schemas.py)
frontend/src/queries.ts   TanStack Query hooks: all fetching, polling and cache refresh
frontend/src/pages/       Overview, Devices, DeviceDetail, Scans, ScanDetail
frontend/src/components/  shared UI; frontend/src/test/fakeApi.ts fakes the API in tests
lab/                  CML topology and switch configs
docs/
```

## Commands

```bash
source backend/.venv/bin/activate                      # activate the virtual environment
backend/.venv/bin/pip install -r backend/requirements.txt   # install dependencies
cd backend && .venv/bin/pytest                         # run the tests (no lab needed)
cd backend && .venv/bin/alembic upgrade head           # create/upgrade the database (never with sudo)
cd backend && .venv/bin/alembic revision --autogenerate -m "what changed"  # new migration after editing models.py
backend/.venv/bin/python backend/scripts/collect_switch.py  # collect from the lab switch (SSH, show commands only)
cd backend && .venv/bin/uvicorn app.main:app --host 192.168.17.132 --port 8000  # run the API (never as root); docs at http://192.168.17.132:8000/docs
cd frontend && npm run dev       # dashboard dev server at http://192.168.17.132:5173 (API must be running too)
cd frontend && npm test          # page tests (Vitest + jsdom, fake API, no backend needed)
cd frontend && npm run build && npm run lint   # type-check, production build, lint
sudo backend/.venv/bin/python -B backend/scripts/discover.py  # ARP scan of the lab network (root: ask first)
sudo backend/.venv/bin/python -B backend/scripts/scan.py      # ARP scan + Nmap + classifier, saved to the database, prints changes (root: ask first)
```

Imports are rooted at `backend/` (`from app.engine import collector`). Add `--show-config` to `collect_switch.py` to print the full running config.

Discovery and the Nmap scanner only target addresses inside `ALLOWED_SUBNETS` (`.env`, default `192.168.17.0/24`). The VM's other interface, `ens160` on 192.168.44.0/24, is the NAT network and must never be scanned. `-B` stops root writing `__pycache__` files into the repo. `sudo` needs a password on this VM, so the user has to run the sudo commands themselves. `scanner.scan_hosts()` works without root (it falls back from a SYN scan to a connect scan).

Every change to `app/db/models.py` needs a migration; `tests/test_db.py` fails if one is missing. `netsense.db` can hold running configs with password hashes, so it must stay out of git. `collect_switch.py` does not save to the database yet (`collection_service.py` has the functions for it).

## API

- **No authentication yet. It is required before NetSense runs on any real network.** Anyone who can reach the port can start scans and make the server SSH into devices with the stored credentials. Until then: lab network only, and bind uvicorn to the lab address (192.168.17.132), never 0.0.0.0, so it is not served on the NAT interface.
- The API must not run as root. ARP scans need CAP_NET_RAW; `GET /health` reports `raw_sockets` true/false. Without it, `POST /scans` is accepted and the scan is then saved as failed with the reason. Dev option: recreate the venv with `python3 -m venv --copies` and `sudo setcap cap_net_raw+ep` on `.venv/bin/python`, `python3` and `python3.12` (never on the default symlinked venv: that would change `/usr/bin/python3`). On the Pi: a systemd unit with a dedicated user and `AmbientCapabilities=CAP_NET_RAW`.
- Without root, Nmap runs a connect scan (`-sT`); capabilities on Python are not passed on to the Nmap child process.
- One scan at a time (`scan_service.start_scan` raises `ScanInProgressError`, the API answers 409). The lock is per process, so run a single uvicorn worker. Scans left "running" by a crash are marked failed at API start-up.
- `POST /scans` never takes an interface from the client. Config backups are listed as metadata; `GET /devices/{id}/configs/{backup_id}` returns the text with secrets masked by `collection_service.redact_config` (best effort, display only). Never add an endpoint that returns the raw config while there is no authentication.
- `POST /devices/{id}/collect` sends the `.env` credentials to any device classified "network device" inside `ALLOWED_SUBNETS`. The classification comes from a banner the device controls, so restrict this to an explicit list of authorized hosts before leaving the lab.
- Tests set fake credentials and an in-memory `DATABASE_URL` in `tests/conftest.py` before importing the app, so they never read `.env` or `netsense.db`.

## Frontend

- The API base URL comes from `VITE_API_URL` (default `http://192.168.17.132:8000`); override in `frontend/.env.local`. The dashboard's origin must be in the backend's `CORS_ORIGINS`; the defaults cover port 5173 on localhost and 192.168.17.132, and `strictPort` keeps Vite on 5173.
- When an API schema changes, update `frontend/src/api.ts` and `frontend/src/test/fakeApi.ts` to match.
- A running scan is followed by polling `GET /scans` (2 s while running, 30 s otherwise) in `useScans`; `useRefreshWhenScanFinishes` then invalidates every query.
- The UI has not been checked in a real browser from this VM (no browser, and headless Chromium's libraries could not be installed without sudo). Page behaviour is covered by `src/App.test.tsx`; visual changes need the user to look.
- `npm run dev` uses `vite --host`, which listens on every interface including the NAT one. Development only.

## Rules

- Ask before running any sudo command. Scapy ARP scans need raw sockets, so they need root: ask first.
- Do not run network scans or connect to the switch unless the user asks for it in the current session. Only ever target the lab network (192.168.17.0/24 host-only) and authorized devices.
- Never put real credentials in a committed file. Real values go in `.env` (git-ignored); `.env.example` holds placeholders only.
- Running configs collected from switches can contain password hashes, SNMP communities and keys. Sanitize them before saving anything under `lab/` or `docs/`.
- Build one stage at a time, and only what the user asked for in the session.

## Status

- Done: foundation, settings loading (`app/core/config.py`, pydantic-settings), device collector (`app/engine/collector.py`, Netmiko + TextFSM), ARP discovery (`app/engine/discovery.py`, Scapy, offline OUI vendor lookup), Nmap service scanner (`app/engine/scanner.py`, XML parsed with ElementTree), rule-based device classifier (`app/engine/classifier.py`), database models and Alembic migrations, scan service with change detection between scans, FastAPI backend (scans in the background, devices, collection, CORS), React dashboard (overview, devices, device detail with collection, scan history). Backend and frontend both have tests that need no lab.
- Not built yet: authentication, deployment on the Pi.
