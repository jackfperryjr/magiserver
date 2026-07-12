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
  token instead of trusting the client.

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
