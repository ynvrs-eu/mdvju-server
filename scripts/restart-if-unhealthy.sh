#!/usr/bin/env bash
# restart-if-unhealthy.sh — cron-fired watchdog for the backend container
# of the docker-compose.yml next to this script (found through Compose, so
# the project or container name can change).
# MDVJU_CONTAINER names it instead, for a container started another way.
#
# See docker-compose.yml's healthcheck comment for the failure mode this
# closes: a Docker HEALTHCHECK on its own does NOT trigger
# `restart: unless-stopped` when it reports "unhealthy" -- that restart
# policy only fires if the container process actually exits, not while
# an unhealthy-but-still-running container just keeps serving bad
# responses (this happened in production: 5 hours of
# a stale NFS bind mount, container never restarted because nothing
# was actually crashing).
#
# Intended to run every few minutes from cron:
#   */5 * * * * /path/to/mdvju-server/scripts/restart-if-unhealthy.sh >> /tmp/mdvju-watchdog.log 2>&1
set -euo pipefail

COMPOSE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CONTAINER="${MDVJU_CONTAINER:-$(docker compose --project-directory "$COMPOSE_DIR" ps -q server 2>/dev/null || true)}"
if [ -z "$CONTAINER" ]; then
  echo "$(date -Iseconds) no server container for $COMPOSE_DIR -- not restarting, needs a human to look"
  exit 0
fi

status=$(docker inspect --format='{{.State.Health.Status}}' "$CONTAINER" 2>/dev/null || echo "missing")

case "$status" in
  unhealthy)
    echo "$(date -Iseconds) $CONTAINER is unhealthy, restarting"
    docker restart "$CONTAINER"
    ;;
  missing)
    echo "$(date -Iseconds) $CONTAINER not found -- not restarting, needs a human to look"
    ;;
  *)
    ;; # healthy or starting -- nothing to do, stay quiet
esac
