# TASK-013: Install Nomsod MCP Windows Agent on GUNN

## 1. Goal & Scope
- Install and activate Nomsod MCP in `Agent` mode on Windows host `GUNN`.
- Register scheduled tasks: `NomsodMCP-Agent`, `NomsodMCP-Control`, `NomsodMCP-Updater`, `NomsodMCP-Watchdog`.
- Verify services health, process execution, and outbound connection to `wss://mcp.nomsod.net/agent`.

## 2. Findings & Context Discoveries
- Status prior to installation was `Not installed` for all Nomsod tasks.
- `.env` specifies `NOMSOD_DEVICE_NAME=GUNN` and `NOMSOD_GATEWAY_WS=wss://mcp.nomsod.net/agent`.
- Initial run encountered flap `code=4000 reason=superseded by reconnect` due to legacy duplicate deviceId in `data/device.json` which was already registered by an active node on the cluster.
- Cleared legacy `data/device.json`, allowing fresh runtime pairing with `NOMSOD_PAIRING_TOKEN`. A fresh UUID device identity was established and token saved.
- Flapping resolved immediately; Agent Guardian connected cleanly to `wss://mcp.nomsod.net/agent`.
- Public Supervisor health on `https://mcp.nomsod.net/health` reports `connectedDevices: 3`.

## 3. Slices & Checklist
- [x] Slice 1: Run installation script `scripts/windows/install.ps1 -Mode Agent`
- [x] Slice 2: Verify scheduled tasks, process statuses, and health endpoints
- [x] Slice 3: Archive task upon successful verification <- Current Focus 🎯

## 4. Verification Evidence
- `NomsodMCP-Agent`: Running (`Nomsod MCP Agent.exe dist\bootstrap\agent.js`)
- `NomsodMCP-Control`: Running (`Nomsod MCP Control.exe`)
- `NomsodMCP-Updater`: Ready, Last Result: 0
- `NomsodMCP-Watchdog`: Ready, Last Result: 0
- Health endpoint `http://127.0.0.1:34122/health`:
  - `ok: True`
  - `service: nomsod-agent-guardian`
  - `gatewayConnected: True`
  - `connectedGateways: 1`
  - `worker: pid=19752, alive=True`
- Public health `https://mcp.nomsod.net/health`:
  - `connectedDevices: 3`
