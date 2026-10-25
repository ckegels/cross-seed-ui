# cross-seed-ui

A secure web UI to **configure, monitor and get statistics** for one or more
[cross-seed](https://www.cross-seed.org) **v6** daemons, built for Proxmox LXCs installed with the
community script.

- Edit **every** `config.js` option in forms (with the same validation rules as cross-seed), or the raw file.
- Every save is **backed up**, cross-seed is **restarted and verified**, and if it refuses the new config the
  previous one is **restored automatically**.
- **Indexers:** health (rate limits, failures, capabilities, usage), **Prowlarr sync** (pick indexers, by Prowlarr tag,
  or all, optional auto-sync), raw Torznab URLs, connection tests.
- **Connections:** torrent clients, Sonarr, Radarr, notification webhooks, each with a **Test** button that runs from
  the cross-seed LXC itself.
- **Live activity:** what cross-seed is doing right now (search progress with ETA, running jobs), live log stream,
  log files, timeline.
- **Statistics:** cross-seeds added per day, searches, matches, decisions, trackers, library, disk space, across all
  instances.
- **History** of every match and every decision, **library** browser with "search now", **maintenance**
  (start/stop/restart, cross-seed CLI maintenance commands, journal).
- **Security:** login with optional 2FA, password re-confirmation for sensitive actions, admin/viewer roles, audit
  log, secrets never sent to the browser unless revealed.

> Targets cross-seed **v6** (tested with 6.13.9). cross-seed v7 ships its own web UI and stores its config in its
> database, so it is not supported.

## How it works

```
Browser ──► HUB (web UI, login, statistics)          one LXC, port 2470
              │  every request signed (HMAC-SHA256)
     ┌────────┴─────────┐
     ▼                  ▼
  AGENT (LXC A)      AGENT (LXC B)                    port 2469, next to each cross-seed
  config.js, logs, cross-seed.db (read-only), systemctl restart cross-seed
```

- The **agent** runs as root next to cross-seed (the community script runs cross-seed as root in
  `/root/.cross-seed`). It is the only part that touches cross-seed's files.
- The **hub** is the web UI. It runs as an unprivileged user (`csui`) in a sandboxed systemd unit.
- No Docker and no build step on the LXC: a release is ~200 KB of plain JavaScript that runs on the Node.js the
  community script already installed (Node ≥ 22.13 required).

## Install (your setup: two cross-seed LXCs)

The repository is private, so the installer needs a GitHub token:
create a **fine-grained personal access token** (GitHub → Settings → Developer settings → Fine-grained tokens) with
access to only this repository and the permission **Contents: Read-only**. It is stored in
`/etc/cross-seed-ui/github-token` (readable by root and the hub user) and reused for updates.

**LXC A** (cross-seed + the web UI), in the LXC console as root:

```bash
export GITHUB_TOKEN=github_pat_xxxxxxxx
curl -fsSL -H "Authorization: Bearer $GITHUB_TOKEN" -H "Accept: application/vnd.github.raw" \
  https://api.github.com/repos/ckegels/cross-seed-ui/contents/deploy/install.sh | bash -s -- --role both
```

It prints the web address (`http://<lxc-a-ip>:2470`) and a **setup token**. Open the address and create your admin
account with the token. The cross-seed of LXC A is already added.

**LXC B** (only cross-seed), as root. Replace `<lxc-a-ip>` so only the hub may talk to this agent:

```bash
export GITHUB_TOKEN=github_pat_xxxxxxxx
curl -fsSL -H "Authorization: Bearer $GITHUB_TOKEN" -H "Accept: application/vnd.github.raw" \
  https://api.github.com/repos/ckegels/cross-seed-ui/contents/deploy/install.sh | bash -s -- --role agent --allow-ip <lxc-a-ip>
```

It prints a URL and a secret. In the web UI go to **Settings → Instances → Add instance** and paste them.

Then: **Settings → Prowlarr** (URL + API key), and per instance **Indexers** to pick the indexers.

### Installer options

| Option | Meaning |
|---|---|
| `--role agent\|hub\|both` | what to install |
| `--allow-ip IP[/CIDR]` | agent only accepts requests from these addresses (repeatable) |
| `--agent-port` / `--hub-port` | default 2469 / 2470 |
| `--cross-seed-dir DIR` | default `/root/.cross-seed` |
| `--cross-seed-service NAME` | default `cross-seed` |
| `--version vX.Y.Z` | install a specific release |
| `--tarball FILE` | install from a downloaded release file (no GitHub access needed) |

## Update, rollback, management

```bash
cross-seed-ui update          # latest release (run in every LXC: hub and agents)
cross-seed-ui update 0.2.0    # a specific version
cross-seed-ui rollback        # back to the previous version
cross-seed-ui status
cross-seed-ui logs            # follow the logs (agent/hub)
cross-seed-ui agent-info      # URL + secret of this agent
cross-seed-ui reset-password admin
cross-seed-ui disable-2fa admin
cross-seed-ui uninstall       # cross-seed itself is never touched
```

Settings live in `/etc/cross-seed-ui/` and data in `/var/lib/cross-seed-ui/`; updates never overwrite them.
The web UI shows when a new version is available (Settings → About & updates).

## Security notes

- First start: an admin can only be created with the one-time setup token.
- Passwords: scrypt. Optional TOTP 2FA. 5 failed logins per user (20 per IP) lock for 15 minutes.
- Sessions: random token in an HttpOnly, SameSite=Strict cookie; only its hash is stored. Signed out after 7 days of
  inactivity or 30 days. Changing the password signs out every session.
- Revealing secrets, editing raw `config.js`, managing users or instances requires typing your password again.
- Strict Content-Security-Policy, anti-CSRF header, clickjacking protection, audit log of every change.
- Hub ↔ agent: HMAC-SHA256 signatures with timestamp + nonce (no replay); the shared secret never travels over the
  network. Optionally restrict agents to the hub's IP (`--allow-ip`).
- API keys and passwords inside URLs are replaced by a placeholder before they leave the agent and restored on save.
- The UI talks plain HTTP on your LAN. For access from outside your LAN put it behind a reverse proxy with HTTPS
  (Nginx Proxy Manager, Caddy, Traefik) and set `"trustProxy": true` in `/etc/cross-seed-ui/hub.json`. Don't expose it
  directly to the internet.
- The agent runs as root because cross-seed does. Anyone who is admin in the UI can change `config.js`, which
  cross-seed executes as root: only give admin to people you'd give root.

## Troubleshooting

| Problem | Fix |
|---|---|
| Instance shows "Agent offline" | `cross-seed-ui status` in that LXC; check the URL/port and `--allow-ip` (see `allowedIps` in `/etc/cross-seed-ui/agent.json`). |
| "Unauthorized: timestamp outside allowed window" | The clocks of hub and agent differ by more than 60 s. Fix time sync on the Proxmox host. |
| "cross-seed is not running" | Open the instance → Settings: errors cross-seed would report are shown at each option. Maintenance → Service output shows the journal. |
| Locked out | `cross-seed-ui reset-password <user>` (and `disable-2fa`) in the hub LXC. |
| Service fails with status 226/NAMESPACE | The installer disables systemd sandboxing automatically for LXCs that don't support it; rerun `cross-seed-ui update`. |

## Development

```bash
npm install
npm test && npm run typecheck
npm run build                  # dist/
CSUI_VERSION=0.2.0 npm run release   # release/cross-seed-ui-0.2.0.tar.gz (+ .sha256)
```

Local dev setup (agent + hub + mock indexers against a real cross-seed): see `HANDOVER.md`.
Publishing a release: push a tag `vX.Y.Z` (see `.github/workflows/release.yml` and `CHANGELOG.md`).
