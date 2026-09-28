Nomsod MCP Recovery Kit

THIS FILE SET IS SENSITIVE.

It contains the credentials needed to reconstruct the existing Nomsod cluster
when every Nomsod computer is unavailable or has been wiped.

Keep the recovery ZIP outside Nomsod computers, for example on protected
external storage. Anyone who obtains the kit can restore the cluster.

Windows:
  1. Extract the ZIP.
  2. Right-click RECOVER-WINDOWS.ps1 and run with PowerShell
     (or run it from a PowerShell terminal).

macOS:
  1. Extract the ZIP.
  2. In Terminal, cd into the extracted folder.
  3. Run:
       chmod +x RECOVER-MACOS.sh
       ./RECOVER-MACOS.sh

The recovery flow restores the SAME cluster. It does not create a new network.
