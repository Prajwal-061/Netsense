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
backend/tests/
backend/.venv/        virtual environment (not committed)
frontend/             React dashboard, empty for now
lab/                  CML topology and switch configs
docs/
```

## Commands

```bash
source backend/.venv/bin/activate    # activate the virtual environment
backend/.venv/bin/pip install <pkg>  # install into the venv without activating
```

No dependencies, tests or app entry point exist yet. Update this section when they do.

## Rules

- Ask before running any sudo command. Scapy ARP scans need raw sockets, so they need root: ask first.
- Do not run network scans or connect to the switch unless the user asks for it in the current session. Only ever target the lab network (192.168.17.0/24 host-only) and authorized devices.
- Never put real credentials in a committed file. Real values go in `.env` (git-ignored); `.env.example` holds placeholders only.
- Running configs collected from switches can contain password hashes, SNMP communities and keys. Sanitize them before saving anything under `lab/` or `docs/`.
- Build one stage at a time, and only what the user asked for in the session.

## Status

Foundation only: folder structure, venv, .gitignore, .env.example, README. No discovery, scanning, SSH, database or API code yet.
