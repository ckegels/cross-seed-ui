#!/usr/bin/env bash
# Local dev helper: scripts/dev.sh start|stop|restart agent|hub
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p dev
action=${1:-}; what=${2:-}
pidfile="dev/$what.pid"
stop() {
	if [[ -f $pidfile ]]; then
		kill "$(cat "$pidfile")" 2>/dev/null || true
		rm -f "$pidfile"
		sleep 1
	fi
}
start() {
	nohup node --disable-warning=ExperimentalWarning --import tsx "packages/$what/src/main.ts" --config "dev/$what.json" >"dev/$what.log" 2>&1 &
	echo $! >"$pidfile"
	sleep 3
	tail -n 5 "dev/$what.log"
}
case "$action" in
	start) start ;;
	stop) stop ;;
	restart) stop; start ;;
	*) echo "usage: $0 start|stop|restart agent|hub"; exit 1 ;;
esac
