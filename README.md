# NetSense

NetSense is a Raspberry Pi-based network discovery and diagnostics system. It finds the devices on a local network, checks which services they run, collects configuration and state from authorized Cisco devices, and keeps a history of what it saw.

It is a college project, built and tested against a Cisco CML lab.

> **Status:** project foundation only. No discovery, scanning or device collection code has been written yet.

## Planned features

- **Device discovery** with ARP requests (Scapy) to find live hosts on the local subnet
- **Service scanning** with Nmap to identify open ports and services on discovered hosts
- **Cisco device collection** over SSH (Netmiko): interfaces, VLANs, MAC address tables and running configs, from authorized devices only
- **Scan history** stored in a database, so results can be compared over time
- **REST API** built with FastAPI
- **Web dashboard** built with React (later)

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
├── frontend/         # React dashboard (empty for now)
├── lab/              # CML topology and switch configs
├── docs/
├── .env.example      # template for local settings
└── README.md
```

## Getting started

Requires Python 3.12+, git and nmap.

```bash
# Create and activate the virtual environment
python3 -m venv backend/.venv
source backend/.venv/bin/activate

# Install the dependencies
pip install -r backend/requirements.txt

# Create your local settings file, then edit it
cp .env.example .env

# Run the tests (they mock the switch, so no lab is needed)
cd backend && pytest && cd ..

# Collect interfaces, VLANs, MAC table, version and running config from the lab switch
python backend/scripts/collect_switch.py

# Discover devices on the lab network with an ARP scan (raw packets need root)
sudo backend/.venv/bin/python -B backend/scripts/discover.py

# Create the SQLite database, backend/netsense.db (run as yourself, not with sudo)
cd backend && alembic upgrade head && cd ..

# Discover, port-scan the discovered hosts with Nmap, guess each device's type,
# save the scan and report what changed since the previous one
sudo backend/.venv/bin/python -B backend/scripts/scan.py

# Run the API (as yourself, not root), then open http://192.168.17.132:8000/docs
cd backend && uvicorn app.main:app --host 192.168.17.132 --port 8000
```

The API has **no authentication yet**, so run it only on an isolated lab network. Binding to the lab address, rather than `0.0.0.0`, keeps it off every other interface.

`.env` holds the lab switch address and credentials, and `ALLOWED_SUBNETS`, the list of networks the discovery and port scans are permitted to target. It is ignored by git and must never be committed.

## Responsible use

NetSense scans networks and logs in to network devices. Use it only on networks and devices you own or are explicitly authorized to test.
