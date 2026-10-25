#!/bin/sh
# Docker entrypoint: cross-seed-ui hub|agent|healthcheck|<hub maintenance command>
set -e
role="${1:-hub}"
[ $# -gt 0 ] && shift
case "$role" in
	hub)
		exec node --disable-warning=ExperimentalWarning /app/hub.mjs --config /state/hub.json "$@"
		;;
	agent)
		if [ -z "$CSUI_AGENT_SECRET" ] && [ ! -f /state/agent.json ]; then
			echo "Set CSUI_AGENT_SECRET (at least 32 characters, e.g. from: openssl rand -base64 32)" >&2
			exit 1
		fi
		exec node --disable-warning=ExperimentalWarning /app/agent.mjs --config /state/agent.json "$@"
		;;
	healthcheck)
		# whichever role runs in this container answers on its port
		port="${CSUI_PORT:-}"
		for p in $port 2470 2469; do
			if wget -q -T 3 -O /dev/null "http://127.0.0.1:$p/api/healthz" 2>/dev/null || wget -q -T 3 -O /dev/null "http://127.0.0.1:$p/healthz" 2>/dev/null; then exit 0; fi
		done
		exit 1
		;;
	setup-token | reset-password | disable-2fa | add-instance)
		exec node --disable-warning=ExperimentalWarning /app/hub.mjs --config /state/hub.json "$role" "$@"
		;;
	version)
		cat /app/VERSION
		;;
	*)
		echo "usage: cross-seed-ui hub|agent|setup-token|reset-password <user>|disable-2fa <user>|version" >&2
		exit 1
		;;
esac
