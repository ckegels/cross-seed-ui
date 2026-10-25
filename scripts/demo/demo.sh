#!/usr/bin/env bash
# Local demo of cross-seed-ui with two real cross-seed 6.13.9 daemons, fake
# qBittorrent/Prowlarr/Sonarr/Radarr and two weeks of seeded history.
#
#   scripts/demo/demo.sh start     build + start everything, prints login
#   scripts/demo/demo.sh stop      stop everything
#   scripts/demo/demo.sh reset     stop + delete the demo data
#
# DEMO_DIR (default /tmp/cross-seed-ui-demo) holds all data; the media files
# are sparse so they use no real disk space.
set -euo pipefail
cd "$(dirname "$0")/../.."
REPO="$PWD"
DEMO="${DEMO_DIR:-/tmp/cross-seed-ui-demo}"
MOCK_PORT=9696
MOCK="http://127.0.0.1:$MOCK_PORT"
HUB_PORT="${HUB_PORT:-2470}"
USER_NAME=demo
USER_PASS="show me around"
NODE=(node --disable-warning=ExperimentalWarning --import tsx)

start_bg() { # name cmd...
	local name="$1"; shift
	nohup "$@" >"$DEMO/$name.log" 2>&1 &
	echo $! >"$DEMO/$name.pid"
}

stop() {
	for f in "$DEMO"/*.pid; do
		[[ -f $f ]] || continue
		pid="$(cat "$f")"
		# agents stop their cross-seed child on SIGTERM
		kill "$pid" 2>/dev/null || true
		rm -f "$f"
	done
	sleep 2
}

wait_http() { # url
	for _ in $(seq 1 60); do curl -fs -o /dev/null "$1" && return 0; sleep 1; done
	echo "timeout waiting for $1" >&2; return 1
}

start() {
	stop
	mkdir -p "$DEMO"
	if [[ ! -x $DEMO/cs/node_modules/.bin/cross-seed ]]; then
		echo "==> installing cross-seed 6.13.9 for the demo"
		mkdir -p "$DEMO/cs" && (cd "$DEMO/cs" && npm init -y >/dev/null && npm install --no-audit --no-fund cross-seed@6.13.9 >/dev/null)
	fi
	CS="$DEMO/cs/node_modules/.bin/cross-seed"
	[[ -f packages/web/dist/index.html ]] || npm run build -w packages/web >/dev/null

	if [[ ! -f $DEMO/.seeded ]]; then
		echo "==> creating demo library and history"
		"${NODE[@]}" scripts/demo/make-files.ts "$DEMO/media"
		for inst in a b; do
			dir="$DEMO/$inst/config"
			mkdir -p "$dir"
			port=$([[ $inst == a ]] && echo 2468 || echo 2478)
			"${NODE[@]}" scripts/demo/write-config.ts "$dir" "$inst" "$DEMO/media" "$MOCK" "$port"
			CONFIG_DIR="$dir" "$CS" api-key >/dev/null
			"${NODE[@]}" scripts/demo/seed-history.ts "$dir" "$inst" "$MOCK"
		done
		touch "$DEMO/.seeded"
	fi

	echo "==> starting mock services"
	start_bg mock "${NODE[@]}" scripts/demo/mock-services.ts "$DEMO/media" "$MOCK_PORT"
	wait_http "$MOCK/sonarr/api"

	for inst in a b; do
		port=$([[ $inst == a ]] && echo 2469 || echo 2479)
		[[ -f $DEMO/agent-$inst.json ]] || cat >"$DEMO/agent-$inst.json" <<EOF
{
  "listen": "127.0.0.1",
  "port": $port,
  "secret": "$(head -c 32 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n')",
  "crossSeedDir": "$DEMO/$inst/config",
  "crossSeedBin": "$CS",
  "service": { "manager": "process", "name": "cross-seed", "command": ["$CS", "daemon"], "env": { "CONFIG_DIR": "$DEMO/$inst/config" } },
  "stateDir": "$DEMO/$inst/agent-state"
}
EOF
		start_bg "agent-$inst" "${NODE[@]}" packages/agent/src/main.ts --config "$DEMO/agent-$inst.json"
	done

	[[ -f $DEMO/hub.json ]] || cat >"$DEMO/hub.json" <<EOF
{ "listen": "127.0.0.1", "port": $HUB_PORT, "stateDir": "$DEMO/hub-state", "webDir": "$REPO/packages/web/dist" }
EOF
	start_bg hub "${NODE[@]}" packages/hub/src/main.ts --config "$DEMO/hub.json"
	wait_http "http://127.0.0.1:$HUB_PORT/api/healthz"
	wait_http "http://127.0.0.1:2469/healthz"
	wait_http "http://127.0.0.1:2479/healthz"

	if [[ ! -f $DEMO/.hub-setup ]]; then
		echo "==> creating the demo account, instances and Prowlarr connection"
		local jar="$DEMO/cookies" h=(-H content-type:application/json -H x-csui:1) b="http://127.0.0.1:$HUB_PORT"
		token="$(cat "$DEMO/hub-state/setup-token")"
		curl -fs -c "$jar" "${h[@]}" -X POST "$b/api/auth/setup" -d "{\"token\":\"$token\",\"username\":\"$USER_NAME\",\"password\":\"$USER_PASS\"}" >/dev/null
		for inst in a b; do
			port=$([[ $inst == a ]] && echo 2469 || echo 2479)
			name=$([[ $inst == a ]] && echo "LXC A · movies & TV" || echo "LXC B · 4K & anime")
			secret="$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1])).secret)' "$DEMO/agent-$inst.json")"
			curl -fs -b "$jar" "${h[@]}" -X POST "$b/api/instances" -d "{\"name\":\"$name\",\"url\":\"http://127.0.0.1:$port\",\"secret\":\"$secret\"}" >/dev/null
		done
		curl -fs -b "$jar" "${h[@]}" -X PUT "$b/api/prowlarr" -d "{\"url\":\"$MOCK\",\"apiKey\":\"demo0prowlarr0key0123456789abcdef\"}" >/dev/null
		curl -fs -b "$jar" "${h[@]}" -X PUT "$b/api/instances/1/prowlarr" -d '{"mode":"tag","tagIds":[1,2],"privateOnly":true,"auto":false}' >/dev/null
		curl -fs -b "$jar" "${h[@]}" -X PUT "$b/api/instances/2/prowlarr" -d '{"mode":"selected","indexerIds":[2,3,5,6],"privateOnly":true,"auto":false}' >/dev/null
		curl -fs -b "$jar" "${h[@]}" -X POST "$b/api/users" -d '{"username":"viewer","password":"look but dont touch","role":"viewer"}' >/dev/null
		rm -f "$jar"
		touch "$DEMO/.hub-setup"
	fi

	echo
	echo "Demo running:  http://localhost:$HUB_PORT"
	echo "  admin:  $USER_NAME / $USER_PASS"
	echo "  viewer: viewer / look but dont touch"
	echo "Stop with: scripts/demo/demo.sh stop   (data in $DEMO)"
}

case "${1:-}" in
	start) start ;;
	stop) stop; echo "stopped" ;;
	reset) stop; rm -rf "$DEMO"; echo "demo data removed" ;;
	*) echo "usage: $0 start|stop|reset"; exit 1 ;;
esac
