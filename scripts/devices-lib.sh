# Shared by scripts/pair-device.sh and scripts/devices.sh (sourced, not run).
#
# Both edit the device registry through src/devices-cli.ts: a running
# backend sees the change on its next request, so nothing is restarted and no
# shared token is needed.
#
# The live registry (secrets/) belongs to the container's user only
# (0600/0700), so for it the CLI runs in a one-off
# container of the backend image (`docker compose run`), which also works
# before the backend has ever started. With SECRETS_DIR set (the test
# backend's test/.runtime/secrets) it runs on the host instead.
#
# Env:
#   SECRETS_DIR  a registry folder on the host (the test backend's is
#                test/.runtime/secrets); unset = the live one, in the container
#   PUBLIC_URL   the backend's URL as the app reaches it, for pairing links
#                (default: PUBLIC_URL= from .env)

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [ -n "${SECRETS_DIR:-}" ]; then
  case "$SECRETS_DIR" in /*) ;; *) SECRETS_DIR="$PWD/$SECRETS_DIR" ;; esac
  export SECRETS_DIR
fi
if [ -z "${PUBLIC_URL:-}" ] && [ -f "$REPO/.env" ]; then
  PUBLIC_URL="$(sed -n 's/^[[:space:]]*PUBLIC_URL[[:space:]]*=[[:space:]]*//p' "$REPO/.env" | tail -1)"
fi
export PUBLIC_URL="${PUBLIC_URL:-}"

devices_cli() {
  if [ -n "${SECRETS_DIR:-}" ]; then
    [ -d "$REPO/node_modules" ] || { echo "node_modules missing: run npm ci first" >&2; exit 1; }
    (cd "$REPO" && npx --no-install ts-node --transpile-only src/devices-cli.ts "$@")
  else
    # The demo code goes by name only (`-e VAR`): docker takes its value
    # from this environment, so it's never on a command line
    # (demo-pair-link.sh; unset for every other script).
    docker compose -f "$REPO/docker-compose.yml" run --rm --no-deps -T \
      -e PUBLIC_URL="$PUBLIC_URL" -e DEMO_PAIRING_CODE -e DEMO_PAIRING_EXPIRES \
      server node dist/src/devices-cli.js "$@"
  fi
}

# Prints a pairing link three ways: as text, as a QR code to scan with the
# new device's camera, and, if ots-cli is on PATH, as a one-time link to
# send instead of the link itself (it never goes into a chat). The demo
# link (demo-pair-link.sh) passes its own description and ots expiry.
show_pair_link() { # link [description] [ots expiry]
  echo
  echo "Pairing link (${2:-single use, valid for 10 minutes}):"
  echo "$1"
  echo
  devices_cli qr "$1"
  if command -v ots-cli >/dev/null; then
    echo "One-time link to send (opens once, then the pairing link is gone):"
    printf '%s' "$1" | ots-cli create --expire "${3:-10m}"
  else
    echo "(ots-cli not found: no one-time link made)"
  fi
}
