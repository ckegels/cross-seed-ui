# Changelog

## 0.1.2

- Fix: the Prowlarr panel on an instance's Indexers tab could not load or save its sync settings (the route was
  shadowed by the agent proxy route). Exact routes now always take priority over wildcard routes.
- Demo kit (`scripts/demo/demo.sh`) with real cross-seed daemons, fake services and two weeks of history.

## 0.1.1

- Installer: fix the hub failing to start when a GitHub token was given (a restrictive umask leaked into the
  install and made /opt/cross-seed-ui unreadable for the hub user). Release files are now always owned by root
  and world-readable; secrets stay 0600/0640.

## 0.1.0

First release.

- Hub (web UI + login) and agents (one per cross-seed LXC), signed HMAC requests between them.
- Edit every cross-seed v6 option, with the same validation rules as cross-seed, backups of every version,
  verified restart and automatic rollback when cross-seed refuses a config.
- Indexers: health from cross-seed's database, Prowlarr sync (pick / by tag / all, optional auto-sync), Torznab URLs.
- Connections: torrent clients, Sonarr, Radarr, notification webhooks, each with a connection test.
- Live activity (log stream, current search progress, jobs), statistics (cross-seeds per day, searches, decisions,
  trackers, library, disks), history of every match and decision, library browser with "search now".
- Maintenance: start/stop/restart, official cross-seed CLI maintenance commands, journal.
- Security: setup token, scrypt passwords, optional TOTP 2FA, throttled logins, SameSite=Strict sessions, CSRF header,
  strict CSP, password re-confirmation for sensitive actions, viewer role, audit log, secrets hidden from the browser.
- Installer for Proxmox LXCs (private GitHub releases), `cross-seed-ui update` / `rollback`.
