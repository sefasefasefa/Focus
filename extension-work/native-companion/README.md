# RODON device companion

This native messaging host provides a stable device ID to the browser extension so deleting or reinstalling the extension does not restart the free trial.

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

## Device identifier and privacy

The helper reads the operating system's stable machine identifier and hashes it locally with SHA-256. Only the prefixed hash (`rdn1_...`) is sent to the license API; the raw OS identifier is not returned to the extension or sent to the server. The server retains the hash after logout and extension removal so another email cannot restart the free trial on that OS installation.

This is a persistent OS-installation identifier, not a hardware-backed attestation. Reinstalling the operating system, changing the system machine identifier, or using a cloned virtual machine can produce or copy a different identifier. A determined user with administrator access can also alter or spoof local software. macOS builds are unsigned and may prompt for approval when first run.

## Supported browsers

- Google Chrome
- Microsoft Edge
- Mozilla Firefox

The installer creates a native messaging manifest for the selected browser IDs. Chrome and Edge IDs must be entered because they depend on the published extension package.
