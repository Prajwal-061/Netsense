# NetSense

Raspberry Pi-based network discovery and diagnostics system. College project and portfolio piece.

## About the user

Networking student studying for CCNA. Briefly explain what you are doing at each step, including the networking or Python concept behind it.

## What NetSense will do

- Discover devices on the local network with ARP (Scapy) and scan services with Nmap
- SSH into authorized Cisco devices with Netmiko to collect interfaces, VLANs, MAC tables and running configs
- Store scan results and history in a database
- Expose everything through a FastAPI backend and, later, a React dashboard
- Eventually run on a Raspberry Pi

## Environment

- Dev machine: Ubuntu Server 24.04 VM that stands in for the Pi, Python 3.12
- VM address: 192.168.17.132 on a VMware host-only network (the lab), plus a NAT adapter for internet
- Lab: Cisco CML with a switch at 192.168.17.10 (SSH enabled, VLAN10) on the same host-only network
- System packages installed: git, python3-venv, python3-pip, nmap

## Layout

```
backend/app/engine/   discovery, scanning, device collection
backend/app/api/      FastAPI routes
backend/app/db/       database models
backend/app/core/     settings/config
backend/scripts/      runnable scripts (collect_switch.py)
backend/tests/
backend/.venv/        virtual environment (not committed)
frontend/             React dashboard, empty for now
lab/                  CML topology and switch configs
docs/
```

## Commands

```bash
source backend/.venv/bin/activate                      # activate the virtual environment
backend/.venv/bin/pip install -r backend/requirements.txt   # install dependencies
cd backend && .venv/bin/pytest                         # run the tests (no lab needed)
backend/.venv/bin/python backend/scripts/collect_switch.py  # collect from the lab switch (SSH, show commands only)
```

Imports are rooted at `backend/` (`from app.engine import collector`). Add `--show-config` to the script to print the full running config.

## Rules

- Ask before running any sudo command. Scapy ARP scans need raw sockets, so they need root: ask first.
- Do not run network scans or connect to the switch unless the user asks for it in the current session. Only ever target the lab network (192.168.17.0/24 host-only) and authorized devices.
- Never put real credentials in a committed file. Real values go in `.env` (git-ignored); `.env.example` holds placeholders only.
- Running configs collected from switches can contain password hashes, SNMP communities and keys. Sanitize them before saving anything under `lab/` or `docs/`.
- Build one stage at a time, and only what the user asked for in the session.

## Status

- Done: foundation, settings loading (`app/core/config.py`, pydantic-settings), device collector (`app/engine/collector.py`, Netmiko + TextFSM) with mocked unit tests.
- Not built yet: ARP discovery, Nmap scanning, database, API, frontend.
