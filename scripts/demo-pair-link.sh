#!/usr/bin/env bash
# Prints the demo server's pairing link: the reusable
# DEMO_PAIRING_CODE, valid until DEMO_PAIRING_EXPIRES, as
# https://mdvju.app/pair#code=…&backend=<PUBLIC_URL> (no name: each device
# sends the app's default one), a QR code of
# it, and a one-time ots link of it (valid a day) if ots-cli is on PATH.
# This is the link for the App Review notes. It makes no code and changes
# nothing: every pairing with it is a new demo device (at most
# DEMO_MAX_DEVICES, oldest revoked first).
#
#   scripts/demo-pair-link.sh
#
# Run it on the demo server's host, in its checkout. Reads PUBLIC_URL,
# DEMO_PAIRING_CODE and DEMO_PAIRING_EXPIRES from the env or .env,
# and checks them as the server does at startup. See scripts/devices-lib.sh.
set -euo pipefail
. "$(dirname "$0")/devices-lib.sh"

case "${1:-}" in
  -h|--help) sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac

# Like PUBLIC_URL in devices-lib.sh: the env wins, else the last line in
# .env. Read into the environment, never printed or passed as an argument.
from_env_file() { # name
  [ -f "$REPO/.env" ] || return 0
  sed -n "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*//p" "$REPO/.env" | tail -1
}
[ -n "${DEMO_PAIRING_CODE:-}" ] || DEMO_PAIRING_CODE="$(from_env_file DEMO_PAIRING_CODE)"
[ -n "${DEMO_PAIRING_EXPIRES:-}" ] || DEMO_PAIRING_EXPIRES="$(from_env_file DEMO_PAIRING_EXPIRES)"
export DEMO_PAIRING_CODE DEMO_PAIRING_EXPIRES

link="$(devices_cli demo-link)"
show_pair_link "$link" "reusable by any device until DEMO_PAIRING_EXPIRES" 24h
