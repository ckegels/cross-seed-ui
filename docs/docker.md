# Running cross-seed-ui with Docker

This guide is for cross-seed running in Docker with the official image (`ghcr.io/cross-seed/cross-seed`).
If cross-seed runs directly in an LXC or VM with systemd (for example the Proxmox community script), use the
installer in the [README](../README.md#install) instead.

One image, `ghcr.io/ckegels/cross-seed-ui`, does both jobs:

| Container | Command | What it does |
|---|---|---|
| **agent** | `agent` | Sits next to the cross-seed container, shares its `/config` folder, edits `config.js`, reads the logs and database (read-only) and restarts cross-seed through the Docker API. |
| **web UI** | `hub` | The website you log in to, port 2470. Talks to one or more agents. |
| **socket proxy** | — | [linuxserver/socket-proxy](https://docs.linuxserver.io/images/docker-socket-proxy/) gives the agent only the Docker API calls it needs. The agent never sees the Docker socket. |

Images are built for `linux/amd64` and `linux/arm64`.

## Quick start

1. **Get the files** into a new folder, for example `~/cross-seed`:

   ```bash
   mkdir -p ~/cross-seed && cd ~/cross-seed
   curl -fsSLO https://raw.githubusercontent.com/ckegels/cross-seed-ui/main/docker-compose.yml
   curl -fsSL -o .env https://raw.githubusercontent.com/ckegels/cross-seed-ui/main/.env.example
   ```

2. **Set the shared secret** between the web UI and the agent:

   ```bash
   sed -i "s|^CSUI_AGENT_SECRET=.*|CSUI_AGENT_SECRET=$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=')|" .env
   ```

3. **Edit `docker-compose.yml`:** replace `/path/to/torrents` with your media/torrent folder. Use the **same
   path inside the container as your torrent client uses**, otherwise cross-seed can't link files.
   If you already run cross-seed, point `./cross-seed` at your existing config folder (the one with
   `config.js` and `cross-seed.db`) and remove the `cross-seed` service if you keep your own definition.
   In that case keep the container name `cross-seed`, or change `CSUI_CROSS_SEED_CONTAINER` and
   `CSUI_CROSS_SEED_URL`.

4. **Create the config folder** with the right owner (cross-seed runs as user 1000):

   ```bash
   mkdir -p cross-seed && sudo chown 1000:1000 cross-seed
   ```

5. **Start it:**

   ```bash
   docker compose up -d
   ```

6. **Open `http://<docker-host>:2470`.** Get the one-time setup token with

   ```bash
   docker compose logs cross-seed-ui | grep -A1 token
   # or: docker exec cross-seed-ui cross-seed-ui setup-token
   ```

   and create your admin account. Your cross-seed is already listed.

A brand-new cross-seed starts with the default config, which it refuses until you configure a torrent client and
indexers. That's expected: open the instance's **Connections** and **cross-seed settings** tabs, fill them in and
save; the UI restarts cross-seed and shows whether it accepted the config.

## Environment variables

**Agent (`agent`)**

| Variable | Default | Meaning |
|---|---|---|
| `CSUI_AGENT_SECRET` | required | Shared secret with the web UI, at least 32 characters. |
| `CSUI_CROSS_SEED_CONTAINER` | `cross-seed` | Name of the cross-seed container to manage. |
| `CSUI_CROSS_SEED_URL` | — | cross-seed's API inside the Docker network, e.g. `http://cross-seed:2468`. |
| `DOCKER_HOST` | `unix:///var/run/docker.sock` | The Docker API. Use the socket proxy: `tcp://socket-proxy:2375`. |
| `CSUI_CROSS_SEED_DIR` | `/config` | Where cross-seed's config folder is mounted. |
| `CSUI_DOCKER_EXEC` | `false` | Allow running cross-seed's maintenance commands inside its container (see below). |
| `CSUI_ALLOWED_IPS` | — | Comma-separated IPs/CIDRs allowed to call the agent. |
| `CSUI_PORT` | `2469` | Agent port. |

**Web UI (`hub`)**

| Variable | Default | Meaning |
|---|---|---|
| `CSUI_AGENT_URL`, `CSUI_AGENT_SECRET`, `CSUI_AGENT_NAME` | — | Register an agent automatically at startup. More agents: `CSUI_AGENT_2_URL`, `CSUI_AGENT_2_SECRET`, `CSUI_AGENT_2_NAME`, ... up to `_9_`. You can also add agents in the UI. |
| `CSUI_PORT` | `2470` | Web UI port. |
| `CSUI_TRUST_PROXY` | `false` | Set `true` behind your own reverse proxy (uses X-Forwarded-For/Proto). |
| `CSUI_SECURE_COOKIES` | `auto` | `true` to always mark the session cookie Secure. |

Both keep their data in the `/state` volume.

## What the agent may do through the socket proxy

The compose file enables only `CONTAINERS` (read), `ALLOW_START`, `ALLOW_STOP`, `ALLOW_RESTARTS` and
`ALLOW_LOGS`. The agent only ever touches the container named in `CSUI_CROSS_SEED_CONTAINER`.

**Maintenance commands** (clear caches, test notification) run `cross-seed <command>` inside the cross-seed
container. That needs `docker exec`, which the proxy only allows together with `POST=1`. `POST=1` also allows
creating containers, so it effectively gives the agent root on the Docker host. It is therefore **off by default**:
the buttons then tell you the command to run yourself, e.g. `docker exec cross-seed cross-seed clear-cache`.
To enable it anyway, add `POST=1` and `EXEC=1` to the socket proxy and `CSUI_DOCKER_EXEC=true` to the agent.

## More than one cross-seed

Run one agent per cross-seed container (each with its own `CSUI_CROSS_SEED_CONTAINER`, `/config` mount and
secret), and register them in the web UI with `CSUI_AGENT_2_URL` / `_SECRET` / `_NAME` or under
**UI settings → Instances**. Agents on other machines need their port published (`2469`) and preferably
`CSUI_ALLOWED_IPS` set to the web UI's address. Mixed setups work too: a Docker web UI can manage agents installed in
LXCs with the installer, and the other way around.

## Updating

```bash
docker compose pull && docker compose up -d
```

Pin a version instead of `latest` with `ghcr.io/ckegels/cross-seed-ui:0.3.0`.

## Commands

```bash
docker exec cross-seed-ui cross-seed-ui setup-token
docker exec cross-seed-ui cross-seed-ui reset-password <user>
docker exec cross-seed-ui cross-seed-ui disable-2fa <user>
docker exec cross-seed-ui cross-seed-ui version
```

## Troubleshooting

| Problem | What to do |
|---|---|
| Service shows `unknown` / "Docker API not reachable" | Check `DOCKER_HOST` and that the socket proxy runs: `docker compose logs socket-proxy`. |
| "client version ... is too old" | Update cross-seed-ui; it uses the engine's own API version since 0.3.0. |
| Agent can't write `config.js` | The agent and cross-seed must run as the same user (`user: "1000:1000"`) and the config folder must be owned by it. |
| Disk space / folder picker show nothing | Mount your media into the agent as well, at the same path as in cross-seed (read-only is enough). |
| Service output is empty | The socket proxy needs `ALLOW_LOGS=1`. |
