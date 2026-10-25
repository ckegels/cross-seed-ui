# HANDOVER — cross-seed-ui

> **Living document. Update it with every change.** Anyone (human or AI) picking up this
> project should be able to continue from this file alone. When you finish a step, update
> "Current status", tick the checklist, and add a line to the "Change log" at the bottom.

Last updated: 2026-10-25 (step 3: agent implemented and tested against real cross-seed 6.13.9)

---

## 1. What this project is

A secure web UI to **manage, monitor and get statistics** for
[cross-seed](https://www.cross-seed.org) **v6** daemons. The owner runs **two cross-seed
instances on Proxmox, each in its own LXC**, installed with the Proxmox community script.

Goals (from the owner):

- Change **all** config.js settings from a UI (indexers, Sonarr/Radarr, torrent clients,
  matching, linking, scheduling, blocklist, notifications ...).
- Add and delete indexers (owner uses **Prowlarr**, so sync from Prowlarr).
- See **what cross-seed is doing** (live activity, logs) and **statistics**, as clean as possible.
- **Secure login**.
- **Easy install and update** on the LXCs.
- The repo is **private** for now.
- Keep this handover file detailed and updated at every step.

### Owner environment (confirmed 2026-10-25)

| Item | Value |
|---|---|
| cross-seed version | **6.13.9** (latest stable on npm; v7 is prerelease `next` tag) |
| Install method | Proxmox community script (`community-scripts/ProxmoxVE` `cross-seed-install.sh`) |
| What that script does | Node.js 24, `npm install -g cross-seed@latest`, `cross-seed gen-config`, systemd unit `cross-seed.service` running `/usr/bin/cross-seed daemon` **as root**, `Restart=on-failure` |
| Config dir | `/root/.cross-seed/` (`config.js`, `cross-seed.db`, `logs/`, `torrent_cache/`, `cross-seeds/`) |
| Indexers | Prowlarr |
| Topology chosen | **One dashboard (hub) for both instances**, small **agent** in each LXC |
| GitHub | user `ckegels`; planned private repo `ckegels/cross-seed-ui` (not created yet — ask before creating) |

---

## 2. Architecture

```
 Browser ──HTTPS/HTTP──►  HUB  (web UI + login + aggregation)        LXC A (or its own LXC)
                           │  signed requests (HMAC-SHA256)
            ┌──────────────┴───────────────┐
            ▼                              ▼
         AGENT (LXC A)                  AGENT (LXC B)
   reads/writes /root/.cross-seed     same
   reads cross-seed.db (read-only)
   tails logs, parses events
   systemctl restart cross-seed
   proxies cross-seed API (/api/job, /api/webhook) with the daemon apikey
```

- **Agent** (`packages/agent`): runs as root next to cross-seed. It is the only thing touching
  cross-seed files. HTTP API, authenticated with an HMAC signature (shared secret, never sent
  on the wire, timestamp + nonce = replay protection).
- **Hub** (`packages/hub`): user login, sessions, 2FA, instance registry, Prowlarr integration,
  audit log, serves the React UI, proxies UI calls to agents.
- **Web** (`packages/web`): React + Vite + Tailwind single-page app served by the hub.
- **Shared** (`packages/shared`): cross-seed option metadata + validation (port of the v6 zod
  schema), types, HMAC signing helpers, log-line parser.

### Key technical decisions (and why)

| Decision | Why |
|---|---|
| Node.js only | The LXC already has Node 24 from the community script, so agents need nothing new. |
| `node:sqlite` (built-in) instead of better-sqlite3 | No native modules: release bundles are plain JS and run anywhere Node ≥ 22.13. |
| Server code bundled with esbuild into single files | Release tarball needs **no `npm install`** on the LXC. Install = download + extract + systemd. |
| Read cross-seed.db **read-only** | Never risk corrupting cross-seed's DB. Maintenance writes go through the official `cross-seed` CLI commands. |
| Evaluate config.js in a child `node` process | Exactly how cross-seed loads it (supports `process.env` etc.); no `vm` tricks. |
| Write config.js atomically + backup + validate + optional auto-rollback | If the daemon fails to start after a change, restore the previous config automatically. |
| Secrets redacted before leaving the agent | API keys / passwords in URLs are replaced with a marker; the agent restores them on save. Revealing needs recent password re-entry. |
| HMAC between hub and agent | The shared secret is never sent over the LAN (HTTP is common in homelabs). |

---

## 3. cross-seed v6 knowledge (verified against v6.13.9 source)

Source was read from tag `v6.13.9` of `github.com/cross-seed/cross-seed` (`src/`).

### 3.1 Files

- `config.js` — CommonJS `module.exports = {...}`. Loaded via `import()`; any JS works.
  Validation is a **strict** zod schema (`src/configSchema.ts`): unknown keys are an error.
- `cross-seed.db` — SQLite (WAL), migrations 00–11 (knex).
- `logs/` — winston daily-rotate: `info.%DATE%.log`, `verbose.%DATE%.log` (level silly, i.e. everything),
  `error.%DATE%.log`, symlinks `*.current.log`, kept 14 days.
  Line format: `YYYY-MM-DD HH:mm:ss.SSS <level>: [<label>] <message>` (ANSI stripped, secrets redacted).
- `torrent_cache/` — snatched .torrent files (`<infohash>.cached.torrent`).
- `cross-seeds/` — default `outputDir` (saved / retry .torrent files).

### 3.2 Daemon HTTP API (default port 2468)

Auth: `X-Api-Key` header or `?apikey=`. Key = `config.apiKey` or else `settings.apikey` in the DB
(auto-generated, `cross-seed api-key` prints it).

| Endpoint | Method | Notes |
|---|---|---|
| `/api/ping` | GET | no auth, "OK" |
| `/api/status` | GET | auth, just "OK" in v6 |
| `/api/job` | POST | `{name: rss|search|updateIndexerCaps|inject|cleanup, ignoreExcludeRecentSearch?, ignoreExcludeOlder?}` → 200 / 404 (disabled) / 409 (running or not eligible) |
| `/api/webhook` | POST | search one torrent: `{infoHash}` or `{path}` + flags (`ignoreCrossSeeds`, `ignoreExcludeRecentSearch`, `ignoreExcludeOlder`, `ignoreBlockList`, `includeSingleEpisodes`, `includeNonVideos`) → 204 |
| `/api/announce` | POST | autobrr: `{name, guid, link, tracker, cookie?}` |

### 3.3 Jobs (src/jobs.ts)

| Job | Cadence | Exists when |
|---|---|---|
| rss | `rssCadence` (10 min – 2 h) | rssCadence set |
| search | `searchCadence` (≥ 1 day) | searchCadence set |
| updateIndexerCaps | 1 day | torznab non-empty |
| inject | 1 hour | action = inject |
| cleanup | 1 day | always |

Last run stored in `job_log(name, last_run)`. Next run = last_run + cadence.

### 3.4 Database tables (useful columns)

- `searchee(id, name, first_searched, last_searched)`
- `decision(id, searchee_id, guid, info_hash, decision, first_seen, last_seen, fuzzy_size_factor)`
  decisions: MATCH, MATCH_SIZE_ONLY, MATCH_PARTIAL (= matches), FUZZY_SIZE_MISMATCH, SIZE_MISMATCH,
  PARTIAL_SIZE_MISMATCH, NO_DOWNLOAD_LINK, DOWNLOAD_FAILED, MAGNET_LINK, RATE_LIMITED, SAME_INFO_HASH,
  INFO_HASH_ALREADY_EXISTS, FILE_TREE_MISMATCH, RELEASE_GROUP_MISMATCH, BLOCKED_RELEASE,
  PROPER_REPACK_MISMATCH, RESOLUTION_MISMATCH, SOURCE_MISMATCH
- `indexer(id, name, url, apikey, trackers(json), active, status(OK|RATE_LIMITED|UNKNOWN_ERROR|null), retry_after,
  search_cap, tv_search_cap, movie_search_cap, music_search_cap, audio_search_cap, book_search_cap,
  tv_id_caps, movie_id_caps, cat_caps, limits_caps)`
- `timestamp(searchee_id, indexer_id, first_searched, last_searched)` — per-indexer search history
- `job_log(name, last_run)`, `settings(id=0, apikey)`, `rss(indexer_id, last_seen_guid)`
- `client_searchee(client_host, info_hash, name, title, files, length, save_path, category, tags, trackers)`
- `data(path, title)`, `ensemble(client_host, path, info_hash, ensemble, element)`, `torrent(...)`

The decision table does **not** record whether something was injected. Injections come from logs:
`[<label>] Found <name> on <tracker> by <DECISION> from <source> (<searchee>) - injected|saved|exists|source is incomplete, saving...|failed to inject, saving...`
(labels: search, rss, announce, webhook, inject). Search progress: `(i/n) Searching for ...`.

### 3.5 Validation rules worth surfacing in the UI (src/configSchema.ts)

- `delay` 30–3600 s; `rssCadence` 10 min–2 h; `searchCadence` ≥ 1 day.
- `excludeRecentSearch` ≥ 3 × `searchCadence`; `excludeOlder` must be 2–5 × `excludeRecentSearch` when searchCadence is set.
- `fuzzySizeThreshold` (0,1], ≤ 0.1 when rss/search cadence set. `seasonFromEpisodes` (0,1] or null, ≥ 0.5 with cadences, < 1 needs `matchMode: partial`, needs linkDirs when action inject.
- `matchMode` flexible/partial need `linkDirs` when action inject.
- action inject needs ≥ 1 non-readonly torrent client.
- `torrentDir` and `useClientTorrents` are mutually exclusive; useClientTorrents needs a client.
- linkDirs/dataDirs/torrentDir/outputDir must not be nested in each other.
- `autoResumeMaxDownload` integer 0–52428800. `apiKey` ≥ 24 chars. `host` must be an IP.
- torrentClients prefix `qbittorrent:|rtorrent:|transmission:|deluge:` with optional `readonly:`; no duplicates.
- blockList prefixes: name, nameRegex, folder, folderRegex, category, tag, tracker, infoHash, sizeBelow, sizeAbove.

### 3.6 Maintenance CLI commands (safe to run while daemon runs; WAL)

`cross-seed clear-indexer-failures`, `clear-cache`, `clear-client-cache`, `test-notification`,
`api-key`, `reset-api-key`, `update-torrent-cache-trackers <old> <new>`, `diff <a> <b>`.

### 3.7 Prowlarr

Torznab URL per indexer: `http://<prowlarr>:9696/<indexerId>/api?apikey=<prowlarrApiKey>`.
Indexer list: `GET /api/v1/indexer` with header `X-Api-Key`.

### 3.8 Other projects looked at (for ideas)

- `dangerouslaser/cross-seed-ui` — Next.js, config editor (uses `vm` to parse config.js, rewrites as JSON), Prowlarr sync, backups.
- `spinninghypercube/CS-GUI` — Node, live logs + job triggers + config editor, LXC install script.
- `Gusdezup/Cross-Seed-Enhanced` — Python, French UI, targeted searches, reads DB read-only.
- `autobrr/qui` — qBittorrent UI with its own cross-seed engine (different approach).
- cross-seed **v7** (prerelease) ships its own WebUI and stores config in the DB → this project targets **v6**.

---

## 4. Repository layout

```
HANDOVER.md            ← this file
README.md              ← user-facing install/usage
package.json           ← npm workspaces root
packages/shared        ← option metadata, validator, HMAC, log parser
packages/agent         ← agent server (runs in each cross-seed LXC)
packages/hub           ← hub server (login, proxy, aggregation, serves web)
packages/web           ← React UI
scripts/               ← build + release packaging
deploy/                ← install.sh, systemd units
.github/workflows/     ← CI + release
```

---

## 5. Current status

**Step 5 — web UI (in progress).** Shared core, agent and hub are done and smoke-tested.

#### Hub (packages/hub) — done
- `settings.ts` hub.json (port **2470**, stateDir /var/lib/cross-seed-ui/hub, webDir, trustProxy, secureCookies, optional TLS).
- `db.ts` users / sessions / instances / settings / audit (node:sqlite).
- `crypto.ts` scrypt passwords, AES-256-GCM for agent secrets + Prowlarr key (key file `stateDir/secret.key`), TOTP (RFC 6238).
- `auth.ts` sessions (cookie `csui_sid`, HttpOnly, SameSite=Strict, Secure on HTTPS; only SHA-256 of the token stored;
  idle 7 d / max 30 d; invalidated on password change), login throttle (5 fails/15 min per user, 20 per IP),
  CSRF = header `x-csui: 1` required on every non-GET + Origin check, roles admin/viewer, "sudo" = password re-check
  within 10 min for secrets/raw config/users/instances.
- First run: setup token in `stateDir/setup-token`, printed in the hub log; deleted after the admin is created.
- `routes/instanceRoutes.ts` instance CRUD (agent tested before saving) + `/api/overview` + proxy
  `/api/instances/:id/*` → agent `/v1/*` with a **whitelist** (RULES) and permission level per endpoint; `?reveal=1` needs sudo;
  config saves get `author`; audit entries for every change.
- `routes/prowlarrRoutes.ts` Prowlarr settings, indexer list (with which instance uses each), per-instance sync policy
  (selected ids / Prowlarr tags / all, privateOnly, auto) and sync (only Prowlarr entries in torznab are touched), auto-sync every 6 h.
- `routes/systemRoutes.ts` version + GitHub latest release check, audit log.
- Security headers: strict CSP (no inline scripts), XFO DENY, nosniff, no-referrer, COOP, HSTS on HTTPS.

#### Agent (packages/agent) — done
- `settings.ts` agent.json (defaults match the community script: /root/.cross-seed, systemd `cross-seed`).
- `crossSeedConfig.ts` load config.js via child `node` (like cross-seed), save = hash check → restore secrets →
  validate → render → test-load tmp file → backup (stateDir/backups, max 50) → atomic rename (keeps file mode).
- `restart.ts` restart + verify: success = "Server is running" (or "Your configuration is valid!" then still indexing),
  failure = "Your configuration is invalid" / process exit. **cross-seed exits before winston flushes the file**, so the
  rejection reason is read from the journal (systemd) / process output. Auto-rollback restores the backup and restarts.
- `crossSeedDb.ts` read-only queries (stats, indexers, decisions, library). `daemon.ts` API key resolution
  (config.apiKey → settings table → `cross-seed api-key` CLI, because the key is generated lazily), /api/job, /api/webhook,
  whitelisted CLI maintenance commands. `connTests.ts` torznab caps, arr system/status, qBit/Transmission/Deluge/rTorrent
  login, notification POST. `logs.ts` tails verbose.*.log with byte cursors stored transactionally with the events,
  daily counters for high-volume lines, live activity tracker, SSE stream. `stats.ts` aggregates.
- Verified locally: info, config read, job trigger, activity, save+restart (1.6 s), bad config → rejected → auto rollback,
  unsigned request → 401.

#### Dev environment (local, not in git)
- cross-seed 6.13.9 installed in the scratchpad dir `csdev/` with a dataDirs-only config (action save, no clients).
- `dev/agent.json` (gitignored) runs the agent with `service.manager = "process"` so it spawns `cross-seed daemon` itself.
- `scripts/dev.sh start|stop|restart agent|hub` and `node --import tsx scripts/agent-call.ts dev/agent.json GET /v1/info`.

### Checklist

- [x] Research cross-seed v6 internals (config, API, DB, logs, jobs, validation)
- [x] Survey existing UIs
- [x] Confirm owner environment + topology
- [x] Monorepo scaffolding, TypeScript (build scripts still TODO)
- [x] Shared: option metadata + validator + HMAC + log parser (+ tests, 20 passing)
- [x] Agent: config read/write/backup/rollback, DB stats, logs + SSE, service control, job triggers, connection tests
- [x] Hub: setup/login/sessions/2FA/rate-limit, instances, proxy, Prowlarr, audit log
- [ ] Web: login, overview, instance dashboard, activity/logs, indexers, connections, settings, history, maintenance
- [ ] Install/update script + systemd units + release workflow
- [ ] End-to-end test against a real cross-seed 6.13.9 daemon (local)
- [ ] README

---

## 6. Next steps

See checklist. Work top to bottom.

---

## 7. Change log

- 2026-10-25 — Research done; architecture decided (hub + agents, Node-only, node:sqlite, esbuild bundles); handover created.
- 2026-10-25 — Shared core written + tests (validator port, redaction w/ same-host rule, log parser, config renderer, HMAC, router).
- 2026-10-25 — Agent written and tested against real cross-seed 6.13.9 (save/restart/rollback verified).
- 2026-10-25 — Hub written; smoke-tested setup token, login, CSRF, instance add, overview, proxy whitelist, headers.
