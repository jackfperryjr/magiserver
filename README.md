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
| (new) multi-Lich (headless) | `src/lich-manager.ts` `spawnHeadless` + `src/port-allocator.ts` | each session runs Lich `--login --headless=PORT` on its own detachable port |

Each connected client gets its own `Session` (its own game socket + Lich + script
engine + trigger engine), exactly like one Electron window.

### Data model (multi-user)

- **Per user** (`data/users/<id>/`): `settings.json` (accounts, passwords,
  characters), the multi-box `broadcast` bus, and logs. A user's phone + desktop
  share one in-memory store (no write race). Plain JSON, one small file per user —
  fine for hundreds of users; **no Postgres needed**.
- **Server-global**: the world **map** is one shared DB (community map, like the
  desktop's shared map DB), and Lich frontend **ports** come from a shared pool
  (`port-allocator.ts`). Each Lich runs **headless** (`--login <Char>
  --headless=<port>`): Lich self-authenticates from a per-user `entry.yaml`, owns
  the game connection, and exposes a private detachable port the session attaches
  to — so many characters run Lich concurrently, each on its own port (no more
  fighting over Lich's fixed 127.0.0.1:11024 frostbite listener). Set
  `MAGILOOM_LICH_FROSTBITE=1` to fall back to the old one-per-container path.
- **User identity**: by default the WS `?user=<device>` param picks the bucket and
  `?conn=<client>` keys the live session (a client-supplied hint). A session is kept
  alive while its DR connection is up (`MAGILOOM_SESSION_KEEPALIVE_MS`, default 2h)
  so a backgrounded/closed PWA keeps its character online, push keeps firing, and a
  reopen resumes the same session.
- **Accounts (`accounts.ts`)**: real per-user accounts (email + password), enabled
  with `MAGILOOM_ACCOUNTS_ENABLED=1` (the `/auth/*` routes + the gateway's account
  path). Two tiers:
  - **Signed in, any tier** → the DATA bucket is the account (`acct-<id>`), so
    settings + Lich profiles/custom scripts + avatars **sync across the user's
    devices** (upload a setup.yaml on a computer, use it on a phone). This is free.
  - **Paid tier** → the live SESSION is keyed to the account (cross-device **watch
    mode**) and the gateway keeps it alive across client absence (`keepAlive`), so a
    backgrounded/closed mobile app stays connected and push keeps firing. Free +
    anonymous get only the short grace, so their connection drops when they leave.

  Passwords are scrypt-hashed; tokens opaque + revocable; storage is `accounts.json`
  (no Postgres). No billing yet — `MAGILOOM_PRO_EMAILS="a@b.com,…"` grants the paid
  tier to listed emails for testing; `setTier(id,'paid')` is the hook a real billing
  webhook flips. The DESKTOP client never touches any of this (local + free).

### Server-side triggers → push

`trigger-engine.ts` evaluates each user's **notification rules** (`notifRules`)
against the game stream and calls `push.notify(payload, userId)` — so alerts fire
even when the PWA is closed (a closed page runs no JS, so the client can't).
Push subscriptions are keyed by `userId`, so only that user's devices are pinged.

It also pushes **conversation & mentions** (opt-in, `settings.push`): the raw
chunk still carries DR's `<preset id='speech|whisper|thought'>` tags, so the engine
classifies each line the same way the renderer does (quote heuristic filters exp
readouts, which reuse the `whisper` preset) and pushes whispers / room says /
thoughts / your-name mentions per the user's `push.{whisper,speech,thought,mention}`
toggles. Off by default. The service worker suppresses a push when a window is
focused so it never doubles the in-app toast; a small recent-text cache swallows
DR's duplicate chunks.
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
Launch flags: `--login <Char> --headless=<port> --home=<user home> --lib=<shared>/lib
--scripts=<user home>/scripts`. The `--home` also holds `data/entry.yaml` — the
per-user saved login (0600, plaintext, jailed to that home) Lich reads to
self-authenticate headlessly.

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
