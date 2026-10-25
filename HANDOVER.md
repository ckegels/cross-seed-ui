# HANDOVER — cross-seed-ui

> **Living document. Update it with every change.** Anyone (human or AI) picking up this
> project should be able to continue from this file alone. When you finish a step, update
> "Current status", tick the checklist, and add a line to the "Change log" at the bottom.

Last updated: 2026-10-25 (step 8: repo created, v0.1.1 released, ready to install on the real LXCs)

---

## 1. What this project is

A secure web UI to **manage, monitor and get statistics** for
[cross-seed](https://www.cross-seed.org) **v6** daemons. The reference setup is **two cross-seed
instances on Proxmox, each in its own LXC**, installed with the Proxmox community script.

Goals:

- Change **all** config.js settings from a UI (indexers, Sonarr/Radarr, torrent clients,
  matching, linking, scheduling, blocklist, notifications ...).
- Add and delete indexers (with **Prowlarr** sync).
- See **what cross-seed is doing** (live activity, logs) and **statistics**, as clean as possible.
- **Secure login**.
- **Easy install and update** on the LXCs.
- The repo is **private** for now.
- Keep this handover file detailed and updated at every step.

### Reference environment

| Item | Value |
|---|---|
| cross-seed version | **6.13.9** (latest stable on npm; v7 is prerelease `next` tag) |
| Install method | Proxmox community script (`community-scripts/ProxmoxVE` `cross-seed-install.sh`) |
| What that script does | Node.js 24, `npm install -g cross-seed@latest`, `cross-seed gen-config`, systemd unit `cross-seed.service` running `/usr/bin/cross-seed daemon` **as root**, `Restart=on-failure` |
| Config dir | `/root/.cross-seed/` (`config.js`, `cross-seed.db`, `logs/`, `torrent_cache/`, `cross-seeds/`) |
| Indexers | Prowlarr |
| Topology chosen | **One dashboard (hub) for both instances**, small **agent** in each LXC |
| GitHub | https://github.com/ckegels/cross-seed-ui (public) |

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

**Step 10 — public; install on real LXCs.** Repo https://github.com/ckegels/cross-seed-ui (public since 2026-10-25),
CI green on Node 22 + 24, releases published by the Release workflow.
The README install command was tested for real against the private repo in a fresh community-script-like container.

**Releasing:** bump `version` in package.json, add a `## x.y.z` section to CHANGELOG.md (used as release notes),
commit, `git tag -a vX.Y.Z -m ... && git push origin main vX.Y.Z`. Wait for the Release workflow.

**Bug found by testing the real GitHub install (fixed in 0.1.1):** `umask 077` set while writing the token leaked into
the rest of install.sh → /opt/cross-seed-ui was 0700 → hub (user csui) got MODULE_NOT_FOUND. Now umask 022 globally,
subshell umask for the token, `tar --no-same-owner`, release chowned root and chmod u=rwX,go=rX.

#### Tests
- `npm test` (node:test via tsx): shared (validator, redaction, durations, log parser, config renderer),
  hub (scrypt, TOTP RFC 6238 vector, SecretBox tamper, HMAC replay/tamper, Prowlarr merge/select, throttle, cookies),
  agent (ConfigManager write/backup/conflict/restore/refuse broken file, activity tracker), router precedence. 30 tests in 14 suites.
- `npm run typecheck` for all 4 packages.

#### Security review notes (done 2026-10-25)
- Secret restore never hands a secret to a different host (prevents exfiltration by editing only the hostname).
- Proxy forwards the raw encoded path (signed path == sent path); whitelist regexes anchored; backup ids can't start with a dot.
- Agent `/v1/fs/dirs` + `/v1/test` (SSRF-ish) are admin-only via the hub whitelist. Raw config.js editing needs sudo
  (it is code executed as root). Viewer role only gets GETs without `reveal`.
- No `dangerouslySetInnerHTML`; strict CSP; all state-changing requests need `x-csui: 1`.

#### Docker (0.3.0)
- `Dockerfile` (node:22-alpine, multi-stage, runs as `node` = uid 1000, state in `/state`), `docker/entrypoint.sh`
  (`hub|agent|healthcheck|setup-token|reset-password|disable-2fa|version`), `docker-compose.yml`, `.env.example`,
  `docs/docker.md`. Release workflow pushes `ghcr.io/ckegels/cross-seed-ui:{latest,<version>}` for amd64+arm64.
- Agent `service.manager = "docker"` (`packages/agent/src/docker.ts`): Docker Engine API over unix socket or
  `tcp://socket-proxy:2375`, **unversioned paths** (Docker 29 rejects API < 1.44), container inspect/start/stop/restart,
  logs (multiplexed stream demux, timestamps for ordering), exec (opt-in `CSUI_DOCKER_EXEC=true`; through
  linuxserver/socket-proxy it needs POST=1 + EXEC=1 = root-equivalent, hence off by default).
- Without exec: version from the image label `org.opencontainers.image.version` ("version-6.13.9"); API key read
  from the DB after poking `/api/status` (cross-seed generates the key on the first authenticated request);
  maintenance buttons answer with the `docker exec ...` command to run by hand.
- Settings from env: agent `settingsFromEnv` (CSUI_AGENT_SECRET, CSUI_CROSS_SEED_CONTAINER, CSUI_CROSS_SEED_URL,
  DOCKER_HOST, ...), hub `hubSettingsFromEnv` + `agentsFromEnv` (CSUI_AGENT[_N]_URL/_SECRET/_NAME, registered at start).
- Socket proxy needs `CONTAINERS=1 ALLOW_START=1 ALLOW_STOP=1 ALLOW_RESTARTS=1 ALLOW_LOGS=1`.
- Tested 2026-10-25 with the official cross-seed 6.13.9 image + linuxserver/socket-proxy + fake services
  (mock needs `MOCK_HOST=0.0.0.0 MOCK_PUBLIC_URL=http://mock:9696` in containers): setup, overview, version, API key,
  restart+verify, job trigger, container log, save+restart, invalid config → auto rollback (31 s), opt-in exec.
  This machine has no compose plugin: the standalone `docker-compose` binary was used.

#### Demo environment (scripts/demo/) — added 2026-10-25
`scripts/demo/demo.sh start|stop|reset` (DEMO_DIR default /tmp/cross-seed-ui-demo, hub on :2470,
login `demo` / `show me around`, viewer `viewer` / `look but dont touch`). Two **real** cross-seed 6.13.9 daemons
(installed into DEMO_DIR/cs) against `mock-services.ts` on :9696 = fake qBittorrent per instance (`/qbit/a|b`, accepts
real injections, in-memory), Prowlarr API + 6 fictional private trackers (Torznab with `<prowlarrindexer>` names,
"fresh uploads" every 7 min for RSS, Lumen returns 429 on even hours), Sonarr/Radarr (`/api` ping must return
`{current}`), notification sink. `catalog.ts` = deterministic library (87 + 46 torrents, sparse files via `make-files.ts`),
`seed-history.ts` = 13 days of logs in cross-seed's format + DB rows (indexers, searchees, timestamps, decisions, job_log),
`write-config.ts` = realistic config.js. Used for previews and for the README screenshots (`docs/screenshots/`).

**Bug found with the demo (fixed):** `/api/instances/:id/prowlarr` was shadowed by the proxy wildcard
`/api/instances/:id/*` (registered first) → per-instance Prowlarr panel could never load/save. Router now always
prefers exact routes over wildcard routes (test added).

#### Known gaps / ideas for later
- cross-seed only creates log files once it validated its config; before that the UI points to the journal.
- Tracker names come from cross-seed (Prowlarr indexer names); custom Torznab without names shows "UnknownTracker".
- Statistics of injections only exist from when the agent first parsed the logs (it backfills the 14 days cross-seed keeps).
- Possible next features: notifications from the hub (e.g. Discord) on failures, per-instance comparisons, hub-side
  history snapshots of indexer health, one-click update from the UI (agent could run `cross-seed-ui update`),
  autobrr/announce statistics page (daily `announces` counters are already collected by the agent).

#### Packaging & install — done
- `scripts/build.mjs` → `dist/` (agent.mjs + hub.mjs bundled by esbuild, web/, bin/cross-seed-ui, deploy/, VERSION);
  `--release` → `release/cross-seed-ui-<v>.tar.gz` + `.sha256` (~210 KB). Version from `CSUI_VERSION` or package.json.
- `deploy/install.sh` (roles agent|hub|both, `--update`, `--tarball`, `--version`, `--token`, `--allow-ip`, ...):
  checks Node ≥ 22.13 (offers NodeSource 22), downloads the release asset from the **private** repo with the token
  (stored in `/etc/cross-seed-ui/github-token`, 0640 root:csui), verifies sha256, installs to
  `/opt/cross-seed-ui/releases/<v>` + `current` symlink (keeps 3), never overwrites existing configs, creates system user
  `csui` for the hub, installs sandboxed systemd units and **auto-disables sandboxing via a drop-in if the LXC
  refuses namespaces**, role `both` registers the local agent (agent then listens on 127.0.0.1 only), prints the setup token.
- `deploy/cross-seed-ui` CLI: status, update [v], rollback, logs, restart, agent-info, setup-token, reset-password,
  disable-2fa, add-instance, version, uninstall. Hub CLI subcommands live in `packages/hub/src/cli.ts`.
- Layout on the LXC: `/opt/cross-seed-ui`, `/etc/cross-seed-ui/{agent,hub}.json, install.conf, github-token`,
  `/var/lib/cross-seed-ui/{agent,hub}` (agent: agent.db + backups/, hub: hub.db, secret.key, setup-token).

#### End-to-end test (docker, `scripts/test/lxc-sim/Dockerfile`)
Debian 12 + systemd + Node 24 + `npm i -g cross-seed@6.13.9` + root `cross-seed.service` (= community script).
Verified: install role both, setup token, hub overview, validator errors == cross-seed's own errors for the default
gen-config, save+restart via systemd (1.1 s, verified), audit entry, second container role agent with `--allow-ip`,
added to hub, wrong secret → 401, foreign IP → 403, update 0.1.0 → 0.1.1 with tarball, rollback.

#### Web (packages/web) — done (first version)
- React 19 + Vite 8 + Tailwind 4, no router/chart libs (own `router.tsx`, own SVG charts in `charts/index.tsx`
  following the dataviz rules: ≤24px columns, 4px rounded data-ends, 2px gaps, hairline grid, legend ≥2 series,
  hover tooltips, fixed categorical order; instance color = `SERIES[(id-1)%8]`, status colors only for status).
- Theme tokens in `styles.css` (light + dark, toggle stored in localStorage `csui.theme`).
- `api.ts` adds `x-csui: 1`; `sudo_required` opens `ui/SudoDialog.tsx` and retries.
- Pages: Login/Setup, Overview (KPI tiles, instance cards with live activity + quick RSS/search, stacked daily charts,
  top trackers, recent matches), Instance (tabs: Dashboard, Activity [live SSE log + log files + timeline], Indexers
  [health table, Prowlarr policy/preview/apply, raw torznab list], Connections [clients/arr/notifications/daemon with Test],
  Settings [all options from metadata, blocklist editor, preview file, raw editor], History [cross-seeds + all decisions],
  Library [client torrents, search-now], Maintenance [service, CLI commands, backups, journal]),
  Indexers (Prowlarr overview), Settings (account/2FA/sessions, instances, Prowlarr, users, audit, about/updates).
- Config editing: `pages/instance/configDraft.tsx` (one draft per instance, client-side validation with the shared
  validator, SaveBar → review modal → PUT with restart + auto rollback → restart verdict).

#### Dev data
- `scripts/mock-torznab.ts <dataDir> [port]` = fake Torznab with 3 trackers; real cross-seed produces real matches.
- Sparse fake movies in `csdev/data/movies` (truncate). dev agent runs cross-seed with `DEV=1` (allows delay < 30).
- Screenshots: `scripts/test/screenshots.mjs` (puppeteer-core + Firefox, not a dependency; snap firefox: use
  `/snap/firefox/current/usr/lib/firefox/firefox` directly, the /usr/bin wrapper can't use /tmp profiles).

#### Gotchas learned
- cross-seed's `indexer.url` has **no apikey** (separate column) → compare origin+path (`sameIndexerUrl` in shared).
- After an early job run cross-seed stores `job_log.last_run = now + cadence` → real last run = stored − cadence.
- Running a job early is refused (409) until half a cadence passed; the UI shows cross-seed's message.

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
- Simplest: `scripts/demo/demo.sh start` (everything below is the older manual setup).
- `dev/agent.json` (gitignored) runs the agent with `service.manager = "process"` so it spawns `cross-seed daemon` itself.
- `scripts/dev.sh start|stop|restart agent|hub` and `node --import tsx scripts/agent-call.ts dev/agent.json GET /v1/info`.

### Checklist

- [x] Research cross-seed v6 internals (config, API, DB, logs, jobs, validation)
- [x] Survey existing UIs
- [x] Confirm reference environment + topology
- [x] Monorepo scaffolding, TypeScript (build scripts still TODO)
- [x] Shared: option metadata + validator + HMAC + log parser (+ tests, 20 passing)
- [x] Agent: config read/write/backup/rollback, DB stats, logs + SSE, service control, job triggers, connection tests
- [x] Hub: setup/login/sessions/2FA/rate-limit, instances, proxy, Prowlarr, audit log
- [x] Web: login, overview, instance dashboard, activity/logs, indexers, connections, settings, history, maintenance
- [x] Install/update script + systemd units (release workflow: written, not yet run on GitHub)
- [x] End-to-end test against a real cross-seed 6.13.9 daemon (local + systemd containers)
- [x] README, CHANGELOG, CI + release workflows
- [x] Create private GitHub repo, push, tag v0.1.0 / v0.1.1
- [ ] Install on the real LXCs

---

## 6. Next steps

See checklist. Work top to bottom.

---

## 7. Change log

- 2026-10-25 — Research done; architecture decided (hub + agents, Node-only, node:sqlite, esbuild bundles); handover created.
- 2026-10-25 — Shared core written + tests (validator port, redaction w/ same-host rule, log parser, config renderer, HMAC, router).
- 2026-10-25 — Agent written and tested against real cross-seed 6.13.9 (save/restart/rollback verified).
- 2026-10-25 — Hub written; smoke-tested setup token, login, CSRF, instance add, overview, proxy whitelist, headers.
- 2026-10-25 — Web UI written; mock Torznab + screenshots; fixed indexer URL matching, delayed last_run, searching state.
- 2026-10-25 — Build/release script, installer, CLI, systemd units; e2e tested install/agent/update/rollback in containers.
- 2026-10-25 — Mobile overflow fix, status hints, raw-path proxy signing, more tests (40), README/CHANGELOG/CI/release workflow.
- 2026-10-25 — Private GitHub repo created, CI green, v0.1.0 released; real GitHub install test found the umask bug → v0.1.1.
- 2026-10-25 — Demo kit (scripts/demo); found + fixed router wildcard shadowing the Prowlarr policy routes (v0.1.2).
- 2026-10-25 — 0.3.1: hide removed indexers (toggle), lastError cleared on server-start and after 24 h.
- 2026-10-25 — 0.3.0: Docker image + compose + docs, docker service manager, env settings, agent auto-registration.
- 2026-10-25 — 0.2.1 from the first real install: Prowlarr picker replaced instead of adding (now starts from
  config + confirms removals), restart progress UI, "starting" state, health-table Test 401 (DB url has no apikey),
  Prowlarr names for unnamed indexers, manual `cross-seed search` detection, /usr/bin link. Docker support in progress.
- 2026-10-25 — Going public: public README with screenshots, "UI settings" vs per-instance wording, test tools in scripts/test/,
  commit emails rewritten to the GitHub noreply address, old tags/releases/runs removed, fresh release.
