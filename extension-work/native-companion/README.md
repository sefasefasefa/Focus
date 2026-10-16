# RODON device companion

This native messaging host provides a stable operating-system device ID and optional network MAC addresses to the browser extension so deleting or reinstalling the extension does not restart the free trial.

## Build

From this directory, run:

```sh
bash build-all.sh
```

The script cross-builds Windows, macOS, and Linux binaries for x64 and ARM64 into `generated-artifacts/native-companion/`. Each target folder contains the self-contained executable and this guide. No Node.js or third-party runtime is needed on the customer's computer.

## Install

Use the release folder matching the computer's operating system and processor. Close the browsers before upgrading an existing helper:

- Windows: open PowerShell in the extracted folder and run `.\rodon-device-host.exe --install`.
- macOS/Linux: run `./rodon-device-host --install` in a terminal.

The installer asks for the Chrome and Edge extension IDs; press Enter to skip a browser. Firefox uses the extension ID declared in `manifest.json`. On Windows it registers the native host under the current user, without administrator access. Close and reopen the browser after installation.

To find a Chrome or Edge extension ID, open the browser's extension details page and copy the ID shown there. The installed extension ID must match the value entered during companion installation.

## Device identifiers and privacy

The helper reads the operating system's stable machine identifier and hashes it locally with SHA-256. Only the prefixed hash (`rdn1_...`) is returned to the extension for the OS identifier; the raw OS identifier is never sent to the server.

The helper also reports globally administered, unicast MAC addresses from available network interfaces. Locally administered addresses, often used for Wi-Fi randomization or virtual adapters, are excluded. The extension sends these MAC addresses to the API over HTTPS for comparison; the server stores only a keyed HMAC, not the raw address. If no eligible MAC is available, the OS device ID remains in use. The server retains both histories after logout and extension removal.

The native companion must be version 1.1.0 or later for the MAC field. This is a best-effort identifier, not hardware-backed attestation: network adapters can be replaced, and MAC addresses can be changed or spoofed. Reinstalling the operating system or changing its machine identifier can also change the OS-based ID. A determined user with administrator access can alter local software. macOS builds are unsigned and may prompt for approval when first run.

## Supported browsers

- Google Chrome
- Microsoft Edge
- Mozilla Firefox

The installer creates a native messaging manifest for the selected browser IDs. Chrome and Edge IDs must be entered because they depend on the published extension package.
