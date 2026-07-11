# Magiloom Server

The headless backend for Magiloom — the desktop app's `src/main` process, minus
Electron, exposed over WebSocket. It lets a **PWA** (or the desktop app in a future
"remote" mode) drive DragonRealms without installing anything locally, and it's
where **Lich runs remotely**.

> Extracted from the main repo as a copy. The desktop app is untouched and still
> works standalone. Move this folder to its own repo when ready.

## How it maps to the desktop app

| Desktop (`src/main`) | Here | Notes |
|---|---|---|
| `index.ts` IPC wiring | `src/session.ts` + `src/gateway.ts` | `ipcMain.handle` → `invoke`; `webContents.send` → `event` |
| `game-connection.ts`, `lich-manager.ts`, `sge-auth.ts`, `settings-store.ts`, `cmd-*.ts`, `broadcast-bus.ts`, `map-store.ts`, `log-store.ts`, `avatar-service.ts`, `portrait-service.ts` | `src/lib/*` | **Copied verbatim** — all were already Electron-free |
| `safeStorage` password crypto | `src/crypto.ts` | AES-256-GCM keyed by `MAGILOOM_SECRET` |
| Windows / dialogs / updater | dropped | client-side concerns on the web build |
| desktop toast/desktop notifications | `src/push.ts` + `src/trigger-engine.ts` | server evaluates alert rules → Web Push |
| (new) per-user data isolation | `src/user-context.ts` | one dir per user; scales to many users |
| (new) multi-Lich support | `src/port-allocator.ts` | unique Lich frontend port per session |

Each connected client gets its own `Session` (its own game socket + Lich + script
engine + trigger engine), exactly like one Electron window.

### Data model (multi-user)

- **Per user** (`data/users/<id>/`): `settings.json` (accounts, passwords,
  characters), the multi-box `broadcast` bus, and logs. A user's phone + desktop
  share one in-memory store (no write race). Plain JSON, one small file per user —
  fine for hundreds of users; **no Postgres needed**.
- **Server-global**: the world **map** is one shared DB (community map, like the
  desktop's shared map DB), and Lich frontend **ports** come from a shared pool.
- **User identity**: today the WS `?user=<account>` param picks the bucket (a
  client-supplied hint). In production, derive it from an authenticated per-user
  token instead of trusting the client — see Known limitations.

### Server-side triggers → push

`trigger-engine.ts` evaluates each user's **notification rules** (`notifRules`)
against the game stream and calls `push.notify(payload, userId)` — so alerts fire
even when the PWA is closed (a closed page runs no JS, so the client can't).
Push subscriptions are keyed by `userId`, so only that user's devices are pinged.
**Command** triggers (rules that send a game command) are OFF server-side by
default to avoid double-firing while the renderer still evaluates them; flip
`autoRunCommandTriggers` in `session.ts` once the thin client stops doing so.

### Per-user Lich homes & file editing

Lich keeps per-character setup (`scripts/profiles/<Char>-setup.yaml`), personal
scripts (`scripts/custom/`), and a char-keyed SQLite DB (`data/lich.db3`). Sharing
one home across users would cross-contaminate settings and lock the DB, so each
user gets an isolated home at `data/users/<id>/lich/` (`lich-home.ts`). The
immutable Lich engine (`lib/`) and the ~234-script community library
(`scripts/*.lic`) come from the shared read-only base (`MAGILOOM_LICH_SHARED`,
baked at `/opt/lich`) and are **symlinked** into each home — no per-user copies.
Launch flags: `--home=<user home> --lib=<shared>/lib --scripts=<user home>/scripts`.

Users manage their setup through the PWA (upload + in-app edit) via four channels,
**path-jailed** to their `profiles/` and `custom/` dirs only (the shared library
and everything else are read-only and unreachable):

| channel | args | does |
|---|---|---|
| `lich:list-files` | — | list files in profiles/ + custom/ |
| `lich:read-file`  | `rel` | read one file's text |
| `lich:write-file` | `rel`, `content` | create/overwrite (upload or edit) |
| `lich:delete-file`| `rel` | delete |

`rel` is e.g. `profiles/Caerla-setup.yaml`; anything resolving outside the two
editable dirs is rejected.

## Wire protocol

WebSocket at `/ws`, JSON envelopes mirroring Electron IPC:

```
client → server   { "t":"invoke", "id":1, "channel":"game:send", "args":["look"] }
server → client   { "t":"result", "id":1, "ok":true, "result":null }
server → client   { "t":"event",  "channel":"game:data", "args":["<stream ...>"] }
```

The renderer's WebSocket `dr.*` transport (the next step) maps each
`dr.game.send(x)` to an `invoke` and each `dr.game.onData(cb)` to the `game:data`
event — so the existing React app runs unchanged against this server.

## Run locally

Env comes from the process environment (there is no dotenv). Set the vars in your
shell, or just deploy to Railway and test there.

```bash
npm install
MAGILOOM_SECRET=dev npm run dev   # tsx watch, listens on :8787
curl localhost:8787/health
```

Connect a client to `ws://localhost:8787/ws` (no token in dev).

## Deploy to Railway

1. Point a Railway service at this repo (the `Dockerfile` is at the root — Node +
   Ruby, so Lich can run). No root-directory override needed.
2. Add a **Volume** mounted at `/data` so `settings.json`, maps, and push
   subscriptions survive redeploys.
3. Set Variables: `MAGILOOM_TOKEN`, `MAGILOOM_SECRET`, and the VAPID keys
   (`npm run vapid`). Railway sets `PORT` for you.
4. Railway gives you `wss://<app>.up.railway.app/ws?token=...` with TLS.

No Tailscale needed — the token + WSS is your security boundary. (Tailscale would
only matter if you self-hosted on a home box and wanted it private.)

## Push notifications (PWA)

Server-side rule evaluation is **wired** (`src/trigger-engine.ts` → `push.notify`),
so alerts fire even when the PWA is closed. Push subscriptions are per-user.

Client side (the remaining work, in the renderer):
1. `GET /push/vapid` → `applicationServerKey`.
2. Register a service worker, `pushManager.subscribe(...)`.
3. `POST /push/subscribe` with `{ userId, subscription }`.
4. In the service worker, show the notification on `push`.

iOS requires the PWA be added to the Home Screen for Web Push to work.

## Known limitations (address before going fully public)

- **Multi-Lich needs verification.** Each session now gets a unique frontend port
  from `port-allocator.ts`, and `lich-manager.ts` passes it via
  `--detachable-client=<port>` when it differs from 11024. The default single
  session (11024) is the desktop app's proven path; the custom-port + frostbite
  combo needs testing against your Lich build. Also: each Lich is a Ruby process
  (~50-100 MB), so **direct-connect is the scalable default** and Lich is a heavier
  opt-in — shard Lich users onto worker containers at large scale.
- **User identity is client-supplied.** `?user=<account>` currently trusts the
  client to name its bucket. Derive it from an authenticated per-user token before
  a public launch (otherwise one user could read another's bucket by guessing the
  name). The shared `MAGILOOM_TOKEN` only gates reaching the server at all.
- **One `BroadcastBus` poller per active user** (file-based). Fine for now; add
  refcounted teardown or an in-process bus if user count grows large.
