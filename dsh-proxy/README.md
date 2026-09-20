# dsh-proxy

A DeepSeek Harness plugin that exposes the local DSH web app (default `127.0.0.1:3080`) on a **second, authenticated port** for LAN access.

- **HTTP + WebSocket reverse proxy** — real-time streams keep working.
- **Native Basic Auth (off by default)** — the **browser's own credential dialog**, no custom login page, no session cookies. Username and password default to empty (open LAN access: anyone who can reach the port is in); setting **both** in the settings page turns password login on, after which unauthenticated requests are answered with `401 + WWW-Authenticate: Basic` and the browser pops its native dialog. After a successful login the browser caches the credentials for the origin and sends them automatically (including on WebSocket handshakes).
- **A popup on every page load while it is open** — when the proxy is actually listening on a network address with no password, the browser half raises a frame-wide notice ("⚠️ The LAN proxy is open without a password") naming the exposed address and the consequence; startup logs a SECURITY WARNING and the settings page flags password login in red as well. Behavior is unchanged; the open state just stops being silent. The notice keeps **no memory at all** — "Got it" closes only the current one, and the next open/refresh warns again, because an unauthenticated network listener is a standing risk rather than a one-off event.
- **Login page + sessions (HTTPS)** — behind a TLS reverse proxy, an unauthenticated visitor gets a self-contained login form; a successful login issues a session cookie (`__Host-` + `Secure` + `HttpOnly` + `SameSite=Strict`) with **logout, idle/absolute expiry, and a live session list you can revoke**
- **One gate, including cleartext** — an `http://` LAN-IP visitor gets the **same login page** by default; because a `Secure`/`__Host-` cookie is never stored over http, that session uses a weaker cookie variant and both the settings page and the startup log say so. Set `cleartextAuth: 'basic'` to restore the native Basic dialog, or `requireTls: true` to refuse cleartext outright
- **Login throttling + audit** — failures are counted per source IP (5 tries, 15-minute lockout; the correct password is refused while locked) and every login/failure/lockout/logout is appended to `$DSH_HOME/dsh-proxy-audit.jsonl` with **no credentials**
- **Settings page** — DSH settings → "LAN Proxy": shows the running ports and whether password login is enabled, **starts/stops the proxy**, and edits the proxy listen port, username, and password; saving persists the patch to `$DSH_HOME/dsh-proxy.json` and immediately restarts the forwarding service.
- **Out-of-the-box compatibility fixes** — `Host`/`Origin` rewriting (passes the DSH `/api` same-origin trust fence from the LAN) and a `crypto.randomUUID` polyfill injected into proxied HTML (non-secure LAN contexts lack it, which would break every RPC).
- **In-browser directory picker** — DSH mounts the OS chooser whenever the web app is loopback-bound (`dsh-host-directory-picker-auto`'s rule), so "add workspace" opened a dialog on the HOST screen that a remote visitor cannot see. The plugin pins the in-app browse interaction instead, so the picker renders in the page on any device.
- **Lives inside `dsh web`** — no separate process; configured through the profile's `cordis.patch.yml`.

> Why: the DSH web server deliberately refuses `--host 0.0.0.0` (it would expose remote code execution to the network). This plugin is the sanctioned way out: a separate authenticated listener that proxies back to loopback.
>

## Install

**Online install (recommended)** — directly from GitHub, no need to download the repository. The command pins the released version (`v0.1.4`):

```bash
dsh plugin --profile web add github:wenxingyu/dsh-proxy#v0.1.4
```

**Local install** (repository cloned/downloaded on this machine):

```bash
dsh plugin --profile web add file:C:/mydata/codes/dsh-proxy
```

The installed package is **`@wenxingyu/dsh-proxy`** (scoped, with the username prefix) and shows up as `@wenxingyu/dsh-proxy@0.1.4` in `dsh plugin ls`.

Then **restart `dsh web`**. If port 3081 is taken (e.g. another dsh-proxy instance is still running), stop it first or change `listenPort` below.

## Configuration

All knobs have schema defaults; override them in the **profile's `cordis.patch.yml`** (a patch replaces the row's whole config, so restate every key you change):

```yaml
# C:\Users\cc\.dsh\profiles\web\cordis.patch.yml
- id: dsh-proxy
  config:
    listenHost: '0.0.0.0'      # bind interface; 0.0.0.0 = LAN reachable
    listenPort: 3081            # proxy port (default 3081)
    upstreamHost: '127.0.0.1'   # upstream DSH host
    upstreamPort: 0             # 0 = follow the web app's actual bound port
    username: ''                # login username (default empty = password login off)
    password: ''                # login password (default empty = password login off)
```

- Default `username` and `password` are both empty = **password login off**: anyone who can reach the port gets straight in (open LAN access — not recommended). Password login turns on **only when both are set**; setting just one keeps it off.
- Listening itself is unchanged by missing credentials: `listenHost: '0.0.0.0'` still binds the LAN, so you can reach the settings page from another device and set the credentials there. What changes is that this "network-reachable and password-free" state is now **stated loudly** — a one-time popup in the web UI, a startup SECURITY WARNING, a red banner in the settings page, and the `lanExposed` field on the status endpoint.
- The popup rides the framework's `shell.overlay` seat: it is **not a modal** (the app stays usable; only the card takes clicks) and it asks the status endpoint at most once per page load.
- Repeat policy: **every page load** (open or refresh) re-warns; nothing is written to `localStorage` and there is no "already seen" state, so the dismissal cannot silence it. Within one page load the status endpoint is still queried at most once (a remounting frame must not turn the alert into a poll).

## Settings page (port / credentials / start-stop)

After restarting `dsh web`, open DSH settings (gear icon) → "LAN Proxy":

- **Status**: two red/green running lights — the **proxy port** (listen address:port; green = the proxy is actually bound, red = bind failed e.g. port busy) and the **default service port** (DSH service port; green = the default service answers a probe, red = unreachable) — plus the current username and whether password login is enabled. A **Start/Stop** button pair sits in the card header: Start is grayed out while running, Stop is grayed out while stopped.
- **Edit settings**: change the **proxy listen port**, **username**, and **password** (leave empty to set blank). "Apply" writes `$DSH_HOME/dsh-proxy.json` and **immediately restarts the forwarding service**; changing the listen port moves the LAN access address.

Settings-page changes persist and take precedence over the profile's `cordis.patch.yml`; `listenHost` / `listenPort` remain cordis-only. The page talks to the host through an exact `POST /api/dsh-proxy` route on Connection's shared `/api` channel (`status` / `update` / `start` / `stop` endpoints); Connection owns the request-trust fence and the browser session check (still reachable from the LAN via the proxy's Host rewrite).

## Usage

1. Restart `dsh web`; the startup log prints the URLs:
   ```
   dsh-proxy: listening on 0.0.0.0:3081 -> http://127.0.0.1:3080
   dsh-proxy: 局域网访问 http://192.168.1.100:3081
   ```
2. Browse to `http://<your-LAN-IP>:3081` → the browser shows its **native Basic Auth dialog** → enter the credentials → the DSH UI loads. The browser remembers the credentials, so subsequent visits open directly.

> DSH's own browser session: the Web UI also requires a session cookie minted from the per-process launch token, and the `?token=...` URL `dsh web` prints points at loopback — useless for a LAN device. The plugin completes that exchange for the address you actually used (an unauthenticated `GET /` is answered with a 302 to `http://<your-address>:<port>/?token=...`, which sets the cookie and bounces back to a clean `/`), so a first LAN visit needs no manual token copying. Just open the URL above.

> Windows Firewall: if LAN devices cannot connect, allow the port (admin PowerShell):
> `netsh advfirewall firewall add rule name="dsh-proxy" dir=in action=allow protocol=TCP localport=3081`

## Development

```bash
pnpm install
pnpm run check   # typecheck + test + build
pnpm run smoke   # full live smoke test against a running DSH on 127.0.0.1:3080
```

- `src/` — TypeScript source. `src/proxy.ts` is the pure-node proxy core (no cordis, independently testable); `src/controller.ts` is the proxy controller (start/stop/restart/status/update plus settings persistence); `src/index.ts` is the cordis plugin entry (including the `/api/dsh-proxy` exact route), `src/client/transport.ts` is the browser-side caller; `src/client/` is the browser settings section.
- `lib/` — committed build artifacts; `lib/index.cjs` is a fully self-contained host bundle (schemastery, http-proxy, dsh-home-paths inlined) and `lib/client.js` the browser bundle (react only external).
- `tests/` — vitest: auth primitives, pure functions, proxy integration (HTTP + WebSocket), the controller against a real in-process upstream with a temp settings file, and a jsdom render of the settings section.

## Authentication details

- **Enablement**: password login is active only when `username` AND `password` are both non-empty (defaults are empty = open access); setting just one keeps it off.
- **Exposure flag**: `status.lanExposed` is `true` exactly when the listener is up, bound to a non-loopback host, and password login is off — i.e. the LAN surface is open. The web popup, the settings page's red badge and warning, and the host's SECURITY WARNING all read this one flag. It describes risk only; it never changes what is bound.
- **One mechanism, two cookie strengths**: TLS (`X-Forwarded-Proto: https` from a trusted peer) or a loopback browser → login page with a `__Host-`+`Secure` cookie; a plain-HTTP LAN IP → the **same login page** with a non-`Secure` cookie (a `Secure` cookie would not be stored), or Basic when `cleartextAuth: 'basic'`. `X-Forwarded-Proto`/`X-Forwarded-For` are honored **only from a trusted peer** (loopback always, plus `trustedProxies`), so forged headers cannot bypass the throttle.
- **Sessions**: server-held 32-byte tokens, 7-day absolute and 12-hour idle expiry, dropped on restart; the settings page lists them and can revoke one or all others. The cookie is `__Host-dsh_proxy_session` in a secure context and `dsh_proxy_session` on cleartext (no `Secure`/`__Host-`, which http cannot store).
- **Mechanism**: HTTP Basic Auth via the browser's native dialog — every unauthenticated request (page, `/api/*`, scripts) gets `401 + WWW-Authenticate: Basic realm="dsh-proxy"`; WebSocket rejections carry the same header. There is **no custom login page and no session cookie**; after a successful login the browser caches the credentials per origin and sends them automatically (including on WebSocket handshakes).
- **Public static files**: `/manifest.webmanifest` and `/favicon.svg` bypass the gate — browsers fetch them in credential-less contexts (PWA manifest, favicon), so requiring authentication would 401 them. They carry no secrets.
- Credential comparison is constant-time (`timingSafeEqual`).

## Security notes

- **The LAN surface is OPEN by default** (empty username/password). Set **both** credentials in the settings page as soon as possible — the page marks this state in red and the startup log warns about it.
- The warning is deliberately tied to the real condition: a loopback-only bind is not flagged (no exposure), and neither is a stopped service.
- Once password login is enabled, DSH's `/api` trust fence sees the rewritten loopback `Host`, so **privileged RPCs (settings/credentials) are reachable from the LAN** — the Basic Auth gate is the only barrier.
- Browser-cached Basic credentials are NOT invalidated by a password change: the old credentials get a 401 and the dialog reappears; enter the new password. To fully clear them, remove the site's saved password in the browser.
