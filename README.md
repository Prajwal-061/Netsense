# NetSense

NetSense is a Raspberry Pi-based network discovery and diagnostics system. It finds the devices on a local network, checks which services they run, collects configuration and state from authorized Cisco devices, and keeps a history of what it saw.

It is a college project, built and tested against a Cisco CML lab.

> **Status:** project foundation only. No discovery, scanning or device collection code has been written yet.

## Features

- **Device discovery** with ARP requests (Scapy) to find live hosts on the local subnet
- **Service scanning** with Nmap to identify open ports and services on discovered hosts
- **Cisco device collection** over SSH (Netmiko): interfaces, VLANs, MAC address tables and running configs, from authorized devices only
- **Scan history** stored in a database, with a report of new devices, missing devices and IP changes between scans
- **Config backups and diffs**: a device's running config is stored when it changes, ignoring timestamp-only differences, and any two backups can be compared line by line
- **REST API** built with FastAPI
- **Web dashboard** built with React

## Planned architecture

```
            +--------------------+
            |  React dashboard   |   frontend/  (later)
            +---------+----------+
                      | HTTP / JSON
            +---------v----------+
            |   FastAPI routes   |   backend/app/api
            +----+----------+----+
                 |          |
     +-----------v--+   +---v-----------+
     |    Engine    |-->|   Database    |   backend/app/db
     +--+----+----+-+   +---------------+
        |    |    |
      ARP  Nmap  SSH                        backend/app/engine
        |    |    |
     +--v----v----v--------+
     |    Local network    |
     |  hosts and switches |
     +---------------------+
```

The engine does the network work, the database stores what the engine finds, and the API exposes both to the dashboard. The whole backend is intended to run on a Raspberry Pi plugged into the network being inspected. During development an Ubuntu Server 24.04 VM stands in for the Pi.

## Folder layout

```
.
├── backend/
│   ├── app/
│   │   ├── engine/   # discovery, scanning, device collection
│   │   ├── api/      # FastAPI routes and schemas
│   │   ├── db/       # database models
│   │   ├── services/ # runs the engine and saves results
│   │   ├── core/     # settings and configuration
│   │   └── main.py   # FastAPI application
│   ├── migrations/   # Alembic database migrations
│   ├── scripts/      # runnable scripts
│   ├── tests/
│   └── .venv/        # Python virtual environment (not committed)
├── frontend/         # React dashboard (Vite, TypeScript, Tailwind, TanStack Query)
├── lab/              # CML topology and switch configs
├── docs/
├── .env.example      # template for local settings
└── README.md
```

## Setup and run

Requires Python 3.12+, git, nmap and Node.js LTS. The addresses below are the development VM's (192.168.17.132 on the lab network); replace them with your own.

### 1. Backend: virtual environment

```bash
cd backend

# --copies gives the venv its own copy of Python instead of a symlink to
# /usr/bin/python3. Step 2 depends on this.
python3 -m venv --copies .venv
source .venv/bin/activate
pip install -r requirements.txt

# Local settings: lab switch address and credentials, allowed subnets
cp ../.env.example ../.env      # then edit ../.env

# Create the SQLite database, backend/netsense.db (never with sudo)
alembic upgrade head

# Run the tests. They mock the network, so no lab is needed.
pytest
```

`.env` and `netsense.db` are ignored by git and must never be committed: the first holds credentials, the second can hold device configs.

### 2. Backend: permission to scan without root

ARP scans and Nmap SYN scans send hand-built packets on a raw socket. Linux allows that only for root, or for a program that holds the `CAP_NET_RAW` capability. The API must not run as root, so the capability is given to one file, the venv's own Python:

```bash
cd backend

# Must print a path inside backend/.venv. If it prints /usr/bin/python3.12,
# stop: the venv was made without --copies. Rebuild it as in step 1.
readlink -f .venv/bin/python

sudo setcap cap_net_raw+ep .venv/bin/python

# Must print: .venv/bin/python cap_net_raw=ep
getcap .venv/bin/python
```

Why the venv's own Python and never the system one: a capability belongs to a file, and every program started from that file gets it. On `/usr/bin/python3` that would be every Python script run by every user on the machine. On the venv's copy it is only what is started from this project's environment.

Rebuilding the venv creates a new file without the capability, so run the `setcap` command again afterwards.

### 3. Start the backend

```bash
cd backend
source .venv/bin/activate
python -m uvicorn app.main:app --host 0.0.0.0 --port 8000
```

Start it as your normal user, not with sudo. `python -m uvicorn` matters: it runs uvicorn on `.venv/bin/python`, the file that holds the capability (see Troubleshooting). `--host 0.0.0.0` listens on every network interface; `--host 192.168.17.132` would serve the lab network only.

Check: `curl http://192.168.17.132:8000/health` should show `"database": true` and `"raw_sockets": true`.

### 4. Start the dashboard

In a second terminal:

```bash
cd frontend
npm install                # first time only
npm run dev -- --host
```

`--host` makes the dev server reachable from other machines, not just from the VM itself.

The dashboard calls the API at `http://192.168.17.132:8000`. To use another address, put `VITE_API_URL=http://<address>:8000` in `frontend/.env.local` and add the dashboard's own address to `CORS_ORIGINS` in `.env`.

### 5. Open it

| What | URL |
|---|---|
| Dashboard | http://192.168.17.132:5173 |
| API docs (try the endpoints) | http://192.168.17.132:8000/docs |
| API health | http://192.168.17.132:8000/health |

The API has **no authentication yet**, so run it only on an isolated lab network.

### Command-line scripts

With the venv activated, from `backend/`:

```bash
python scripts/collect_switch.py   # SSH to the lab switch, read-only show commands
python scripts/discover.py         # ARP scan of the lab network
python scripts/scan.py             # ARP scan + Nmap + classifier, saved, with a change report
```

The two scan scripts need step 2, or can be run with sudo instead: `sudo .venv/bin/python -B scripts/scan.py`.

### Tests

```bash
cd backend && source .venv/bin/activate && pytest     # backend
cd frontend && npm test                               # dashboard pages
```

### Troubleshooting

**Scans fail with "ARP scanning needs root or the CAP_NET_RAW capability", or `/health` shows `"raw_sockets": false`.**
The API is running on a Python file that does not hold the capability. A venv made with `--copies` contains three separate files, `python`, `python3` and `python3.12`, and `setcap` in step 2 marks only `python`. The `uvicorn` command is a script whose first line names `python3`, so `uvicorn app.main:app ...` and `.venv/bin/uvicorn ...` can run on a copy without the capability. Fixes:

- Start with `python -m uvicorn ...` as in step 3.
- Check the capability is still there: `getcap .venv/bin/python`. It is lost when the venv is rebuilt.
- Optionally make all three names the same file, so the mistake cannot happen: `ln -sf python .venv/bin/python3 && ln -sf python .venv/bin/python3.12`.

**The dashboard says "API not reachable" although the API is running.**
Usually CORS. A browser lets a page call an API on another address only if the API allows that page's origin (scheme, host and port), and the API allows `http://192.168.17.132:5173`, `http://localhost:5173` and `http://127.0.0.1:5173` by default.

- Open the dashboard at `http://192.168.17.132:5173`, the 192.168.17.x address, not through another address of the VM.
- If your addresses differ, list the dashboard's origin in `CORS_ORIGINS` in `.env` and restart the backend.
- Check the API itself from the laptop: `http://192.168.17.132:8000/health` should load in the browser. If it does not, the backend was not started with `--host 0.0.0.0`, or a firewall blocks port 8000.

**The dashboard dev server refuses to start: "Port 5173 is already in use".**
Another dev server is still running. Stop it first; the port is fixed on purpose, because the API's CORS list names it.

**Scans work but Nmap finds no open ports.**
Not a capability problem: without the capability Nmap falls back to a TCP connect scan, which finds the same ports. With it, the scanner starts Nmap through `app/engine/pass_caps.py`, which passes `CAP_NET_RAW` to that one Nmap process for a SYN scan; `/usr/bin/nmap` itself needs no `setcap`. Check instead that the hosts answer on the scanned ports (the 100 most common by default).

**On a Raspberry Pi (later).** A systemd service with a dedicated user and `AmbientCapabilities=CAP_NET_RAW` replaces step 2, so that no file on disk is privileged.

## Responsible use

NetSense scans networks and logs in to network devices. Use it only on networks and devices you own or are explicitly authorized to test.
