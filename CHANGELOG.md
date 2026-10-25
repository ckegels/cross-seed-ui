# Changelog

## 0.2.1

Fixes from the first real installs:

- **Prowlarr picker:** the indexer list now starts from the indexers already in the instance's config.js, so ticking
  one adds it instead of replacing all others. Applying a selection that removes indexers now asks first and names them.
- **Restarts are visible:** saving, Prowlarr apply, restore and Maintenance → Restart show live progress (restarting,
  checking the config, loading torrents, back online) instead of a bare spinner. The save dialog no longer disappears
  after a successful save. Instances show "Starting…" instead of "stopped" while cross-seed boots, and every instance
  page shows a banner while it is starting or stopped.
- **Indexers:** the Test button in the health table used cross-seed's stored URL, which has no API key, and got 401;
  it now tests the config entry. New indexers show their Prowlarr name until cross-seed learns its own.
- **Stopped daemon:** when cross-seed's service is stopped but a `cross-seed search` started by hand is running,
  the banner says so.
- **Installer:** `cross-seed-ui` is also linked into /usr/bin, because the Proxmox console's PATH has no /usr/local/bin.
- Warning for duplicate Torznab URLs.

## 0.2.0

First public release.

- MIT license, public README with screenshots, install straight from GitHub without a token.
- Clearer navigation: the sidebar's "UI settings" (account, users, instances, Prowlarr) vs each instance's own
  Connections / Indexers / cross-seed settings tabs, with direct links between them.
- Demo seeds cross-seed's torrent cache, so its cleanup job keeps the demo history.
- Test tools in `scripts/test/` (simulated community-script LXC, screenshot script).

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
