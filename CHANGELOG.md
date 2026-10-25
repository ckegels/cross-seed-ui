# Changelog

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
