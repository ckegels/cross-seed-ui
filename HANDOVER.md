# HANDOVER — cross-seed-ui

> **Living document. Update it with every change.** Anyone (human or AI) picking up this project should be able to
> continue from this file alone. When you change something: update the relevant section, "Current status" and
> "Next steps", and add a dated line to the change log at the bottom (newest first).
> The repository is **public**: never put personal details (IPs, API keys, passwords, real config files) in here.

Last updated: 2026-10-26 — v0.3.3 released (LXC tarball + Docker image), running on the owner's two LXCs.

---

## 1. What this project is

A secure web UI to **manage, monitor and get statistics** for [cross-seed](https://www.cross-seed.org) **v6**
daemons. Reference setup: two cross-seed instances on Proxmox, each in its own LXC, installed with the Proxmox
community script. Docker setups (official cross-seed image) are supported too.

Goals (from the owner):

- Change **all** config.js settings from a UI (indexers, Sonarr/Radarr, torrent clients, matching, linking,
  scheduling, blocklist, notifications ...), per instance.
- Add and delete indexers, with **Prowlarr** sync.
- See **what cross-seed is doing** (live activity, logs) and **statistics**, as clean as possible.
- **Secure login.**
- **Easy install and update** on the LXCs (and a tested Docker version).
- Keep this handover file detailed and updated at every step.

### Reference environment

| Item | Value |
|---|---|
| cross-seed version | **6.13.9** (latest stable on npm; v7 is a prerelease with its own web UI and DB-stored config → not supported) |
| Install method | Proxmox community script (`community-scripts/ProxmoxVE` `cross-seed-install.sh`) |
| What that script does | Node.js 24, `npm install -g cross-seed@latest`, `cross-seed gen-config`, systemd unit `cross-seed.service` running `/usr/bin/cross-seed daemon` **as root**, `Restart=on-failure` |
| Config dir | `/root/.cross-seed/` (`config.js`, `cross-seed.db`, `logs/`, `torrent_cache/`, `cross-seeds/`) |
| Indexers | Prowlarr |
| Topology | One web UI (hub) for all instances, an **agent** next to each cross-seed |
| Repository | https://github.com/ckegels/cross-seed-ui — public, MIT, commits use the GitHub noreply address |
| Releases | GitHub releases (tarball + sha256) and `ghcr.io/ckegels/cross-seed-ui` (amd64 + arm64) |

---

## 2. Architecture

```
 Browser ──HTTP(S)──► HUB  (web UI, login, statistics, Prowlarr)              port 2470
                        │  every request signed (HMAC-SHA256, timestamp + nonce)
           ┌────────────┴─────────────┐
           ▼                          ▼
        AGENT (LXC A)              AGENT (LXC B or a Docker container)        port 2469
   edits config.js (backups, validation, verified restart, auto rollback)
   reads cross-seed.db read-only, tails the logs, parses events
   restarts cross-seed: systemctl (LXC) or Docker API via socket proxy (Docker)
   calls cross-seed's API (/api/job, /api/webhook) with its API key
```

- **Agent** (`packages/agent`): the only part that touches cross-seed's files. LXC: runs as root (cross-seed does).
  Docker: runs as uid 1000 next to the official cross-seed container, sharing `/config`.
- **Hub** (`packages/hub`): login, sessions, 2FA, users/roles, instance registry, Prowlarr integration, audit log,
  serves the web UI, proxies UI calls to agents through a whitelist.
- **Web** (`packages/web`): React single-page app served by the hub.
- **Shared** (`packages/shared`): option metadata, validator (port of cross-seed's zod schema), secret redaction,
  log parser, config.js renderer, types; `src/node/` = HTTP router and HMAC (server only).

### Key technical decisions (and why)

| Decision | Why |
|---|---|
| Node.js only, no runtime dependencies on the servers | The community-script LXC already has Node 24; small attack surface. |
| `node:sqlite` (built-in) | No native modules: release bundles are plain JS, run on Node ≥ 22.13. |
| esbuild bundles (`agent.mjs`, `hub.mjs`) | Release tarball needs no `npm install`. Install = download + extract + systemd. |
| cross-seed.db opened **read-only** | Never risk corrupting cross-seed's DB. Maintenance writes go through the official `cross-seed` CLI. |
| config.js evaluated in a child `node` process | Exactly how cross-seed loads it (supports `process.env` etc.). |
| Atomic write + backup + validation + verified restart + auto rollback | A bad config never leaves cross-seed down. |
| Secrets redacted before leaving the agent | Keys/passwords in URLs become a marker; restored on save, never for a different host. |
| HMAC between hub and agent | The shared secret never travels over the (often plain HTTP) LAN; replays rejected. |
| Docker: socket proxy, exec opt-in | Agent never sees the Docker socket; `docker exec` via the proxy needs POST=1 (= root on the host), so off by default. |

---

## 3. cross-seed v6 knowledge (verified against the v6.13.9 source)

### 3.1 Files
- `config.js` — CommonJS `module.exports = {...}`, loaded via `import()`. cross-seed maps file values onto its CLI
  options (`src/cmd.ts`), so **unknown keys are ignored**; missing keys get the CLI default (e.g. matchMode strict,
  linkType symlink, action save), which differs from the `gen-config` template defaults.
- `cross-seed.db` — SQLite (WAL), migrations 00–11 (knex).
- `logs/` — winston daily-rotate `info|verbose|error.<date>.log` (+ `*.current.log` symlinks), **kept 14 days**.
  Line: `YYYY-MM-DD HH:mm:ss.SSS <level>: [<label>] <message>`. `verbose` contains every level.
  **If cross-seed refuses its config at startup it exits before winston creates/flushes the files** → the reason is
  only on stdout (systemd journal / Docker container log).
- `torrent_cache/` — `<infohash>.cached.torrent`. The daily cleanup job **deletes decisions whose .torrent is missing**.
- `cross-seeds/` — default `outputDir` (failed injections, retried by the hourly inject job).

### 3.2 Daemon HTTP API (port 2468)
Auth: `X-Api-Key` or `?apikey=`. Key = `config.apiKey`, else `settings.apikey` in the DB. The DB key is generated
**lazily on the first authenticated request** (or by `cross-seed api-key`).

| Endpoint | Method | Notes |
|---|---|---|
| `/api/ping` | GET | no auth |
| `/api/status` | GET | auth, "OK" (any call triggers key generation) |
| `/api/job` | POST | `{name: rss|search|updateIndexerCaps|inject|cleanup, ignoreExcludeRecentSearch?, ignoreExcludeOlder?}` → 200 / 404 disabled / 409 running or not eligible (early runs only after half a cadence) |
| `/api/webhook` | POST | search one torrent: `{infoHash}` or `{path}` + override flags → 204 |
| `/api/announce` | POST | autobrr |

### 3.3 Jobs
rss (`rssCadence`, 10 min–2 h), search (`searchCadence` ≥ 1 day), updateIndexerCaps (1 day, if torznab), inject
(1 hour, if action inject; retries saved failed injections **and logs them again every hour**), cleanup (1 day).
`job_log.last_run`; after an early run cross-seed stores `last_run = now + cadence` → real last run = stored − cadence.

### 3.4 Database tables (useful columns)
- `searchee(id, name = title)`, `timestamp(searchee_id, indexer_id, first_searched, last_searched)`
- `decision(searchee_id, guid, info_hash, decision, first_seen, last_seen)` — MATCH, MATCH_SIZE_ONLY, MATCH_PARTIAL are
  matches; does **not** say whether something was injected.
- `indexer(id, name, url, apikey, trackers, active, status, retry_after, *_cap, *_caps)` — **`url` has no apikey**
  (separate column); `name` is only learned from the first search results (`<prowlarrindexer>` element); rows are
  never deleted (removed indexers stay with `active = 0`).
- `client_searchee`, `data`, `ensemble`, `job_log`, `settings(apikey)`, `rss`.
- Injection results come from log lines:
  `[label] Found <name> on <tracker> by <DECISION> from <source> (<searchee>) - injected|saved|exists|source is incomplete, saving...|failed to inject, saving...`
  Progress: `(i/n) Searching for ...`; boot: `Validating your configuration...` → `Your configuration is valid!` →
  `[server] Server is running on port`; refusal: `Your configuration is invalid`.

### 3.5 Validation rules (src/configSchema.ts, ported to `packages/shared/src/validate.ts`)
delay 30–3600 s; rssCadence 10 min–2 h; searchCadence ≥ 1 day; excludeRecentSearch ≥ 3 × searchCadence;
excludeOlder 2–5 × excludeRecentSearch when searching; fuzzySizeThreshold ≤ 0.1 with cadences; seasonFromEpisodes
rules; flexible/partial and seasonFromEpisodes need linkDirs when injecting; inject needs a non-readonly client;
torrentDir ⟂ useClientTorrents; dirs must not nest; blockList prefixes. Warnings (maxDataDepth > 3, qBittorrent ATM,
includeSingleEpisodes with RSS, ...) are informational — cross-seed logs the same ones and runs.

### 3.6 Maintenance CLI (safe while the daemon runs)
`clear-indexer-failures`, `clear-cache`, `clear-client-cache`, `test-notification`, `api-key`, `reset-api-key`.
Note: CLI runs also log "Validating your configuration..." to the same files.

### 3.7 Prowlarr
Torznab per indexer: `<prowlarr>/<id>/api?apikey=<key>`. `GET /api/v1/indexer`, `/api/v1/tag`, `/api/v1/system/status`.

### 3.8 Other projects looked at
dangerouslaser/cross-seed-ui (Next.js), spinninghypercube/CS-GUI, Gusdezup/Cross-Seed-Enhanced, autobrr/qui.

---

## 4. Repository layout

```
HANDOVER.md, README.md, CHANGELOG.md (= release notes), LICENSE (MIT)
package.json                npm workspaces root, version = release version
packages/shared             option metadata, validator, redaction, log parser, config renderer, types; src/node: router, HMAC
packages/agent              agent (settings, crossSeedConfig, crossSeedDb, daemon, docker, service, restart, logs, stats, routes)
packages/hub                hub (settings, db, crypto, auth, cli, agentClient, prowlarr, routes/*)
packages/web                React UI (pages/, pages/instance/, pages/settings/, ui/, charts/)
deploy/install.sh           LXC installer/updater;  deploy/cross-seed-ui = CLI;  deploy/systemd/*.service
Dockerfile                  image from source (local builds);  docker/Dockerfile.prebuilt = release image from dist/
docker/entrypoint.sh        hub|agent|healthcheck|setup-token|reset-password|disable-2fa|version
docker-compose.yml, .env.example, docs/docker.md
docs/screenshots/           README screenshots (fictional demo data only)
scripts/build.mjs           dist/ (+ --release tarball)
scripts/demo/               demo with real cross-seed daemons and fake services
scripts/test/               lxc-sim/Dockerfile (simulated community-script LXC), screenshots.mjs
scripts/dev.sh, agent-call.ts, mock-torznab.ts   older dev helpers
.github/workflows/          ci.yml (typecheck, tests, build, Docker smoke test), release.yml (tag v* → release + image)
```

---

## 5. Components in detail

### 5.1 Agent
- `settings.ts` — `/etc/cross-seed-ui/agent.json`, or environment variables (`settingsFromEnv`: CSUI_AGENT_SECRET,
  CSUI_CROSS_SEED_DIR/_URL/_CONTAINER, DOCKER_HOST, CSUI_DOCKER_EXEC, CSUI_ALLOWED_IPS, CSUI_PORT, CSUI_STATE_DIR).
- `crossSeedConfig.ts` — load via child node; save = base-hash check → restore secrets → validate → render →
  test-load tmp file → backup (`stateDir/backups`, 50) → atomic rename keeping mode/owner.
- `restart.ts` — restart + verify (log lines, service state, journal/container log for the refusal reason);
  `routes.ts` rolls back automatically when asked.
- `service.ts` — systemd / process (dev) / none; `docker.ts` — Docker Engine API (unix socket or socket proxy,
  **unversioned paths**, inspect/start/stop/restart/logs, opt-in exec, version from image label).
- `daemon.ts` — API key (config → DB → Docker: poke `/api/status` then read DB → CLI), jobs, webhook search,
  whitelisted CLI maintenance (Docker: via exec).
- `crossSeedDb.ts` — read-only queries; `sameIndexerUrl` compares origin+path.
- `logs.ts` — tails verbose.* with byte cursors stored in the same transaction as events; daily counters for
  high-volume lines; `ActivityTracker` (running jobs, search progress + ETA, last match, last error cleared on daemon
  (re)start and after 24 h, "starting" only while the API is unreachable).
- `stats.ts` — counts **distinct torrents per tracker and result** (hourly inject retries otherwise inflate "failed").
- `connTests.ts` — Torznab caps, Sonarr/Radarr, qBittorrent/Transmission/Deluge/rTorrent login, notification POST.
- `/v1/info` also lists manual `cross-seed search|rss|inject` runs found in `/proc`.

### 5.2 Hub
- Settings `/etc/cross-seed-ui/hub.json` or env (`hubSettingsFromEnv`); agents from env (`CSUI_AGENT[_N]_URL/_SECRET/_NAME`).
- Auth: setup token (state dir, printed in log/installer), scrypt, sessions (`csui_sid`, HttpOnly, SameSite=Strict,
  only hash stored, idle 7 d / max 30 d, reset on password change), TOTP, throttling (5/user, 20/IP per 15 min),
  CSRF header `x-csui: 1` + Origin check, roles admin/viewer, sudo (password re-check, 10 min).
- Proxy `/api/instances/:id/*` → agent `/v1/*` through a whitelist with a permission per endpoint; raw encoded path
  is forwarded (signed == sent). Router: exact routes always win over wildcard routes.
- Prowlarr: settings (key encrypted), indexer list with usage per instance, per-instance policy (pick / tag / all,
  privateOnly, auto-sync 6 h), sync touches only Prowlarr entries. A never-saved policy starts from what is in
  config.js; applying shows a dry run and **asks before removing** indexers.
- Audit log of every sign-in and change; GitHub release check.

### 5.3 Web
- React 19 + Vite 8 + Tailwind 4, own router and SVG charts (dataviz rules), light/dark.
- Navigation: sidebar **"UI settings"** (account, instances, Prowlarr, users, audit, updates) vs each instance's tabs
  (Dashboard, Activity, Indexers, Connections, **cross-seed settings**, History, Library, Maintenance) — every
  instance has its own config.js.
- Config editing: one draft per instance, live validation, review dialog, `RestartProgress` (live steps during
  restarts), result incl. rollback; the save dialog stays mounted after saving.
- Status banner on instance pages (starting / stopped / manual run detected / agent unreachable).
- Indexer health hides removed indexers behind a toggle, shows Prowlarr names for unnamed ones, tests the config
  entry (DB URLs have no apikey).

### 5.4 Install, update, release
- **LXC:** `deploy/install.sh` (roles agent|hub|both, `--allow-ip`, `--tarball`, `--version`, `--update`; token only for
  private forks). Downloads the release asset, verifies sha256, `/opt/cross-seed-ui/releases/<v>` + `current`,
  links `cross-seed-ui` into /usr/local/bin **and /usr/bin** (Proxmox console PATH), never overwrites configs,
  creates user `csui` for the hub, sandboxed systemd units with automatic fallback when the LXC refuses namespaces.
  Layout: `/etc/cross-seed-ui/`, `/var/lib/cross-seed-ui/{agent,hub}`. Update: `cross-seed-ui update`, `rollback`.
- **Docker:** see `docs/docker.md`. Image runs as uid 1000, state in `/state`; compose = cross-seed + socket proxy
  (`CONTAINERS ALLOW_START ALLOW_STOP ALLOW_RESTARTS ALLOW_LOGS`) + agent + hub.
- **Releasing:** bump `version` in package.json, add `## x.y.z` to CHANGELOG.md, run `npm run typecheck && npm test`
  (stop if anything fails), commit, `git tag -a vX.Y.Z -m ... && git push origin main vX.Y.Z`. The Release workflow
  publishes the tarball, then builds `dist/` once and pushes the multi-arch image from `docker/Dockerfile.prebuilt`
  (~1 min; building from source under arm64 emulation hung for 0.3.2).
- Commits: author must be `ckegels <30844154+ckegels@users.noreply.github.com>` (set in the repo's git config).

---

## 6. Testing

- `npm test` — 33 tests in 15 suites (validator, redaction, durations, log parser, config renderer, scrypt, TOTP RFC
  vector, SecretBox, HMAC replay/tamper, Prowlarr merge/select, throttle, router precedence, ConfigManager,
  ActivityTracker incl. starting/error behaviour, distinct counting). `npm run typecheck` for all packages.
- **Demo** (`scripts/demo/demo.sh start|stop|reset`, DEMO_DIR default /tmp/cross-seed-ui-demo, :2470, login
  `demo` / `show me around`, viewer `viewer` / `look but dont touch`): two real cross-seed 6.13.9 daemons against
  `mock-services.ts` (:9696: fake qBittorrent per instance that accepts injections, Prowlarr API, 6 fictional
  trackers with RSS uploads every 7 min and one rate-limited on even hours, Sonarr/Radarr, notification sink).
  `seed-history.ts` writes 13 days of logs + DB rows + torrent_cache files. In containers set
  `MOCK_HOST=0.0.0.0 MOCK_PUBLIC_URL=http://mock:9696`.
- **LXC e2e:** `scripts/test/lxc-sim/Dockerfile` (Debian 12 + systemd + Node 24 + cross-seed as root service), run
  privileged with cgroupns host; install from tarball or the public README command.
- **Docker e2e:** official cross-seed image + socket proxy + agent + hub (+ mock). Verified: setup, version, API key,
  restart+verify, jobs, container log, save+restart, invalid config → rollback, opt-in exec, documented quick start.
  This dev machine has no compose plugin; a standalone `docker-compose` binary was used.
- **Screenshots:** `scripts/test/screenshots.mjs` (puppeteer-core + Firefox; snap Firefox: use
  `/snap/firefox/current/usr/lib/firefox/firefox`).

---

## 7. Current status

- v0.3.3 released (tarball + Docker image). CI green.
- Installed on the owner's two LXCs (one "main" instance with many indexers using dataDirs, one smaller instance).
  Real-world feedback so far fixed in 0.2.1–0.3.3: Prowlarr picker replacing instead of adding, restart UX, health
  Test 401, unnamed indexers, removed indexers cluttering health, stale dashboard error, inflated "failed" counts.
- Open questions on the owner's side (not code bugs): two dataDir matches keep failing to inject (reason line not
  seen yet); suggestions given for the main instance: useClientTorrents if the original torrents are in the client,
  one-off bulk search ignoring excludeOlder, excludeOlder "450 days" / excludeRecentSearch "90 days",
  maxDataDepth 2–3, includeSingleEpisodes off.

### Checklist
- [x] Research cross-seed v6 internals; survey existing UIs
- [x] Shared core, agent, hub, web UI
- [x] LXC installer/updater/CLI, systemd units, releases
- [x] Public repo, MIT, README with screenshots, noreply commit history
- [x] Docker image + compose + docs, tested end to end
- [x] Installed on the real LXCs
- [ ] Items in "Next steps"

---

## 8. Next steps (offered to the owner, not built yet)

1. Indexer health: **"Add back"** button on removed Prowlarr indexers (re-adds via the Prowlarr policy).
2. Optional **compact config.js format** (one line per option, no comments) — the owner found the commented layout
   surprising; ask which should be the default.
3. Validator/agent check: warn when a linkDir is on a different filesystem than the data (`stat` device id), since
   hardlinks then fail. (On the owner's LXC this was *not* the cause — all paths had the same device id.)
4. Possibly: hub notifications on failures, one-click update from the UI, autobrr/announce statistics (daily
   `announces` counters already exist), per-instance comparison view.

---

## 9. Change log (newest first)

- 2026-10-26 — Handover rewritten: organised by topic, Docker, current status and next steps; no personal details.
- 2026-10-26 — 0.3.3: release image built from prebuilt dist (`docker/Dockerfile.prebuilt`); arm64 npm ci under QEMU
  hung > 40 min for 0.3.2 (cancelled, 0.3.2 has no image). Root `Dockerfile` still builds from source.
- 2026-10-26 — 0.3.2: distinct counting (hourly inject retries inflated "failed"), "since <date>" on tracker cards.
- 2026-10-25 — 0.3.1: removed indexers hidden behind a toggle; last error cleared on daemon start and after 24 h.
- 2026-10-25 — 0.3.0: Docker image + compose + docs, docker service manager, env settings, agent auto-registration;
  Docker 29 API version fix; "starting" only while the API is down.
- 2026-10-25 — 0.2.1 from the first real install: Prowlarr picker starts from config + confirms removals, restart
  progress UI, "starting" state, health Test 401 fix, Prowlarr names, manual-run detection, /usr/bin link.
- 2026-10-25 — 0.2.0 going public: README with screenshots, MIT, "UI settings" wording, test tools in scripts/test/,
  commit emails rewritten to the noreply address, old tags/releases/runs removed.
- 2026-10-25 — 0.1.2: demo kit; router fix (exact routes before wildcards) for the per-instance Prowlarr routes.
- 2026-10-25 — 0.1.1: installer umask leak fixed (found by installing from the real GitHub release).
- 2026-10-25 — 0.1.0: repo created, CI, first release.
- 2026-10-25 — Packaging: build/release script, installer, CLI, systemd units; e2e in simulated LXCs.
- 2026-10-25 — Web UI (overview, instance tabs, config editor, Prowlarr, settings, charts), mock Torznab, screenshots.
- 2026-10-25 — Hub (auth, sessions, TOTP, CSRF, sudo, instances, whitelisted proxy, Prowlarr, audit).
- 2026-10-25 — Agent tested against real cross-seed 6.13.9 (save/restart/rollback).
- 2026-10-25 — Shared core (validator port, redaction, log parser, config renderer, HMAC, router) + tests.
- 2026-10-25 — Research done; architecture decided; handover created.
