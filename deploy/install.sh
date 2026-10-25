#!/usr/bin/env bash
# cross-seed-ui installer / updater for Debian/Ubuntu LXCs (Proxmox).
#
# Install (private repo => fine-grained GitHub token with read-only "Contents"):
#   export GITHUB_TOKEN=github_pat_xxx
#   curl -fsSL -H "Authorization: Bearer $GITHUB_TOKEN" -H "Accept: application/vnd.github.raw" \
#     https://api.github.com/repos/ckegels/cross-seed-ui/contents/deploy/install.sh | bash -s -- --role both
#
# Roles:
#   agent  in every LXC that runs cross-seed (edits config.js, reads logs/db, restarts the service)
#   hub    the web UI + login (can live in one of the cross-seed LXCs or its own LXC)
#   both   hub + agent in this LXC (the local agent is registered automatically)
#
# Update:  cross-seed-ui update        (or: install.sh --update)
# Options: see --help
set -euo pipefail

REPO="ckegels/cross-seed-ui"
ROLE=""
VERSION="latest"
TOKEN="${GITHUB_TOKEN:-}"
TARBALL=""
AGENT_PORT=2469
HUB_PORT=2470
AGENT_LISTEN=""
ALLOW_IPS=()
CS_DIR="/root/.cross-seed"
CS_SERVICE="cross-seed"
UPDATE=0
INTERACTIVE=1
[[ -t 0 ]] || INTERACTIVE=0

umask 022
PREFIX=/opt/cross-seed-ui
ETC=/etc/cross-seed-ui
STATE=/var/lib/cross-seed-ui
MIN_NODE="22.13.0"

c_bold=$'\e[1m'; c_dim=$'\e[2m'; c_green=$'\e[32m'; c_red=$'\e[31m'; c_yellow=$'\e[33m'; c_reset=$'\e[0m'
info() { echo "${c_bold}==>${c_reset} $*"; }
ok() { echo "${c_green}✔${c_reset} $*"; }
warn() { echo "${c_yellow}!${c_reset} $*" >&2; }
die() { echo "${c_red}✘ $*${c_reset}" >&2; exit 1; }

usage() {
	cat <<EOF
Usage: install.sh [options]
  --role agent|hub|both     what to install (asked if omitted)
  --update                  update an existing install (role from $ETC/install.conf)
  --version vX.Y.Z          release to install (default: latest)
  --token TOKEN             GitHub token for the private repo (or env GITHUB_TOKEN; stored in $ETC/github-token)
  --repo owner/name         GitHub repository (default: $REPO)
  --tarball FILE            install from a local release tarball instead of GitHub
  --agent-port N            agent port (default 2469)
  --hub-port N              hub port (default 2470)
  --agent-listen IP         agent bind address (default 0.0.0.0, or 127.0.0.1 for --role both)
  --allow-ip IP[/CIDR]      only accept agent requests from this IP (repeatable; e.g. the hub's IP)
  --cross-seed-dir DIR      cross-seed config dir (default /root/.cross-seed)
  --cross-seed-service NAME systemd unit of cross-seed (default cross-seed)
  -y, --yes                 non-interactive
EOF
}

while [[ $# -gt 0 ]]; do
	case "$1" in
		--role) ROLE="$2"; shift 2 ;;
		--update) UPDATE=1; shift ;;
		--version) VERSION="$2"; shift 2 ;;
		--token) TOKEN="$2"; shift 2 ;;
		--repo) REPO="$2"; shift 2 ;;
		--tarball) TARBALL="$2"; shift 2 ;;
		--agent-port) AGENT_PORT="$2"; shift 2 ;;
		--hub-port) HUB_PORT="$2"; shift 2 ;;
		--agent-listen) AGENT_LISTEN="$2"; shift 2 ;;
		--allow-ip) ALLOW_IPS+=("$2"); shift 2 ;;
		--cross-seed-dir) CS_DIR="$2"; shift 2 ;;
		--cross-seed-service) CS_SERVICE="$2"; shift 2 ;;
		-y|--yes) INTERACTIVE=0; shift ;;
		-h|--help) usage; exit 0 ;;
		*) die "Unknown option $1 (see --help)" ;;
	esac
done

[[ $EUID -eq 0 ]] || die "Run as root (the agent manages cross-seed, which runs as root in the community-script LXC)."
command -v systemctl >/dev/null || die "systemd is required."

ask() { # ask "question" default -> echoes answer
	local q="$1" def="${2:-}" a
	if [[ $INTERACTIVE -eq 0 ]]; then echo "$def"; return; fi
	read -r -p "$q${def:+ [$def]}: " a </dev/tty || true
	echo "${a:-$def}"
}

# ------------------------------------------------------------------ previous install
if [[ -f $ETC/install.conf ]]; then
	# shellcheck disable=SC1091
	source "$ETC/install.conf"
	ROLE="${ROLE:-$INSTALLED_ROLE}"
	REPO="${INSTALLED_REPO:-$REPO}"
fi
if [[ $UPDATE -eq 1 && -z "${INSTALLED_ROLE:-}" ]]; then die "No existing install found ($ETC/install.conf)."; fi
if [[ -z $TOKEN && -f $ETC/github-token ]]; then TOKEN="$(cat "$ETC/github-token")"; fi

if [[ -z $ROLE ]]; then
	echo "What should this LXC run?"
	echo "  agent - this LXC runs cross-seed and should be managed by a hub elsewhere"
	echo "  hub   - only the web UI"
	echo "  both  - web UI + agent for the cross-seed in this LXC"
	ROLE="$(ask "Role (agent/hub/both)" both)"
fi
case "$ROLE" in agent|hub|both) ;; *) die "Role must be agent, hub or both" ;; esac
has_agent() { [[ $ROLE == agent || $ROLE == both ]]; }
has_hub() { [[ $ROLE == hub || $ROLE == both ]]; }

# ------------------------------------------------------------------ dependencies
version_ge() { [[ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -n1)" == "$2" ]]; }

ensure_tools() {
	local missing=()
	for t in curl tar sha256sum; do command -v "$t" >/dev/null || missing+=("$t"); done
	if [[ ${#missing[@]} -gt 0 ]]; then
		info "Installing ${missing[*]}"
		apt-get update -qq && apt-get install -y -qq curl tar coreutils ca-certificates >/dev/null
	fi
}

ensure_node() {
	local v=""
	if command -v node >/dev/null; then v="$(node -v | tr -d v)"; fi
	if [[ -n $v ]] && version_ge "$v" "$MIN_NODE"; then
		ok "Node.js $v"
		return
	fi
	warn "Node.js >= $MIN_NODE is required (found: ${v:-none})."
	local yn
	yn="$(ask "Install Node.js 22 LTS from NodeSource now? (y/n)" y)"
	[[ $yn == y* ]] || die "Install Node.js >= $MIN_NODE and run again."
	curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
	apt-get install -y -qq nodejs >/dev/null
	ok "Node.js $(node -v)"
}

# ------------------------------------------------------------------ download
gh_api() { # gh_api URL [extra curl args]
	local url="$1"; shift
	local auth=()
	[[ -n $TOKEN ]] && auth=(-H "Authorization: Bearer $TOKEN")
	curl -fsSL "${auth[@]}" -H "X-GitHub-Api-Version: 2022-11-28" "$@" "$url"
}

json_field() { # json_field <json> <js expression on j>
	node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);const v=('"$2"');if(v===undefined||v===null)process.exit(3);process.stdout.write(String(v))})' <<<"$1"
}

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

fetch_release() { # -> sets REL_DIR
	local tmp="$TMP_DIR"
	local file
	if [[ -n $TARBALL ]]; then
		file="$TARBALL"
		[[ -f $file ]] || die "Tarball $file not found"
	else
		[[ -n $TOKEN ]] || warn "No GitHub token given; this only works if the repository is public."
		local api="https://api.github.com/repos/$REPO/releases/latest"
		[[ $VERSION != latest ]] && api="https://api.github.com/repos/$REPO/releases/tags/v${VERSION#v}"
		local rel
		rel="$(gh_api "$api" -H "Accept: application/vnd.github+json")" || die "Could not read release info from $REPO (token missing or no release published?)"
		local asset_url sum_url name
		name="$(json_field "$rel" 'j.assets.find(a=>/^cross-seed-ui-.*\.tar\.gz$/.test(a.name))?.name')" || die "Release has no cross-seed-ui-*.tar.gz asset"
		asset_url="$(json_field "$rel" "j.assets.find(a=>a.name===\"$name\").url")"
		sum_url="$(json_field "$rel" "j.assets.find(a=>a.name===\"$name.sha256\")?.url")" || sum_url=""
		info "Downloading $name"
		gh_api "$asset_url" -H "Accept: application/octet-stream" -o "$tmp/$name"
		if [[ -n $sum_url ]]; then
			gh_api "$sum_url" -H "Accept: application/octet-stream" -o "$tmp/$name.sha256"
			(cd "$tmp" && sha256sum -c "$name.sha256" >/dev/null) || die "Checksum mismatch for $name"
			ok "Checksum verified"
		else
			warn "No checksum file in the release, skipping verification"
		fi
		file="$tmp/$name"
	fi
	local stage="$tmp/stage"
	mkdir -p "$stage"
	tar --no-same-owner -xzf "$file" -C "$stage"
	[[ -f $stage/VERSION && -f $stage/agent.mjs && -f $stage/hub.mjs ]] || die "Not a cross-seed-ui release archive"
	local ver
	ver="$(tr -d '[:space:]' <"$stage/VERSION")"
	REL_DIR="$PREFIX/releases/$ver"
	rm -rf "$REL_DIR"
	mkdir -p "$PREFIX/releases"
	install -d -m 755 "$PREFIX" "$PREFIX/releases"
	cp -a "$stage" "$REL_DIR"
	# the hub runs as the unprivileged csui user: it must be able to read the release
	chown -R root:root "$REL_DIR"
	chmod -R u=rwX,go=rX "$REL_DIR"
	chmod 755 "$REL_DIR/bin/cross-seed-ui" "$REL_DIR/deploy/install.sh"
	ln -sfn "$REL_DIR" "$PREFIX/current"
	ln -sfn "$PREFIX/current/bin/cross-seed-ui" /usr/local/bin/cross-seed-ui
	RELEASE_VERSION="$ver"
	ok "Installed release $ver in $REL_DIR"
	# keep the 3 newest releases (+ current)
	local keep
	keep="$(ls -1dt "$PREFIX"/releases/* | head -n 3)"
	for d in "$PREFIX"/releases/*; do
		grep -qxF "$d" <<<"$keep" || [[ $d == "$REL_DIR" ]] || rm -rf "$d"
	done
}

# ------------------------------------------------------------------ config files
rand_secret() { head -c 32 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n'; }

write_agent_config() {
	local f="$ETC/agent.json"
	if [[ -f $f ]]; then ok "Keeping existing $f"; return; fi
	local listen="${AGENT_LISTEN:-0.0.0.0}"
	[[ $ROLE == both && -z $AGENT_LISTEN ]] && listen="127.0.0.1"
	local bin
	bin="$(command -v cross-seed || echo /usr/bin/cross-seed)"
	local ips="[]"
	if [[ ${#ALLOW_IPS[@]} -gt 0 ]]; then ips="[$(printf '"%s",' "${ALLOW_IPS[@]}" | sed 's/,$//')]"; fi
	touch "$f"
	chmod 600 "$f"
	cat >"$f" <<EOF
{
  "listen": "$listen",
  "port": $AGENT_PORT,
  "secret": "$(rand_secret)",
  "allowedIps": $ips,
  "crossSeedDir": "$CS_DIR",
  "crossSeedBin": "$bin",
  "service": { "manager": "systemd", "name": "$CS_SERVICE" },
  "stateDir": "$STATE/agent",
  "maxBackups": 50,
  "eventRetentionDays": 365,
  "backfillLogs": true
}
EOF
	chmod 600 "$f"
	ok "Created $f"
}

write_hub_config() {
	local f="$ETC/hub.json"
	if [[ -f $f ]]; then ok "Keeping existing $f"; return; fi
	cat >"$f" <<EOF
{
  "listen": "0.0.0.0",
  "port": $HUB_PORT,
  "stateDir": "$STATE/hub",
  "webDir": "$PREFIX/current/web",
  "trustProxy": false,
  "secureCookies": "auto",
  "sessionIdleHours": 168,
  "sessionMaxDays": 30,
  "sudoMinutes": 10,
  "githubRepo": "$REPO",
  "githubTokenFile": "$ETC/github-token"
}
EOF
	chmod 640 "$f"
	chgrp csui "$f"
	ok "Created $f"
}

# ------------------------------------------------------------------ systemd
install_unit() { # name
	local name="$1" node
	node="$(command -v node)"
	sed -e "s#@NODE@#$node#g" -e "s#@PREFIX@#$PREFIX#g" -e "s#@ETC@#$ETC#g" -e "s#@STATE@#$STATE#g" \
		"$PREFIX/current/deploy/systemd/$name.service" >"/etc/systemd/system/$name.service"
}

start_unit() { # name
	local name="$1"
	systemctl daemon-reload
	systemctl enable "$name" >/dev/null 2>&1
	systemctl restart "$name" || true
	sleep 3
	if ! systemctl is-active --quiet "$name"; then
		if journalctl -u "$name" -n 30 --no-pager 2>/dev/null | grep -qE "NAMESPACE|226/|Failed to set up mount namespacing|Operation not permitted"; then
			warn "$name: this LXC does not allow systemd sandboxing, disabling it for this unit"
			mkdir -p "/etc/systemd/system/$name.service.d"
			cat >"/etc/systemd/system/$name.service.d/10-no-sandbox.conf" <<'EOF'
[Service]
ProtectSystem=no
ProtectHome=no
PrivateTmp=no
PrivateDevices=no
ProtectKernelTunables=no
ProtectKernelModules=no
ProtectKernelLogs=no
ProtectControlGroups=no
ProtectClock=no
ProtectHostname=no
RestrictNamespaces=no
EOF
			systemctl daemon-reload
			systemctl restart "$name" || true
			sleep 3
		fi
	fi
	if systemctl is-active --quiet "$name"; then ok "$name is running"; else
		journalctl -u "$name" -n 20 --no-pager || true
		die "$name failed to start (see above)"
	fi
}

primary_ip() { hostname -I 2>/dev/null | awk '{print $1}'; }

# ------------------------------------------------------------------ main
if [[ $UPDATE -eq 1 ]]; then info "Updating cross-seed-ui (role: $ROLE)"; else info "Installing cross-seed-ui (role: $ROLE)"; fi
ensure_tools
ensure_node

if has_agent; then
	if ! command -v cross-seed >/dev/null; then warn "cross-seed is not on PATH. Set crossSeedBin in $ETC/agent.json if it lives elsewhere."; fi
	[[ -f $CS_DIR/config.js ]] || warn "No $CS_DIR/config.js yet (run 'cross-seed gen-config' or let the UI create it)."
	systemctl cat "$CS_SERVICE" >/dev/null 2>&1 || warn "systemd unit '$CS_SERVICE' not found. Set service.name in $ETC/agent.json."
fi

mkdir -p "$ETC" "$STATE"
chmod 755 "$ETC"
if [[ -n $TOKEN ]]; then
	(umask 077 && printf '%s' "$TOKEN" >"$ETC/github-token")
	chmod 600 "$ETC/github-token"
fi

fetch_release

if has_hub; then
	id csui >/dev/null 2>&1 || useradd --system --home-dir "$STATE/hub" --shell /usr/sbin/nologin csui
	mkdir -p "$STATE/hub"
	chown -R csui:csui "$STATE/hub"
	chmod 700 "$STATE/hub"
	[[ -f $ETC/github-token ]] && chgrp csui "$ETC/github-token" && chmod 640 "$ETC/github-token"
	write_hub_config
	install_unit cross-seed-ui-hub
	start_unit cross-seed-ui-hub
fi
if has_agent; then
	mkdir -p "$STATE/agent"
	chmod 700 "$STATE/agent"
	write_agent_config
	install_unit cross-seed-ui-agent
	start_unit cross-seed-ui-agent
fi

cat >"$ETC/install.conf" <<EOF
INSTALLED_ROLE=$ROLE
INSTALLED_REPO=$REPO
INSTALLED_VERSION=$RELEASE_VERSION
EOF

if [[ $ROLE == both && $UPDATE -eq 0 ]]; then
	secret_file="$(mktemp)"
	node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).secret)' "$ETC/agent.json" >"$secret_file"
	chown csui "$secret_file"
	sleep 2
	runuser -u csui -- "$(command -v node)" --disable-warning=ExperimentalWarning "$PREFIX/current/hub.mjs" --config "$ETC/hub.json" \
		add-instance "$(hostname)" "http://127.0.0.1:$AGENT_PORT" "$secret_file" || warn "Could not register the local agent automatically; add it in the UI."
	rm -f "$secret_file"
	systemctl restart cross-seed-ui-hub
fi

echo
ok "${c_bold}cross-seed-ui $RELEASE_VERSION ready${c_reset}"
ip="$(primary_ip)"
if has_hub; then
	echo "  Web UI:        http://${ip:-<this-lxc-ip>}:$HUB_PORT"
	if [[ $UPDATE -eq 0 ]]; then
		token="$(runuser -u csui -- "$(command -v node)" --disable-warning=ExperimentalWarning "$PREFIX/current/hub.mjs" --config "$ETC/hub.json" setup-token 2>/dev/null || true)"
		[[ -n $token ]] && echo "  Setup token:   ${c_bold}$token${c_reset}   (needed once to create the admin account)"
	fi
fi
if [[ $ROLE == agent && $UPDATE -eq 0 ]]; then
	secret="$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).secret)' "$ETC/agent.json")"
	echo "  Add this agent in the hub (Settings → Instances → Add):"
	echo "    URL:    http://${ip:-<this-lxc-ip>}:$AGENT_PORT"
	echo "    Secret: $secret"
	echo "  ${c_dim}Show again later with: cross-seed-ui agent-info${c_reset}"
fi
echo "  Update later:  cross-seed-ui update"
