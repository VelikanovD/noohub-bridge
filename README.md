# NooHub Bridge for Wiren Board and SprutHub

Bridge for integrating NooHub / nooLite devices with Wiren Board virtual devices and SprutHub over a separate MQTT broker.

Current package: `v11`.

## Features

- Creates Wiren Board virtual devices for NooHub devices.
- Sends commands to NooHub through the local HTTP API.
- Polls device state through `get_state`.
- Saves `Polling Enabled` and `Poll Interval, sec` in `/var/lib/wirenboard/noohub_bridge_config.json`.
- Supports polling interval from 1 to 180 seconds.
- Includes protection against too frequent polling: if polling cycles are slower than the configured interval or repeatedly overlap, the bridge raises the interval to 5 seconds and saves it.
- Mirrors NooHub MQTT topics to a separate Mosquitto broker for SprutHub.
- Includes SprutHub custom templates for switch, dimmer, and impulse devices.
- Includes a separate optional cleanup script for old temporary diagnostics from v10.

## Files

- `noohub_bridge.js` - main Wiren Board rules file.
- `install_noohub_bridge.sh` - deployment script for Wiren Board.
- `noohub_delete_virtual_devices.sh` - helper for removing NooHub virtual devices.
- `noohub_resync_selected_devices.sh` - helper for selective CH resync.
- `noohub_spruthub_mqtt_proxy.sh` - MQTT proxy for SprutHub.
- `noohub_spruthub_mosquitto.*` - separate Mosquitto service for SprutHub.
- `noohub_spruthub_mqtt_proxy.*` - proxy service config.
- `noohub_cleanup_diagnostics.sh` - optional cleanup for old v10 diagnostics.
- `Custom/*.json` - SprutHub custom templates.

## Install On Wiren Board

Copy this folder to Wiren Board, then run:

```sh
sh install_noohub_bridge.sh
```

The installer:

- backs up existing `/etc/wb-rules/noohub_bridge.js`;
- installs the main bridge file;
- installs required helper scripts;
- installs and restarts the separate Mosquitto service for SprutHub;
- installs and restarts the MQTT proxy service;
- restarts `wb-rules`.

The installer does not install or remove `tcpdump`.

## Optional Cleanup

If v10 traffic diagnostics were installed earlier, cleanup can be run manually:

```sh
sh noohub_cleanup_diagnostics.sh
```

This removes old diagnostics helper scripts, temporary capture logs, and `tcpdump` if it is installed.

## SprutHub

Upload templates from `Custom/` through the SprutHub web interface:

- `NooHub-Switch.json`
- `NooHub-Dimmer.json`
- `NooHub-Impulse.json`

Connect SprutHub MQTT controller to the Wiren Board IP and the configured bridge port. Default port: `45883`.

## Notes

NooHub currently exposes state through HTTP `get_state`, so this bridge uses polling for feedback. For stability, start with a polling interval of 5-30 seconds. One-second polling is available for tests and small installations, with automatic protection enabled.
