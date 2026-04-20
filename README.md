# Audio Bonanza - Extension & LAN server

<img src="audio-bonanza-extension/assets/fancy.jpg" style="width: 50%"/>


**Audio Bonanza** is a **totally free** Chrome extension for **fun** audio control (speed, reverb, bass, pitch).

The **LAN server** is optional and provides a UI to remotely send **play/pause** to tabs on the machine running it (with the extension enabled).

## Extension (primary)

- Lives in `audio-bonanza-extension`.
- Works without the server.
- Provides the full audio controls via the extension popup.

### Load the extension

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select the `audio-bonanza-extension` folder.

## LAN server (optional play/pause remote)

- Lives in `LAN-server/`.
- Serves a small web UI (tabs list + play/pause).
- Pushes play/pause commands to the extension over Server-Sent Events (SSE).

### Run the server

```bash
python3 LAN-server/server.py
```

Open `http://localhost:5055` and use the token shown in the UI (QR code is optional).

### Flow

```mermaid
sequenceDiagram
  participant UI as Web UI (LAN server)
  participant Server as Flask Server
  participant Ext as Extension (background)
  participant Tab as Browser Tab

  UI->>Server: POST /cmd {tabId, action}
  Server-->>Ext: SSE /events (play/pause)
  Ext->>Tab: executeScript(play/pause)
  Ext-->>Server: POST /tabs (tab list updates)
  Server-->>UI: SSE /tab-events (tabs)
```

## Roadmap

Planned features and ideas are tracked in [issues](../../issues).