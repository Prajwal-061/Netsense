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
- Lab: Cisco CML (host 192.168.17.128), described under "Lab" below
- System packages installed: git, python3-venv, python3-pip, nmap
- Node.js 24 LTS installed with nvm in the user's home (no sudo). In a non-interactive shell, load it first: `. ~/.nvm/nvm.sh`

## Lab

Management network 192.168.17.0/24 (out-of-band, one port per device, CDP disabled on those ports). This is the only network NetSense scans or logs in over.

| Device | Type | Management | Notes |
|---|---|---|---|
| R1 | IOSv router (IOS 15.9) | 192.168.17.3, Gi0/0 | Router-on-a-stick on Gi0/1 for VLAN 20 and 30; Gi0/2 to R2 |
| R2 | IOSv router (IOS 15.9) | 192.168.17.4, Gi0/0 | Gi0/1 to R1; loopbacks 10.2.1.0/24 and 10.2.2.0/24 |
| SW1 | IOL switch (IOS XE 17.18) | 192.168.17.10, Et0/0 | Et0/1 trunk to R1; Et0/2-0/3 trunks to SW2; STP root for VLAN 20 and 30 |
| SW2 | IOL switch (IOS XE 17.18) | 192.168.17.11, Et0/0 | Et0/1-0/2 trunks to SW1 (one is blocked by STP); Et0/3 to the Alpine host |

- Data network: VLAN 20 USERS 10.1.20.0/24 and VLAN 30 SERVERS 10.1.30.0/24, routed on R1. R1 to R2 is 10.0.12.0/30, OSPF area 0. Alpine host 10.1.20.10 on SW2 Et0/3 (VLAN 20). None of this is reachable from, or scanned by, the VM.
- All devices use the same lab credentials from `.env` (`LAB_SWITCH_USERNAME` / `LAB_SWITCH_PASSWORD`, names kept from when there was one switch). Code gets them through `app/core/credentials.py::credentials_for(host, settings)`, the one place to change when devices get their own accounts.
- The IOSv routers only offer SHA-1 SSH (`diffie-hellman-group14-sha1` key exchange, `ssh-rsa` host key). Paramiko 4+ removed both, so `requirements.txt` pins `paramiko<4`; do not lift the pin while IOSv is in the lab (`tests/test_collector_lab.py` fails if it is lifted). Each collection from such a device records a "legacy SSH" note.
- `tests/fixtures/lab_outputs.json` holds the raw output of every collected show command from all four devices (no running configs). `tests/lab.py` replays it through the real TextFSM templates as a fake lab.

## Layout

```
backend/app/engine/   discovery, scanning, classification, device collection, topology, drift
backend/app/api/      FastAPI routes (scans.py, devices.py, collections.py, topology.py, drift.py, health.py), schemas.py, deps.py
backend/app/main.py   FastAPI app: CORS, startup checks, routers
backend/app/db/       database models (models.py) and engine setup (database.py)
backend/app/services/ glue between engine and database (scan_service.py, collection_service.py, drift_service.py)
backend/migrations/   Alembic migrations (config in backend/alembic.ini)
backend/app/core/     settings/config
backend/scripts/      runnable scripts (collect_switch.py, discover.py, scan.py)
backend/tests/
backend/.venv/        virtual environment (not committed)
frontend/             React dashboard: Vite + React + TypeScript, Tailwind CSS, TanStack Query
frontend/src/api.ts       typed API client (mirrors backend/app/api/schemas.py)
frontend/src/queries.ts   TanStack Query hooks: all fetching, polling and cache refresh
frontend/src/pages/       Login, Overview, NetworkHealth, Devices, DeviceDetail, Scans, ScanDetail, Collections, Topology
frontend/src/topology/    the map: flow.ts (layout and styling), TopologyMap (shared by Topology and Network health), DeviceNode, LinkEdge
frontend/src/components/  shared UI; frontend/src/test/fakeApi.ts fakes the API in tests
lab/                  CML topology and switch configs
docs/
```

## Commands

```bash
# Backend (from backend/, as the normal user, never root)
source .venv/bin/activate
python -m uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload   # API; docs at http://192.168.17.132:8000/docs
pytest                                                       # tests (no lab needed)
alembic upgrade head                                         # create/upgrade the database (never with sudo)
alembic revision --autogenerate -m "what changed"            # new migration after editing models.py
python scripts/collect_switch.py                             # collect from the lab switch (SSH, show commands only)
python scripts/discover.py                                   # ARP scan of the lab network
python scripts/scan.py                                       # ARP scan + Nmap + classifier, saved, prints changes
python scripts/create_admin.py                               # create the dashboard admin, or set a new password

# Frontend (from frontend/; in a non-interactive shell run `. ~/.nvm/nvm.sh` first)
npm run dev -- --host            # dashboard at http://192.168.17.132:5173 (API must be running too)
npm test                         # page tests (Vitest + jsdom, fake API, no backend needed)
npm run test:browser             # Playwright + axe-core: WCAG AA contrast of every page, both themes
npm run build && npm run lint    # type-check, production build, lint

# Without activating the venv, use backend/.venv/bin/python (not python3) in place of python
```

Start the API with `python -m uvicorn`, not the `uvicorn` script: only `.venv/bin/python` is guaranteed to hold `cap_net_raw`, and the script's shebang names `python3`. Scans and collection are network actions: the scan scripts, `POST /scans` and `POST /devices/{id}/collect` still fall under the Rules below.

Imports are rooted at `backend/` (`from app.engine import collector`). Add `--show-config` to `collect_switch.py` to print the full running config.

Discovery and the Nmap scanner only target addresses inside `ALLOWED_SUBNETS` (`.env`, default `192.168.17.0/24`). The VM's other interface, `ens160` on 192.168.44.0/24, is the NAT network and must never be scanned. If a scan script is ever run with sudo, add `-B` so root does not write `__pycache__` files into the repo. `sudo` needs a password on this VM, so the user has to run any sudo command themselves; with the capability set, scans do not need sudo.

Every change to `app/db/models.py` needs a migration; `tests/test_db.py` fails if one is missing. `netsense.db` can hold running configs with password hashes, so it must stay out of git. `collect_switch.py` does not save to the database yet (`collection_service.py` has the functions for it).

## API

- **Authentication** (`app/services/auth_service.py`, `app/api/auth.py`): one admin user, created or reset with `python scripts/create_admin.py` (argon2id hash, at least 10 characters; resetting deletes all sessions). `POST /auth/login` sets `netsense_session`, an HttpOnly, SameSite=Strict cookie holding a random token; the `auth_sessions` table stores only its SHA-256 and an absolute expiry (`SESSION_HOURS`, default 8). Logout deletes the row. Every router except `health` and `auth` is included with `dependencies=[Depends(auth.require_admin)]`; a new router must be too (`tests/test_auth.py` checks every route from the OpenAPI description). Failed logins: 5 per client address per 15 minutes, in memory (`LoginRateLimiter`), then 429.
- The cookie only works when the dashboard and API share a host name (SameSite compares the site, not the port); `CORS_ORIGINS` defaults to only `http://192.168.17.132:5173` and CORS allows credentials, so never set it to `*`. `SESSION_COOKIE_SECURE` must stay false on plain HTTP or the browser drops the cookie. `/docs` and `/openapi.json` stay public (schema only, no data).
- Still lab-only: no HTTPS, so the login and cookie cross the network unencrypted. Bind uvicorn to the lab address rather than 0.0.0.0 when possible.
- Test fixtures: `client` is logged in (session created directly, no argon2 cost); `anon_client` is not.
- The API must not run as root. ARP scans need CAP_NET_RAW; `GET /health` reports `raw_sockets` true/false. Without it, `POST /scans` is accepted and the scan is then saved as failed with the reason. Dev setup (README, "Letting the API scan without root"), applied on this VM: `backend/.venv` is built with `python3 -m venv --copies`, `.venv/bin/python3` and `python3.12` are symlinks to `.venv/bin/python`, and that one file has `cap_net_raw=ep` (the user ran `sudo setcap cap_net_raw+ep .venv/bin/python`). `setcap` takes one capability and one file per pair; a list of files after one capability only sets the first. Rebuilding the venv drops the capability: rebuild with `--copies`, recreate the two symlinks, and have the user repeat the setcap. Never setcap a symlinked venv: that would change `/usr/bin/python3`. On the Pi: a systemd unit with a dedicated user and `AmbientCapabilities=CAP_NET_RAW`.
- Nmap does not inherit file capabilities from Python, so `scanner._nmap_prefix` starts it through `app/engine/pass_caps.py`, which raises `CAP_NET_RAW` into the ambient set and execs `nmap --privileged -sS`. `/usr/bin/nmap` has no capabilities and must stay that way. With neither root nor the capability the scanner falls back to a connect scan (`-sT`). `cap_net_admin` is not needed.
- One scan at a time (`scan_service.start_scan` raises `ScanInProgressError`, the API answers 409). The lock is per process, so run a single uvicorn worker. Scans left "running" by a crash are marked failed at API start-up.
- `POST /scans` never takes an interface from the client. Config backups are listed as metadata; `GET /devices/{id}/configs/{backup_id}` returns the text with secrets masked by `config_diff.redact_config` (best effort, display only). Never add an endpoint that returns the raw config while there is no authentication.
- Network collection: `POST /collections` logs in to every device typed router, switch or network device (inside `ALLOWED_SUBNETS`, at its last scanned IP), `MAX_PARALLEL_DEVICES` (4) at a time. Worker threads only talk to devices (`collector.collect_host`); all database writes happen in the coordinating thread as each device finishes. One run at a time (409). Results are `device_collections` rows with status pending/success/failed, linked to a `network_collections` run.
- What is collected is defined once, in `collector.COMMANDS` (key, command, scope all/switch/router). All output goes into `device_collections.data`, one JSON document keyed by those names, so adding a command needs no migration: add it to `COMMANDS`, to `DATA_ENDPOINTS` in `app/api/devices.py`, and to the dashboard's tabs. `show interfaces trunk` has no TextFSM template and is parsed by `collector.parse_interfaces_trunk`.
- Only show commands are ever sent (`collector._show` refuses anything else). Never add a command that enters configuration mode.
- Config text logic lives in `app/engine/config_diff.py`: `normalize_config` drops lines that change without a config change (banner, byte count, timestamps), `config_hash` hashes the normalised text, `diff_configs` returns a unified diff plus added/removed counts. Backups store the raw text and the normalised hash. Diffs are redacted after diffing, so a changed secret still shows as a changed line. Changing the normalisation rules needs a migration that re-hashes existing rows (see `migrations/versions/0002_*`).
- Diff endpoints: `GET /devices/{id}/configs/diff?from_id=&to_id=` and `/configs/diff/latest`. They are declared before `/configs/{backup_id}` on purpose (route order).
- The lab switch runs in VTP server mode, so VLAN definitions are in `vlan.dat`, not in the running config: creating a VLAN does not show in a config diff, only the interface lines that use it.
- `POST /devices/{id}/collect` sends the `.env` credentials to any device classified "network device", "router" or "switch" inside `ALLOWED_SUBNETS`. The classification comes from a banner the device controls, so restrict this to an explicit list of authorized hosts before leaving the lab.
- CORS: `ALLOWED_METHODS` in `app/main.py` must list every HTTP method a route uses (`tests/test_api.py` checks it); a missing one makes the browser drop the request after its preflight, which the page could only report as a failed fetch. The test client skips CORS, so only that test catches it. `UnhandledErrorsAsJson` sits inside `CORSMiddleware` so even a 500 carries CORS headers; it returns only the exception type, the rest goes to the log.
- Dashboard errors (`frontend/src/api.ts`): an HTTP error shows the server's `detail`; a failed fetch is probed with `GET /health` to tell "blocked by the browser (CORS)" from "API not reachable".
- Tests set fake credentials and an in-memory `DATABASE_URL` in `tests/conftest.py` before importing the app, so they never read `.env` or `netsense.db`.

## Topology

- `app/engine/topology.py::build_topology(collected, known_hosts, management_network)` is a pure function (dicts in, dicts out; no database, network or clock) with stable ids (`dev:<hostname>`, `host:<mac>`, `nbr:<name>`, link id from its two ends), so runs can be compared later. `collection_service.build_run_topology` gathers its inputs and stores the result in `network_collections.topology` at the end of each run; older runs get theirs computed on first `GET /topology`.
- Rules: device links come from CDP, merged by the unordered pair of (node, interface) ends, so parallel links stay separate. A MAC on a switch port is a host unless the port is a trunk, has a CDP neighbour, or belongs to the management network. CDP neighbours that were not collected become `unknown` nodes. A device whose login failed is matched to its CDP entry by its hostname from an earlier collection, because the address CDP reports is the neighbour's address on that link, not its management address.
- The management network is recognised from data, not configured: the interface holding the address NetSense logged in to, or for an SVI (`Vlan10`) that VLAN and its access ports. It is returned under `management`, never as links.
- Interface names are normalised with `short_interface` (CDP says `Ethernet0/2`, trunk and STP tables say `Et0/2`), MACs with `normalize_mac`.
- A silent host ages out of a switch's MAC table after about 5 minutes but stays in a router's ARP table for hours. Such hosts are returned in `unplaced_hosts` and listed under the map; no port is guessed for them. In the lab this regularly applies to the Alpine host.
- A down link usually disappears from CDP within its 180 s holdtime, so "down" is rarely seen in one topology; detecting a missing link is a job for comparing runs.
- Dashboard: `frontend/src/topology/flow.ts` (pure layout and styling, tested in `flow.test.ts`), `DeviceNode.tsx`, `LinkEdge.tsx`, `pages/Topology.tsx`, using React Flow (`@xyflow/react`). jsdom cannot lay out React Flow, so links are not drawn in page tests; `src/test/setup.ts` holds the browser-API stand-ins.

## Baseline and drift

- `app/engine/drift.py::compare_snapshots(baseline, current)` is a pure function. Snapshots come from `drift_service.snapshot(session, run)`: per device its data, config text (from its config backup) and name, plus the run's topology. The module docstring lists what is compared and what is treated as noise; keep it in sync when rules change.
- Noise, never compared: ARP and MAC tables (hosts are compared through the topology, and a host still in an ARP table is quiet, not missing), uptime, OSPF dead time and the DR/BDR part of neighbour states, route uptime/metric/distance, local `L` routes, STP cost/port id/type, trunk active/forwarding VLANs, config timestamps (normalised), row order. Verified on real data: collections #1 and #3 (9 Oct) compare with zero findings.
- Config changes are split per section (`interface X`, `router ospf 1`, global lines; an edited one-line global command is paired by its first two words), so each can be a probable cause on its own. OSPF `network` statements are mapped to the interfaces whose addresses they cover.
- Correlation (`_correlate`): a config change is a probable cause of a state change in the same place (same device and interface, the far end of a link in either topology, or for STP the same VLAN on any switch); shutting/unshutting a trunk is linked to STP changes in the VLANs it carries; lost routes link to the lost OSPF neighbour (next hop) or the downed interface they were connected on; an unreachable device links to neighbours that lost it. A config change's severity is raised to its worst effect.
- Root bridge per VLAN is derived (the parsed STP table has no root ID): the switch whose ports in that VLAN are all designated.
- Baselines are a history table (`baselines`, newest is current); any finished collection with at least one device reached can be chosen. `drift_checks` stores each report as computed. `POST /drift-checks` with `collection_id` compares an existing collection without contacting devices (201); without it, it collects first (202).
- On 2026-10-24 the lab was deliberately broken (R1 OSPF area 1 on the link to R2, SW2 Et0/3 to VLAN 30, SW2 STP priority 0 for VLAN 20, VLAN 20 removed from SW1's trunk to R1, R2 Loopback1 shut). Collections #1-#3 (9 Oct) are healthy; #4 (24 Oct) is the broken state and must never be the baseline. `tests/drift_lab.py` reproduces the five changes; `frontend/src/test/driftReport.json` is the engine's report for them.

## Classification

- Device type and virtualisation are separate. `discovery.lookup_virtualization(mac)` gives the platform (QEMU/KVM, VMware, ...) from the MAC prefix and is stored in `devices.virtualization`; it never decides the type. There is no "virtual" device type any more (old scan results may still show `VMware/virtual`).
- Type evidence, strongest first (`app/engine/classifier.py`): a successful login (`classify_collected`, from `show version` and the VLAN table: `router` or `switch`), a network-OS service fingerprint such as a Cisco SSH banner (`network device`), server services, a Linux/OpenSSH banner, a network vendor's MAC OUI, else `unknown`.
- `devices.type_source` is `collected` once a login confirmed the type; `scan_service.save_results` then leaves the device's type alone. Each scan result still records that scan's own guess.
- A device with no open ports can only be `unknown`. The lab's IOSv router at 192.168.17.3 had SSH disabled on 2026-10-08, which is why it was not recognised; that is a device configuration matter for the user, not a classifier bug. (It answers ping with TTL 255, typical of Cisco IOS, which could become a weak hint if ever needed.)

## After changing backend code

- A running backend keeps the code it started with. After any backend change, the user's API must be restarted (or be running with `--reload`) before the feature is tested, and `alembic upgrade head` must have been run. Check the running process, not just the tests: `curl -s http://127.0.0.1:8000/health` shows `api_revision`, and `/openapi.json` lists the routes it really serves. On 2026-10-08 a backend started before the config-diff feature produced three "bugs" at once: 422 "valid integer" on `/configs/diff`, wrong "no change" badges, and duplicate backups with old-style hashes.
- `API_REVISION` in `backend/app/api/health.py` and `REQUIRED_API_REVISION` in `frontend/src/api.ts` must be equal (currently 8; the frontend's lives in `frontend/src/revision.ts`). Add 1 to both whenever an endpoint or response field the dashboard uses is added or changed. The dashboard shows a warning banner when the backend reports a lower number.
- The API refuses to start when the database is not at the newest migration (`database.migration_status`), with a message to run `alembic upgrade head`.
- Never apply a migration that changes how stored data is interpreted while an old backend is still running against the same database: the old code then writes inconsistent rows (migration `0003` repairs the config backups this produced).

## Frontend

- The API base URL comes from `VITE_API_URL` (default `http://192.168.17.132:8000`); override in `frontend/.env.local`. The dashboard's origin must be in the backend's `CORS_ORIGINS`; the defaults cover port 5173 on localhost and 192.168.17.132, and `strictPort` keeps Vite on 5173.
- When an API schema changes, update `frontend/src/api.ts` and `frontend/src/test/fakeApi.ts` to match.
- A running scan is followed by polling `GET /scans` (2 s while running, 30 s otherwise) in `useScans`; `useRefreshWhenScanFinishes` then invalidates every query.
- Page behaviour is covered by `src/App.test.tsx` (jsdom). Real-browser tests are in `e2e/` (Playwright, headless Chromium): `contrast.spec.ts` runs axe-core's colour-contrast rule on every page in both themes against a fake API (`e2e/fakeApi.ts`, data from `src/test/fixtures.ts`, shared with the page tests), and saves dark-theme screenshots to `frontend/test-results/screenshots/` (git-ignored). Look at them after visual changes.
- Chromium's system libraries are not installed system-wide on this VM. `npm run chromium-libs` unpacks them without sudo into `~/.cache/netsense-chromium-libs` (`apt-get download` + `dpkg -x`), and `playwright.config.ts` adds that folder to `LD_LIBRARY_PATH`. Already done on this VM.
- Colours: components use only the tokens in `src/index.css` (see docs/ui-design.md). Text uses `fg`, `fg-muted`, `fg-subtle`, `link` or a status `-fg` token, never the bare `ok`/`crit`/`accent` (those are for dots, bars and lines) and never a raw Tailwind palette colour.
- The dev server is started with `npm run dev -- --host`, which listens on every interface including the NAT one. Development only.

## Rules

- Ask before running any sudo command. Scapy ARP scans need raw sockets, so they need root: ask first.
- Do not run network scans or connect to the switch unless the user asks for it in the current session. Only ever target the lab network (192.168.17.0/24 host-only) and authorized devices.
- Never put real credentials in a committed file. Real values go in `.env` (git-ignored); `.env.example` holds placeholders only.
- Running configs collected from switches can contain password hashes, SNMP communities and keys. Sanitize them before saving anything under `lab/` or `docs/`.
- Build one stage at a time, and only what the user asked for in the session.

## Status

- Done: foundation, settings loading (`app/core/config.py`, pydantic-settings), device collector (`app/engine/collector.py`, Netmiko + TextFSM), ARP discovery (`app/engine/discovery.py`, Scapy, offline OUI vendor lookup), Nmap service scanner (`app/engine/scanner.py`, XML parsed with ElementTree), device classifier (`app/engine/classifier.py`: scan-based guesses, confirmation by login, virtualisation as a separate attribute), database models and Alembic migrations, scan service with change detection between scans, config backups with normalised hashing and diffs, collection from all routers and switches in parallel (routes, OSPF, STP, trunks, CDP, ARP), topology built from each collection and drawn as an interactive map, baselines and drift checks with probable-cause correlation (Network health page), FastAPI backend (scans in the background, devices, collection, CORS), React dashboard (overview, devices, device detail with collection, scan history). Backend and frontend both have tests that need no lab.
- Done also: single-admin authentication with session cookies.
- Not built yet: HTTPS, scheduled drift checks and alerts, deployment on the Pi.
