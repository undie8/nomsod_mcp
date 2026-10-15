# Nomsod MCP — NEW CHAT HANDOFF

Updated: 2026-09-28
Project: `D:\projects\nomsod mcp`

## Read this first

Continue the existing Nomsod MCP project. Do not redesign it back into a central NAS-only gateway and do not introduce 9Router.

The intended architecture is **active-active edge gateways**:

- Every enrolled computer can run its own Gateway + Supervisor + Agent + Worker + Control UI.
- Public MCP URL remains one endpoint: `https://mcp.nomsod.net/mcp`.
- Cloudflare named-tunnel connectors may run on multiple Nomsod nodes.
- Agents discover/connect to Nomsod peer gateways through Tailscale.
- If only one enrolled computer is online, that computer should still be usable.
- No workstation should require another workstation to stay awake.

Use Chanom only as a recovery/control channel if Nomsod itself is unavailable.

## Current version / git

Current source version:

```
0.4.0
```

Latest commits:

```
4cec716 feat: add secure computer enrollment
7a9d46f feat: add active-active gateway failover
3b0273c fix: preserve cat icon and hide tunnel console
a772ba6 fix: refine transparent icon and background tasks
7ce843a feat: hide Windows consoles and refine status icons
```

At handoff time, the repository was clean before creating this handoff file.

## Current live state

### GUNN / Windows

Runtime root:

```
%LOCALAPPDATA%\Nomsod MCP
```

GUNN is running Nomsod MCP `0.4.0`.

Local Gateway:

```
http://127.0.0.1:34100
```

Public endpoint:

```
https://mcp.nomsod.net
https://mcp.nomsod.net/mcp
```

Latest verified local/public health:

- service: `nomsod-supervisor`
- version: `0.4.0`
- connectedDevices: `1`
- publicBase: `https://mcp.nomsod.net`
- active runtime alive on port `34101`

Agent Guardian:

- version: `0.4.0`
- gatewayConnected: `true`
- connectedGateways: `1`
- configuredGateways: `2`
- worker alive on port `34120`

Relevant GUNN Tailscale IP used during active-active work:

```
100.91.123.36
```

Peer gateway port:

```
34104
```

### Mac

Known Mac:

```
Tailscale hostname: guns-macbook-air
Tailscale IP: 100.97.208.25
SSH user: gunn
macOS arm64
```

At this handoff the Mac is **offline** in Tailscale. Last observed status was offline, so current v0.4.0 macOS runtime/UI/Cloudflare connector has not yet been revalidated live after the enrollment work.

Do not interpret the Mac being offline as a GUNN failure. GUNN is currently serving `mcp.nomsod.net` independently.

## Architecture already implemented

### Active-active Gateway

Commit `7a9d46f` introduced the active-active architecture.

Important behavior:

- OAuth/device auth can work across gateways via cluster-signed tokens.
- Legacy OAuth/device records remain backward-compatible where possible.
- Agent supports multiple Gateway WebSocket connections.
- Agent has Tailscale peer discovery.
- Discovery probes `/health` and only accepts peers whose service is `nomsod-peer`.
- Public Gateway listens locally for Cloudflare.
- Peer Agent endpoint is separate and intended for Tailscale.
- Supervisor can run as a user-level hidden scheduled task on Windows when PowerShell is not elevated.
- Public MCP URL remains `https://mcp.nomsod.net/mcp`.

### OAuth migration

A previous failure after moving public traffic to GUNN was:

```
Unknown client or redirect URI
```

The fix supports legacy `nmc_...` ChatGPT OAuth clients during migration, but only for trusted HTTPS callbacks on `chatgpt.com`.

Do not broaden this to arbitrary redirect domains.

### Windows background processes

Nomsod Windows background executables/processes should not open CMD/PowerShell windows.

Cloudflare is launched via:

```
Nomsod MCP Tunnel.exe
  -> cloudflared.exe
```

The Nomsod processes were previously verified with `MainWindowHandle = 0`.

There can be two `cloudflared.exe` processes on GUNN for valid reasons:

1. Chanom tunnel
2. Nomsod MCP tunnel

Do not kill the Chanom cloudflared merely because two exist. Inspect parent/command line first.

## Secure enrollment added in v0.4.0

Commit:

```
4cec716 feat: add secure computer enrollment
```

Files introduced/changed include:

```
src/supervisor/enrollment.ts
tests/enrollment.test.ts
scripts/bootstrap/windows.ps1
scripts/bootstrap/macos.sh
scripts/windows/NomsodMcpControl.cs
scripts/macos/NomsodMcpMenuBar.swift
scripts/macos/install-cloudflared-background.sh
scripts/macos/install.sh
scripts/macos/uninstall.sh
src/supervisor/main.ts
```

Enrollment design:

1. An existing Nomsod node creates a short-lived signed invite.
2. Invite default lifetime is 10 minutes.
3. Invite is platform-bound (`windows`, `macos`, or `any`).
4. New computer calls the public bootstrap endpoint using the invite bearer token.
5. Bootstrap bundle contains the cluster configuration required to join.
6. New machine installs as `Gateway + Agent` (`Both`).
7. It should provision its own local services and, when tunnel credentials are present in the bundle, configure a Cloudflare connector as well.
8. No user should need to manually type pairing/owner/cluster secrets during normal enrollment.

Do not print or expose actual pairing keys, owner keys, cluster keys, device tokens, OAuth tokens, or Cloudflare credential JSON.

### Local enrollment control

Supervisor persists a local Control key under:

```
data/control.key
```

Control UIs use the localhost control endpoint to create enrollment invites.

Windows Control has:

```
Add new computer
  - Copy Windows install command
  - Copy macOS install command
```

macOS Menu Bar source has the equivalent menu.

The copied install command embeds only the short-lived enrollment invite. It should expire after 10 minutes.

### Public enrollment endpoint

The bootstrap endpoint is conceptually:

```
GET https://mcp.nomsod.net/enroll/bootstrap?platform=windows
GET https://mcp.nomsod.net/enroll/bootstrap?platform=macos
Authorization: Bearer <short-lived enrollment invite>
```

Do not make this endpoint return bootstrap data without a valid signed invite.

## Installer goal

New Windows machine should ultimately be installable from a generated command equivalent to:

```powershell
$env:NOMSOD_ENROLLMENT_TOKEN='<short-lived invite>'
irm https://mcp.nomsod.net/install/windows.ps1 | iex
```

New Mac should ultimately be installable from a generated command equivalent to:

```sh
curl -fsSL https://mcp.nomsod.net/install/macos.sh | NOMSOD_ENROLLMENT_TOKEN='<short-lived invite>' sh
```

The Control UI generates/copies the real command; do not hard-code an invite in documentation.

## Cloudflare enrollment behavior

### Windows

The Windows bootstrap was extended to:

- obtain the enrollment bundle;
- install as `Both`;
- configure active-active ports;
- provision Cloudflare tunnel credential material when supplied;
- locate existing `cloudflared.exe` or download it;
- verify downloaded Cloudflare binary using release SHA-256 metadata;
- configure the hidden Nomsod Cloudflare scheduled tasks.

### macOS

The macOS source was extended to:

- obtain the enrollment bundle;
- install as `Both`;
- configure active-active ports;
- download the correct arm64/amd64 cloudflared asset when needed;
- verify SHA-256;
- store tunnel credentials under the Nomsod runtime;
- install `com.nomsod.mcp.cloudflared` as a background LaunchAgent;
- uninstall that LaunchAgent from `scripts/macos/uninstall.sh`.

Important: because the Mac was offline at handoff, the final Swift build and real launchd/cloudflared behavior for v0.4.0 still need a live macOS validation.

## Tests / validation completed during enrollment work

Before the final v0.4.0 commit, the enrollment work was validated with:

- TypeScript typecheck
- project tests
- enrollment token tests
- Windows bootstrap PowerShell parser
- Windows Control C# build
- macOS shell syntax checks using `sh -n`

Enrollment tests cover at least:

- valid invite produces bootstrap bundle;
- wrong platform is rejected;
- tampered invite is rejected.

## Important known issue still worth checking

During earlier v0.3.x update testing, the Windows updater could leave a child `powershell.exe ... update.ps1` holding the named updater mutex after the scheduled-task wrapper ended.

Observed symptom:

- manual `update.ps1 -Force` exits 0 immediately;
- version does not change;
- a child PowerShell process still owns the updater mutex.

This lifecycle issue was not part of the enrollment commit's changed-file list. Verify whether it still reproduces before considering updater behavior fully finished.

Do not kill generic PowerShell processes. Match the exact Nomsod `update.ps1` command line.

## Immediate next work

### 1. GUNN baseline and updater transition — COMPLETE

Validated the v0.4.0 baseline, then released and updated GUNN to **v0.4.1**.

Verified after the transition:

```text
repo VERSION = 0.4.1
installed VERSION = 0.4.1
public https://mcp.nomsod.net/health = 0.4.1
Nomsod list_computers reports GUNN = 0.4.1
updater Last Result = 0
no update.ps1 child remains
Local\NomsodMcpUpdater mutex can be acquired after completion
```

Commit containing the source changes: `a90c2e8 fix: harden 0.4.1 release updates`.

The repository currently has no Git remote configured, so this commit is local only.

### 2. End-to-end enrollment test

Prefer a disposable/new machine or MATH if appropriate.

Test from an existing Control UI:

1. Generate a Windows enrollment command.
2. Confirm no long-lived secret is displayed.
3. Run command on new Windows machine.
4. Verify it becomes Gateway + Agent.
5. Verify it appears in `list_computers`.
6. Verify peer discovery sees it.
7. Verify its public Cloudflare connector registers if tunnel credentials were included.
8. Verify normal shell/file tools operate on that machine.

Repeat for macOS once Mac is online.

### 3. Mac online validation

When `guns-macbook-air` is reachable again:

- update/sync to v0.4.1;
- run `npm run typecheck`, `npm test`, `npm run build` on Mac if source deployment requires it;
- run macOS shell syntax checks with native `/bin/sh -n`;
- rebuild `Nomsod MCP.app` / Menu Bar Control;
- verify the new `Add new computer` menu;
- verify `com.nomsod.mcp.cloudflared` LaunchAgent;
- verify no Terminal window is shown;
- verify Mac Gateway health and peer endpoint;
- verify Cloudflare connector registers.

### 4. Active-active failover test

After both GUNN and Mac connectors are online:

- verify `list_computers` through ChatGPT/Nomsod;
- stop only GUNN public connector/Gateway and confirm public MCP continues through Mac;
- restore GUNN;
- stop only Mac connector/Gateway and confirm public MCP continues through GUNN;
- do not test by destroying credentials or deleting configs;
- confirm OAuth session remains usable when traffic lands on either node.

### 5. Updater lifecycle — WINDOWS COMPLETE

Windows was tested with a real `0.4.0 -> 0.4.1` transition on GUNN. The scheduled updater spawned the exact Nomsod `update.ps1` child, completed with `Last Result: 0`, switched the task to the versioned `0.4.1` background executable, left no updater child behind, and released `Local\NomsodMcpUpdater`.

Still test the macOS updater path once the Mac is online.

## Plugin / ChatGPT context

Private ChatGPT plugin:

```
Nomsod MCP
plugin id: plugins_6ab985b27d788191919e382e81b892e1
```

MCP URL:

```
https://mcp.nomsod.net/mcp
```

If the Nomsod tool namespace returns an internal error:

1. check `https://mcp.nomsod.net/health`;
2. check local GUNN Gateway;
3. inspect Cloudflare connector;
4. use Chanom as recovery channel;
5. do not assume the target project's files are the problem.

## Security invariants

Preserve all of these:

- no 9Router dependency;
- OAuth bearer only in Authorization header;
- no query-string bearer token;
- PKCE S256;
- legacy ChatGPT OAuth migration only for trusted `chatgpt.com` HTTPS redirect URI;
- enrollment invite is short-lived and signed;
- no permanent secrets in generated install docs/logs;
- no broad acceptance of arbitrary legacy client IDs/redirect URIs;
- device identity remains dynamic; never hard-code GUNN/Mac names into core behavior;
- file edits remain UTF-8 safe and SHA guarded where applicable;
- never reconstruct a full file from a partial read;
- do not reset/delete existing user work.

## Recovery tools

If Nomsod itself is down, Chanom on GUNN can be used for:

- PowerShell/terminal execution
- file read/write/search
- process inspection
- screenshots
- clipboard

Do not use Chanom's 9Router functions for Nomsod work.

## Continuation update — 2026-09-28 13:24 ICT

Completed in this continuation:

- released **v0.4.1** and promoted its distribution into the live GUNN runtime;
- fixed Windows bootstrap pairing prompt typo;
- added functional `-PrepareOnly` support to the Windows bootstrap and smoke-tested it without installing services;
- hardened `scripts/release/publish.ps1` with version consistency checks, immutable-release protection and explicit `-DistributionTarget` promotion;
- promotion now copies versioned artifacts first and publishes `releases/latest/*.json` last;
- verified public Windows/macOS manifests and archive SHA-256 values;
- verified public Windows installer contains the corrected prompt and `PrepareOnly` parameter;
- performed a real Windows updater transition `0.4.0 -> 0.4.1` successfully;
- verified Nomsod public MCP -> Gateway -> Agent -> Worker after update;
- `npm run typecheck`, `npm test` (10/10) and `npm run build` pass;
- `npm audit --omit=dev` reports zero production vulnerabilities; the remaining two moderate audit findings are in Vitest dev tooling and require a major upgrade to auto-fix;
- source commit is `a90c2e8`; repo/runtime versions both report `0.4.1`;
- source working tree is clean except this untracked `NEW_CHAT_HANDOFF.md` file.

Still blocked on another live machine:

- end-to-end enrollment onto MATH/new Windows machine;
- macOS native validation and macOS updater validation;
- active-active Cloudflare/Gateway failover with both GUNN and Mac online.

At the end of this continuation both `GUN’s MacBook Air` and `MATH` were offline in Tailscale.

## Continuation update — 2026-09-28 16:15 ICT

Mac came online as `GUN-MAC-E2E` (`darwin`, `arm64`) from `/Users/gunn/nomsod-mcp-test` and was validated on v0.4.1:

- native `/bin/sh -n` passed the macOS bootstrap/scripts;
- `npm run typecheck` and `npm run build` passed on Mac;
- installed Control, Agent, Worker, Supervisor and Gateway processes were present;
- `~/Applications/Nomsod MCP.app` and the normal LaunchAgents were present;
- `com.nomsod.mcp.cloudflared` was **not** installed/running and `cloudflared` binary was absent;
- Mac Gateway/peer routing was repaired from stale values to `NOMSOD_GATEWAY_HOST=127.0.0.1` and `NOMSOD_PEER_PORT=34104`;
- after the routing repair both GUNN and Mac Gateways temporarily reported `connectedDevices=2` and Mac Agent reported two connected gateways.

A real active-active bug was then identified from Mac Agent logs: the same Mac Agent connected to the same GUNN Gateway through both `wss://mcp.nomsod.net/agent` and the direct Tailscale peer `ws://100.91.123.36:34104/agent`. `AgentHub` correctly allows only one socket per device ID, so those two routes continuously superseded each other (`code=4000`, `reason=superseded by reconnect`) roughly every second.

This was fixed in **v0.4.2**:

- local/Tailscale `ws://` Gateway routes are primary;
- public `wss://` Gateway routes remain fallback only;
- fallback sockets are parked while any primary Gateway is healthy;
- fallback reconnects are scheduled only when no primary remains;
- added `src/agent/gateway-routing.ts` and `tests/gateway-routing.test.ts`;
- full GUNN test suite now passes **12/12** plus typecheck/build;
- public Windows/macOS manifests were published as v0.4.2;
- GUNN successfully updated to v0.4.2, updater `Last Result=0`;
- source commit: `b7ec2e9 fix: stabilize active-active gateway routing`;
- repository still has no Git remote configured, so the commit is local only.

Mac later returned online and had successfully updated itself to **v0.4.2**. Post-update validation passed:

- `list_computers` reports both GUNN and `GUN-MAC-E2E` online at v0.4.2;
- Mac Agent health reports `connectedGateways=2`, `configuredGateways=3`;
- Mac local Gateway reports `connectedDevices=2`;
- GUNN local Gateway also reports `connectedDevices=2`;
- Mac updater LaunchAgent is idle with `last exit code = 0`;
- the historical `superseded by reconnect` counter remained **257 -> 257** over an 8-second observation window, confirming the v0.4.2 duplicate-route fix stopped the connection flap.

Cloudflare tunnel provisioning on Mac remains the only active blocker before public failover testing. `com.nomsod.mcp.cloudflared` is not yet provisioned. Attempts to relay the Cloudflare credential through Taildrop or to consume the bootstrap credential bundle inside a remote tool call were blocked by the tool safety layer. Do not bypass or obfuscate that restriction. Use the existing user-mediated secure enrollment flow from Nomsod Control so the short-lived enrollment command is copied locally by the Control app and run directly on the Mac.

### Immediate next steps

1. On a node that already owns the Cloudflare tunnel credential (GUNN), use Nomsod Control -> `Add new computer` -> `Copy macOS install command`.
2. Run that short-lived command directly on the Mac. This is the supported path that provisions the existing tunnel credential without placing a long-lived secret in chat/log output.
3. Verify `com.nomsod.mcp.cloudflared` LaunchAgent is running on Mac and public `/health` remains healthy.
4. Verify both GUNN and Mac Gateways still report both devices after provisioning.
5. Run public active-active failover in both directions: stop only GUNN connector/Gateway and verify Mac carries traffic, restore GUNN, then stop only Mac connector/Gateway and verify GUNN carries traffic. Do not delete credentials or configs.

## Continuation update — 2026-09-28 17:20 ICT

The user ran the short-lived macOS enrollment command copied from Nomsod Control on GUNN. That completed the real macOS enrollment/bootstrap path and provisioned the Cloudflare connector successfully.

Important resulting state:

- active Mac runtime root is now `/Users/gunn/Library/Application Support/Nomsod MCP`;
- the older `/Users/gunn/nomsod-mcp-test` tree still exists but is not the active runtime; do not delete it unless the user explicitly asks;
- Mac enrolled with a fresh dynamic device identity and currently appears as display name `mac` rather than the earlier temporary `GUN-MAC-E2E` identity;
- Mac is on v0.4.2;
- `com.nomsod.mcp.cloudflared` is loaded and running;
- Mac Cloudflare process points to the Nomsod tunnel and local origin `127.0.0.1:34100`;
- after final restoration Mac Gateway reports `connectedDevices=2` and GUNN Gateway reports `connectedDevices=2`;
- the new active Mac Agent log has `superseded by reconnect` count `0` after restoration.

### Public active-active failover — COMPLETE

Both directions were tested without deleting credentials/configuration.

**GUNN -> Mac takeover**

1. Stopped only `NomsodMCP-Cloudflared` and `NomsodMCP-Supervisor` on GUNN.
2. Terminated only the Nomsod tunnel's remaining `cloudflared.exe` child matched by the Nomsod tunnel identity. The unrelated Chanom `cloudflared.exe` using `config-chanom.yml` was left untouched.
3. Public `https://mcp.nomsod.net/health` then returned the same Supervisor PID/runtime as Mac local `127.0.0.1:34100`.
4. Public MCP still listed both computers online.
5. A Nomsod remote command targeting GUNN (`hostname`) succeeded while GUNN's own public connector/Gateway were down.
6. Restored GUNN Supervisor and Cloudflare scheduled tasks; GUNN Gateway returned with `connectedDevices=2`.

**Mac -> GUNN takeover**

1. Booted out only `com.nomsod.mcp.cloudflared` and `com.nomsod.mcp.supervisor` on Mac.
2. Confirmed no Mac Nomsod Supervisor/Gateway/Nomsod-tunnel cloudflared process remained during the test.
3. Public MCP still listed both computers online.
4. Public `https://mcp.nomsod.net/health` returned the same Supervisor PID as GUNN local `127.0.0.1:34100`, with `connectedDevices=2`.
5. A Nomsod remote command targeting Mac (`hostname`) succeeded while Mac's own public connector/Gateway were down.
6. Restored Mac Supervisor first, then `com.nomsod.mcp.cloudflared`; after reconvergence Mac Gateway returned to `connectedDevices=2`.

The existing ChatGPT/Nomsod public session remained usable throughout both failovers, so the active-active public path is now validated end-to-end on both nodes.

## Current conclusion

Nomsod MCP source/public release, GUNN and Mac are all on **v0.4.2**. Secure macOS enrollment, macOS Cloudflare provisioning, macOS updater behavior, duplicate-route stabilization, two-node Gateway convergence, and public active-active failover in both directions are now validated in production. GUNN and Mac are both restored and healthy with both Gateways seeing both devices. Remaining optional work is mainly cleanup/documentation (for example deciding whether to keep the old Mac test tree) and a separate fresh-Windows/MATH enrollment test when another Windows machine is available. Continue from here; do not restart architecture design from scratch.

## Continuation update — 2026-09-29 04:13 ICT

Before enrolling another computer, the cluster was hardened from v0.4.2 through **v0.4.6**. The architectural target remains one owner / one logical Nomsod cluster, with computers treated as replaceable active-active nodes.

### v0.4.3 — single-cluster enforcement

Commit: `da54d7d feat: enforce single-cluster enrollment`.

- Stable logical cluster ID is `nomsod-main-v1`.
- Enrollment bootstrap schema is version 2 and carries `clusterId`.
- Generated Windows/macOS enrollment commands pin `NOMSOD_CLUSTER_ID=nomsod-main-v1`.
- Agent descriptors carry `clusterId`.
- Gateway rejects an explicitly mismatched Agent cluster.
- Tailscale peer probing ignores explicitly mismatched peer Gateways.
- Public bare installers fail closed when no short-lived enrollment token is present, rather than prompting for new owner/pairing secrets and accidentally creating a second network.
- Hidden recovery mode accepts only the existing pairing/owner/cluster credentials; it does not mint a second cluster.
- Current v0.4.6 enrollment command was revalidated: 600-second `nen1.` invite, includes enrollment token + cluster ID, and does not embed long-lived pairing/owner/cluster secret names.

### v0.4.4 — transactional updater hardening

Commit: `e21fb00 fix: make updates transactional`.

A real macOS update failure was found while moving 0.4.2 -> 0.4.3: archives created on Windows did not preserve Unix executable bits, so `ensure-node.sh` failed with Permission denied after VERSION had already changed.

Fixes:

- macOS updater restores executable bits before invoking helper scripts;
- Windows/macOS updater restores the prior VERSION marker when install/restart fails;
- a failed update therefore remains retryable instead of leaving “new VERSION / old dist” split state;
- native Mac simulated success/failure tests passed, including rollback of the VERSION marker.

### v0.4.5 — federated release distribution

Commit: `184c980 feat: federate release distribution`.

New components:
- `src/supervisor/distribution-peers.ts`
- federated logic in `src/supervisor/distribution.ts`
- peer read-only distribution exposure on the Tailscale peer port
- `tests/distribution.test.ts`

Behavior:

- public `releases/latest/*.json` compares local and healthy same-cluster peer manifests and serves the newest semantic version;
- installer scripts follow the node that owns the newest manifest;
- if a versioned immutable archive is absent locally, it is streamed from a same-cluster peer;
- peer-socket distribution handling is local-only, preventing proxy recursion loops;
- peer discovery requires `service=nomsod-peer` and exact `clusterId=nomsod-main-v1`.

Production validation deliberately used a Mac whose application was v0.4.5 while its local distribution mirror was still v0.4.4 and lacked v0.4.5 archives. With the GUNN Cloudflare connector stopped, public traffic landed on Mac and still returned:
- health v0.4.5 from the Mac Supervisor;
- latest manifest v0.4.5;
- the fresh Windows installer;
- Windows v0.4.5 archive with the expected SHA.

This proved a stale active-active node cannot serve stale bootstrap material while a healthy peer owns the newer release.

### v0.4.6 — self-healing local release mirrors

Commit: `9a89749 feat: self-heal release mirrors`.

New scripts:
- `scripts/windows/sync-distribution.ps1`
- `scripts/macos/sync-distribution.sh`

Behavior:

- bootstrap performs a best-effort synchronization of both Windows and macOS distribution material before a new Gateway begins serving;
- periodic updater synchronizes the local release mirror on every cycle, even when the application version is already current;
- both platform manifests, both installers and SHA-verified immutable archives are mirrored locally;
- promotion is artifact-first / installer / manifest-last;
- an immutable local artifact with conflicting content is rejected;
- application update remains independent from mirror healing, so a temporary mirror problem does not unnecessarily reinstall the application.

A PowerShell interpolation bug in the first Windows sync draft (`$InstallerName?t`) was found by functional test and corrected to an explicitly delimited variable.

Native Mac no-update validation passed:
- application VERSION remained v0.4.6;
- local Windows mirror healed to v0.4.6 with SHA verified;
- local macOS mirror healed to v0.4.6 with SHA verified;
- both installers are present;
- updater returned idle without reinstalling;
- updater log records `Nomsod MCP distribution mirror synchronized.`.

### Final production failover with GUNN Gateway fully down — PASS

This test verifies that Mac is now self-sufficient and no longer needs GUNN even as a release-distribution peer.

Before the test Mac local state was:
- Supervisor v0.4.6;
- cluster `nomsod-main-v1`;
- Supervisor PID 77288;
- `connectedDevices=2`;
- Mac cloudflared running;
- local Windows and macOS mirrors both v0.4.6.

Test procedure:
1. Temporarily disabled/stopped only the Nomsod Windows watchdog to prevent it restarting the GUNN Supervisor during the test.
2. Stopped `NomsodMCP-Cloudflared` and `NomsodMCP-Supervisor`.
3. Terminated only Nomsod tunnel/Supervisor/Gateway processes matched to the Nomsod root/tunnel ID. Unrelated Chanom infrastructure was untouched.
4. Confirmed GUNN Nomsod Gateway processes were down and local `127.0.0.1:34100` was unavailable.
5. Public endpoint converged to Mac on the first retry.
6. Public health returned v0.4.6, cluster `nomsod-main-v1`, PID 77288, and 2 connected devices.
7. Public Windows latest manifest returned v0.4.6.
8. Public Windows installer SHA matched the current release installer.
9. Public Windows v0.4.6 archive matched SHA `61053f799cf3720bf8d49bde626808ec28bd5ced81a50757b378195536c5f48e`.
10. Public macOS v0.4.6 archive matched SHA `84aeef39e7a75631aa4f950605d17f7e6f0151397f3ab9743433fb174e2167c0`.
11. In `finally`, GUNN Supervisor, Nomsod Cloudflare task and watchdog were restored.
12. Restored GUNN local health returned v0.4.6 / `nomsod-main-v1`.

### Final healthy state

Both GUNN and Mac currently report:
- Nomsod v0.4.6;
- cluster `nomsod-main-v1`;
- local Gateway `connectedDevices=2`;
- Agent connected to 2 Gateways;
- Nomsod Cloudflare connector running;
- Supervisor running;
- local Windows mirror v0.4.6 with SHA verified;
- local macOS mirror v0.4.6 with SHA verified.

GUNN Windows watchdog is enabled again. The full automated test suite is **17/17**, typecheck/build and syntax checks pass, and the latest public release is v0.4.6.

Source commits after the earlier handoff:
- `da54d7d feat: enforce single-cluster enrollment`
- `e21fb00 fix: make updates transactional`
- `184c980 feat: federate release distribution`
- `9a89749 feat: self-heal release mirrors`

Repository still has no Git remote configured. `NEW_CHAT_HANDOFF.md` intentionally remains untracked. Do not add/commit it unless the user explicitly asks.

## Continuation update — 2026-09-29 04:31 ICT

The user required that a completely new computer be installable **without depending on any old Nomsod computer**, including the total-loss case where all prior computers have been wiped or are unavailable.

This is now implemented in **v0.4.7** as an owner-held standalone Recovery Kit.

Commit:
- `687fde0 feat: add standalone cluster recovery`

Public v0.4.7 artifacts:
- Windows SHA-256: `63fbaadb1a38d7d485b5187cbc392e54482db615d8c1f2caf194887a31ddf0bf`
- macOS SHA-256: `1c1f972f7f13c71226d850e7f09c98616fe3e1e00d9d9b0971fc086692ba6a69`

### Recovery Kit design

Nomsod Control now exposes **Export recovery kit...** on Windows and **Export recovery kit…** on macOS. The exported `Nomsod-Recovery-Kit-SENSITIVE.zip` is intentionally an owner credential backup and must be stored outside the Nomsod fleet on protected storage.

The ZIP contains:
- `recovery.json` with the stable `nomsod-main-v1` cluster identity and existing owner/pairing/cluster/tunnel credentials;
- `RECOVER-WINDOWS.ps1`;
- `RECOVER-MACOS.sh`;
- sensitive-storage instructions;
- both Windows and macOS bootstrap installers;
- both latest manifests;
- both SHA-verified immutable release archives.

The kit does **not** mint a new cluster. It reconstructs the same `nomsod-main-v1` on a replacement machine.

Legacy upgraded nodes are supported: if an old node's `.env` does not explicitly contain cluster ID / owner key / cluster key, exporters apply the same compatibility rules as runtime:
- cluster ID defaults to `nomsod-main-v1`;
- owner key falls back to pairing token;
- cluster key is derived as SHA-256 of `"nomsod-cluster-v1\0" + pairingToken`, base64url encoded.

### Recovery bootstrap behavior

Windows bootstrap accepts `-RecoveryBundleRoot`. macOS bootstrap accepts `NOMSOD_RECOVERY_ROOT`.

In Recovery Kit mode:
- release manifest and archive come from the local kit, not the public Gateway;
- bundled archive SHA-256 is verified;
- the local distribution mirror is restored from the kit;
- the same cluster/tunnel credentials are restored;
- the recovering machine is configured as Gateway + Agent;
- existing public tunnel identity is restored;
- no old Nomsod computer is contacted.

Normal public bootstrap without an invite still fails closed, preserving the one-cluster invariant. Normal `Add new computer` remains the convenient path when any node is online; the Recovery Kit is the independent path for total fleet loss.

### Validation — PASS

Before release:
- npm typecheck/build passed;
- full test suite passed **17/17**;
- PowerShell and POSIX shell syntax checks passed;
- Windows Control C# build passed;
- macOS Control native Swift compile passed.

Both Windows and macOS isolated recovery tests passed from source, then again from the **installed v0.4.7 release itself**:
- exporter generated a valid ZIP;
- both platform launchers were present;
- Recovery Kit reported Windows/macOS release v0.4.7;
- cluster was `nomsod-main-v1`;
- required credential classes and tunnel credential were present;
- `PrepareOnly` generated a fresh install tree with v0.4.7, same cluster and both local manifests;
- no real service/task configuration was touched during those isolated tests.

A stronger independence test also passed on both platforms: a temporary copy of the Recovery Kit had its `publicBaseUrl` deliberately replaced with unreachable `https://127.0.0.1:9`. Recovery `PrepareOnly` still completed successfully (Windows ~1.4s, macOS ~0.8s), proving recovery release/bootstrap does not depend on GUNN, Mac, or the public Nomsod Gateway being reachable.

### Current healthy state

Both GUNN and Mac are now on **v0.4.7**:
- cluster `nomsod-main-v1`;
- each local Gateway sees 2 devices;
- each Agent is connected to 2 Gateways;
- Supervisor and Nomsod Cloudflare connector are running;
- Windows and macOS local release mirrors are both v0.4.7;
- recovery exporter is installed on both nodes;
- Windows installed Control binary contains the Recovery Kit menu;
- macOS installed source/binary contains the Recovery Kit menu and native binary strings confirm the recovery UI/actions.

Public latest Windows/macOS manifests are v0.4.7.

Repository still has no Git remote configured. `NEW_CHAT_HANDOFF.md` remains intentionally untracked and must not be committed unless explicitly requested.

## Next step

For an ordinary third computer while any existing node is online, `Add new computer` still provides the short-lived invite flow.

For the user's explicit **no-old-machine dependency** requirement, export one Recovery Kit from either healthy v0.4.7 node and store the ZIP outside all Nomsod computers. Then even after every old Nomsod machine is wiped/offline, extract that ZIP on a replacement Windows or macOS machine and run the included recovery launcher. The only irreducible prerequisite is possession of that owner-held kit; without the old machines *and* without any external copy of the cluster credentials, restoring the same cryptographic cluster is impossible.


## Continuation update — 2026-09-29 04:48 ICT

The user clarified that the permanent bootstrap authority should simply live on the NAS, so a fresh computer can install directly from NAS without depending on any old Nomsod computer or on a user-managed Recovery Kit workflow.

### NAS identity — confirmed

The Synology NAS is **KKSM2**, not KKSM1.

Verified from GUNN over Tailscale:
- KKSM2 Tailscale DNS: `kksm2.taildd9db4.ts.net`
- KKSM2 Tailscale IP: `100.111.178.74`
- NAS hostname: `KKS`
- Linux identifies as `synology_geminilake_920+` (DS920+ family)
- DSM ports 5000/5001 are open and respond on KKSM2
- KKSM1 is a separate Linux node at `100.71.255.107`; it does not expose DSM 5000/5001

### v0.4.8 — NAS is the permanent bootstrap authority

Commit:
- `0113604 feat: make NAS the bootstrap authority`

Public v0.4.8 artifacts:
- Windows SHA-256: `98bc4ccd4f5ab19b40c5512da7a092d03418f54d32c5fe917c3a59e5933ea218`
- macOS SHA-256: `89dc7358122afce3fa5db03baf2d3f45fdfec908b3ffcb6d237b82dfad47e30e`

The NAS authority is stored at:
- NAS filesystem: `/volume1/docker/nomsod-bootstrap/current`
- Windows SMB: `\\KKS\docker\nomsod-bootstrap\current`
- macOS SMB: `smb://KKS/docker/nomsod-bootstrap/current`

User-facing launchers:
- Windows: `INSTALL-WINDOWS.cmd`
- macOS: `INSTALL-MACOS.command`

The NAS bundle contains the current Windows/macOS installers, both platform manifests, SHA-verified immutable release archives, stable `nomsod-main-v1` bootstrap material, and the existing Cloudflare tunnel credential. The old Recovery Kit mechanism remains as an internal implementation format inside the NAS bundle, but it is no longer a required user workflow and the visible Export Recovery Kit menu was removed from the Control UI.

### Release pipeline integration

New source folder:
- `scripts/nas-bootstrap/`

Important files:
- `INSTALL-WINDOWS.cmd`
- `INSTALL-WINDOWS.ps1`
- `INSTALL-MACOS.command`
- `INSTALL-MACOS.sh`
- `README.txt`
- `publish-to-nas.ps1`

`scripts/release/publish.ps1` now:
- packages `scripts/nas-bootstrap` in platform releases;
- after promoting a runtime distribution target, performs a best-effort refresh of the KKSM2 NAS bootstrap authority;
- release publication does not fail if NAS sync is unavailable.

The NAS publisher builds the bundle locally from the current cluster credentials + promoted release mirror, transfers it to KKSM2 over authenticated SSH/SCP, then activates it under the stable `current` folder. It retains a `previous` directory when rotating the authority.

### NAS permissions

DSM SMB access required group-readable mode rather than owner-only Unix mode. Final authority permissions are:
- directories: 750
- regular files: 640
- macOS launch scripts: 750
- owner/group: `gunn:users`

The Synology `docker` share remains the access boundary; the NAS bootstrap folder must not be exposed on the public web.

### Validation — PASS

Source validation for v0.4.8:
- typecheck passed;
- build passed;
- test suite passed 17/17;
- PowerShell syntax passed;
- shell syntax passed;
- Windows Control build passed;
- macOS Control compiled natively with `swiftc`.

Release publication itself confirmed automatic NAS synchronization:
- output reported `NAS bootstrap: KKSM2 / KKS updated`;
- NAS `STATUS.json` now reports version 0.4.8 for Windows and macOS, cluster `nomsod-main-v1`;
- both platform launchers exist on NAS.

Direct SMB bootstrap validation was performed from GUNN using only the NAS path and `PrepareOnly`:
- NAS authority: KKSM2
- NAS version: 0.4.8
- cluster: `nomsod-main-v1`
- prepared version: 0.4.8
- exit code: 0

This proves a new Windows computer can consume the bootstrap directly from the NAS share without relying on an old Nomsod node. The underlying macOS bootstrap path is the same bundle mechanism already validated independently on macOS in v0.4.7; the NAS now stores its v0.4.8 platform bundle as well.

### Current production state

Both GUNN and Mac have updated successfully to **v0.4.8** and remain online in `nomsod-main-v1`.

The normal desired user workflow is now:

1. Access the private KKSM2 NAS share.
2. Windows: run `INSTALL-WINDOWS.cmd`.
3. macOS: mount the NAS share and run `INSTALL-MACOS.command`.
4. The machine installs the existing cluster directly from NAS.

No old Nomsod computer needs to be online. `Add new computer` can remain as an optional convenience, not an architectural dependency.

Repository still has no Git remote configured. `NEW_CHAT_HANDOFF.md` remains intentionally untracked and must not be committed unless explicitly requested.


## Continuation update — 2026-09-29 05:54 ICT

The user wanted fresh computers to install without opening the NAS share at all: a reusable PowerShell/web link must work even when every old Nomsod computer is offline.

### Dedicated public bootstrap tunnel

A separate Cloudflare named tunnel was created specifically for installation:
- name: `nomsod-bootstrap`
- hostname: `install.nomsod.net`
- tunnel ID: `db35e765-6d73-4e15-8564-1d627553bcb7`

Its credential is stored privately on KKSM2 under:
`/volume1/docker/nomsod-bootstrap/runtime/bootstrap-tunnel-credentials.json`
with mode 600. Never print or expose its JSON contents.

This tunnel is intentionally separate from `nomsod-mcp`. It terminates on KKSM2 and serves only the tokenized bootstrap tree through:
- `nomsod-bootstrap-edge` (nginx)
- `nomsod-bootstrap-tunnel` (cloudflared)

Because the install tunnel is independent, GUNN and Mac are not needed for a fresh install. The normal MCP tunnel remains unaffected.

### Private magic-link bootstrap

KKSM2 keeps a high-entropy bootstrap token at:
`/volume1/docker/nomsod-bootstrap/bootstrap-token`

Do not print the token in handoff/docs. The actual commands are stored on NAS under the tokenized public directory. The URL shape is:

Windows:
`irm https://install.nomsod.net/bootstrap/<private-bootstrap-token>/windows.ps1 | iex`

macOS:
`curl -fsSL https://install.nomsod.net/bootstrap/<private-bootstrap-token>/macos.sh | sh`

The token is a long-lived owner credential. Wrong/unknown token paths return HTTP 404.

The public Windows script self-elevates through UAC when needed, downloads the current bundle from KKSM2, verifies the normal release SHA through the existing recovery bootstrap, and installs Gateway + Agent into the same `nomsod-main-v1` cluster.

### Cross-platform ZIP fix

Windows PowerShell `Compress-Archive` generated backslash paths that macOS could not extract correctly. The NAS publisher now creates the public `bundle.zip` with Windows bsdtar (`tar.exe -a -cf ...`), producing a ZIP that extracts correctly on both Windows and macOS.

### v0.4.11 — final public-link release

Commits:
- `98b0701 feat: add direct public bootstrap link`
- `254d4df fix: isolate public bootstrap on NAS`
- `e490b0a chore: release 0.4.11`

The first direct-link iteration tried to reuse the MCP tunnel and propagate bootstrap files through Gateway nodes. That was deliberately simplified in `254d4df`: the unnecessary Supervisor/bootstrap-proxy changes were reverted, and the final design uses the dedicated NAS-only `install.nomsod.net` tunnel.

Public v0.4.11 artifacts:
- Windows SHA-256: `32d436c990688473ec74d08325a77fe01e9a3f64e19bab7a05f4a0d52c943032`
- macOS SHA-256: `de2127d702971000180c575424a2960299421d4a1b728ec2d2244eca945277fb`

Validation:
- typecheck passed;
- build passed;
- tests 17/17 passed;
- release publication succeeded;
- automatic NAS refresh succeeded;
- dedicated `nomsod-bootstrap` tunnel has an active Linux connector;
- `install.nomsod.net` resolves and the valid Windows script returns HTTP 200;
- an invalid token path returns HTTP 404;
- Windows public-bundle `PrepareOnly` restored v0.4.11 / `nomsod-main-v1`;
- macOS public-bundle `PrepareOnly` restored v0.4.11 / `nomsod-main-v1`;
- the same public ZIP contains both platform installers and extracts correctly on both systems.

Both GUNN and Mac updated successfully to **v0.4.11** and remain online in `nomsod-main-v1`. NAS `STATUS.json` reports authority KKSM2, version 0.4.11, and install host `install.nomsod.net`.

The preferred fresh-machine workflow is now the private magic-link command. SMB access to KKSM2 remains only a fallback, not a user requirement.

Repository still has no Git remote configured. `NEW_CHAT_HANDOFF.md` remains intentionally untracked and must not be committed unless explicitly requested.


## Continuation update — 2026-09-29 06:05 ICT

Fresh install was attempted on Windows machine **MATH**, but Nomsod did not join the cluster. Current Nomsod list still contains only GUNN + Mac.

Independent network evidence:
- MATH is online in Tailscale as `math.taildd9db4.ts.net`
- Tailscale IPv4: `100.114.204.42`
- OS: Windows
- TCP 22/135/139/445 are reachable from GUNN
- Nomsod ports 34100 and 34122 are not listening
- SSH server is reachable but current GUNN keys/users are not authorized
- WMI/DCOM remote inspection is denied, so local MATH installer logs cannot be read remotely yet

NAS nginx access logs prove the MATH attempt reached the dedicated install service successfully:
- it fetched the tokenized `windows.ps1` with HTTP 200
- the elevated copy fetched `windows.ps1` again with HTTP 200
- it fetched `bundle.zip` with HTTP 200

Therefore the magic link / Cloudflare / NAS download path works. The failure happens locally on MATH after the bootstrap bundle has downloaded and before Nomsod services are running.

Commit:
- `88147f7 fix: keep Windows bootstrap errors visible`

The public Windows bootstrap wrapper now:
- writes a persistent transcript to `C:\Users\Public\Nomsod-MCP-Install.log`;
- prints the current install stage;
- preserves the actual error message;
- if the elevated UAC installer fails, it waits for Enter instead of disappearing immediately;
- the parent PowerShell also prints the log path and the last installer messages.

KKSM2 public bootstrap was refreshed after this change while remaining on release v0.4.11. Fetch validation confirmed the served `windows.ps1` now contains the persistent log, staged diagnostics, elevated switch and failure pause.

Next MATH test: rerun the same private PowerShell magic-link command. If it fails, the elevated window will stay open and the persistent log will be at `C:\Users\Public\Nomsod-MCP-Install.log`. Once the exact failure is known, fix the underlying local install stage rather than guessing.


## Continuation update — 2026-09-29 06:32 ICT

The user clarified that the target test machine was **MATH over SSH**, not HHH.

SSH alias `math` on GUNN is configured and works:
- hostname: MATH
- user: `math\gunnc`
- SSH config host: `math.taildd9db4.ts.net`
- identity: `C:/Users/gunnc/.ssh/nomsod_math_ed25519`
- the SSH session runs with High Mandatory Level / administrator privileges

### Real public-link install test on MATH

The actual private `install.nomsod.net` PowerShell bootstrap link was run remotely on MATH.

First real attempt exposed a fresh-Windows bug:
- `scripts/windows/install.ps1` called `schtasks.exe /End /TN "NomsodMCP-Control"` even when that task did not yet exist.
- PowerShell 5.1 converted the missing-task stderr into a terminating NativeCommandError because the installer uses `$ErrorActionPreference = "Stop"`.

Fix/release:
- commit `b890fbc fix: tolerate missing control task on fresh Windows install`
- v0.4.12 artifact contains the fix.

Second real attempt progressed further and exposed the same class of bug in:
- `scripts/windows/install-cloudflared-background.ps1`
- missing `NomsodMCP-Cloudflared` task caused `schtasks /End` to terminate the fresh install.

Fix/release:
- commit `1a94faf fix: tolerate missing tunnel task on fresh Windows install`
- v0.4.13 artifact contains the fix.
- KKSM2 NAS bootstrap was refreshed to v0.4.13.

### Final MATH result — PASS

A final real-link install on MATH completed with `INSTALL_EXIT=0`.

It successfully created:
- NomsodMCP-Supervisor
- NomsodMCP-Agent
- NomsodMCP-Control
- NomsodMCP-Updater
- NomsodMCP-Watchdog
- NomsodMCP-Cloudflared
- NomsodMCP-Cloudflared-Watchdog

Because earlier failed attempts had left 0.4.12 Supervisor/Agent processes running, a one-time repair on MATH stopped only Nomsod processes/tasks and reran the installed v0.4.13 installer. Final validation:
- file VERSION: 0.4.13
- Supervisor health: 0.4.13
- Agent health: 0.4.13
- cluster: `nomsod-main-v1`
- Agent connected to 2 Gateways
- Supervisor task: Running
- Agent task: Running
- Cloudflared task: Running
- MATH now appears in Nomsod `list_computers` as online, Windows x64, v0.4.13.

Current Nomsod list at the end of this repair showed MATH and GUNN online at v0.4.13. Mac was temporarily absent from that final list and should be rechecked separately if needed.

The Windows public bootstrap now also keeps failures visible and writes a persistent log at:
`C:\Users\Public\Nomsod-MCP-Install.log`

Repository still has no Git remote configured. `NEW_CHAT_HANDOFF.md` remains intentionally untracked.


## Continuation update — 2026-09-29 07:00 ICT

The two generic `sh` entries shown in macOS System Settings -> Login Items were confirmed to be Nomsod background helpers:
- `com.nomsod.mcp.updater` -> `scripts/macos/update.sh`
- `com.nomsod.mcp.watchdog` -> `scripts/macos/watchdog.sh`

They appeared as `sh` because their LaunchAgent `ProgramArguments[0]` was `/bin/sh`.

Fix/release:
- commit `cfc6cca fix: name macOS updater and watchdog background items`
- version `0.4.14`

The macOS installer now uses named executable wrapper scripts:
- `Nomsod MCP Updater`
- `Nomsod MCP Watchdog`

Mac updated successfully to v0.4.14. Its LaunchAgent plists now point to those named executables, and `sfltool dumpbtm` confirms macOS Background Task Management displays:
- Name: Nomsod MCP Updater
- Name: Nomsod MCP Watchdog

`sshd` is unrelated to Nomsod; it is the macOS OpenSSH server used for Remote Login and should remain enabled if SSH access is needed.


## Continuation update — 2026-09-29 07:13 ICT

The user asked to reduce the visible Nomsod macOS background items and make the remaining items show the Nomsod app icon.

Release:
- commit `9be5c6f feat: merge macOS housekeeping into supervisor`
- version `0.4.15`

macOS changes:
- `Nomsod MCP Updater` is no longer a LaunchAgent/Login Item; Supervisor launches the updater runner every 60 seconds as detached housekeeping.
- `Nomsod MCP Watchdog` is no longer a LaunchAgent/Login Item; Supervisor now performs the Agent health check every 60 seconds and requests a launchd restart if Agent health fails.
- Supervisor itself remains protected by launchd `KeepAlive`.
- legacy `com.nomsod.mcp.updater` and `com.nomsod.mcp.watchdog` plists are removed during install/migration; Supervisor also performs delayed legacy-job cleanup after an update migration.
- remaining visible role items are Supervisor, Agent, and Control.

App/icon association:
- Supervisor and Agent already run from real `.app` bundles containing `AppIcon.icns`.
- Control runs from `~/Applications/Nomsod MCP.app` with the same icon.
- the installer now registers these bundles with LaunchServices.
- launchd plists now include `AssociatedBundleIdentifiers`:
  - Supervisor -> `net.nomsod.mcp.supervisor`
  - Agent -> `net.nomsod.mcp.agent`
  - Control -> `net.nomsod.mcp.control`
This lets macOS associate the background entries with the actual Nomsod app bundles instead of treating them as generic executables.

Validation:
- macOS shell syntax passed.
- TypeScript typecheck/build passed.
- tests passed 17/17.
- Mac updated successfully to v0.4.15.
- Mac LaunchAgents now contain only Nomsod Agent, Supervisor, Control, and Cloudflared; updater/watchdog plist files are gone.
- legacy updater/watchdog launchd jobs were explicitly unloaded and confirmed not loaded.
- Supervisor/Agent/Control plists contain the expected associated bundle IDs.
- all three app bundles contain non-empty `AppIcon.icns`.
- public Windows/macOS latest manifests and KKSM2 NAS bootstrap all report v0.4.15.

Note: macOS System Settings may cache old Background Task Management rows until the pane is reopened or the Mac is restarted. Do not use `sfltool resetbtm` because it would reset unrelated background-item approvals (for example Tailscale/Karabiner).
