# dsh-proxy

English | [中文](README.md)

A DSH (DeepSeek Harness) plugin that exposes the Web UI (default `127.0.0.1:3080`) on a **second, authenticated port** so other devices on the same LAN can reach it safely.

The DSH server deliberately refuses `--host 0.0.0.0` (it would expose remote code execution to the network). This plugin is the sanctioned way out: a separate authenticated listener that proxies back to loopback.

## Features

- **Full HTTP + WebSocket forwarding** — real-time task state and log streams keep working.
- **Native Basic Auth (off by default)** — the browser's own credential dialog; no custom login page, no session cookies. Username and password default to empty (open LAN access); setting **both** in the settings page turns password login on (including on WebSocket handshakes).
- **Settings page** — DSH settings → "LAN Proxy": status lights, start/stop, and edits to the listen port, username, and password (persisted to `$DSH_HOME/dsh-proxy.json`).
- **Automatic LAN login** — DSH's browser session needs a cookie minted from its per-process launch token, and the token URL `dsh web` prints is loopback-only. The plugin completes that exchange for the address you actually used, so the first LAN visit just works.
- **In-browser directory picker** — "Add workspace" opens the chooser inside the page instead of an OS dialog on the host screen.
- **Out-of-the-box compatibility fixes** — `Host`/`Origin` rewriting (passes the DSH `/api` same-origin trust fence from the LAN) and a `crypto.randomUUID` polyfill injected into proxied HTML (non-secure LAN contexts lack it, which would break every RPC).
- **Lives inside `dsh web`** — no separate process and no downloadable binary.

<p align="center">
  <img src="doc/image-en.png" alt="dsh-proxy settings page (English UI)" width="720" />
</p>

## Install

**Online install (recommended)** — directly from GitHub, no need to download the repository:

```bash
dsh plugin --profile web add github:wenxingyu/dsh-proxy#master
```

**Local install** (repository cloned/downloaded on this machine):

```bash
dsh plugin --profile web add file:C:/mydata/codes/dsh-proxy
```

Then **restart `dsh web`** (Ctrl+C, run it again): the startup log prints the listening address and the LAN URL.

## Usage

Browse to `http://<your-LAN-IP>:3081` → the browser shows its native Basic Auth dialog (or goes straight in while no credentials are set) → the DSH UI loads. The browser remembers the credentials and session, so later visits open directly.

Configuration, the settings page, the directory picker, and development notes live in [`dsh-proxy/README.md`](dsh-proxy/README.md).

> Windows Firewall: if LAN devices cannot connect, allow the port (admin PowerShell):
> `netsh advfirewall firewall add rule name="dsh-proxy" dir=in action=allow protocol=TCP localport=3081`
