Nomsod MCP NAS Bootstrap Authority

This folder is the permanent bootstrap source for the one Nomsod cluster:
  nomsod-main-v1

The NAS is the authority. Computers are disposable nodes.

Windows
-------
Open the NAS folder and run:
  INSTALL-WINDOWS.cmd

macOS
-----
Open/mount the NAS folder and run:
  INSTALL-MACOS.command

No existing Nomsod computer needs to be online.
The installer uses the cluster identity, release files and public-tunnel
credential stored in the private bundle folder on this NAS.

IMPORTANT
---------
This directory contains sensitive Nomsod cluster credentials.
Keep the NAS share restricted to the owner/admin account.
Do not publish this folder to the public web.
