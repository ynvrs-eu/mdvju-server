#!/usr/bin/env bash
# Pairs a new device with the backend: makes a single-use
# pairing code (10 minutes) in the device registry and prints its link
# (https://mdvju.app/pair#code=…&backend=…), a QR code of it, and a
# one-time ots link of it if ots-cli is on PATH. Open the link (or scan the
# QR code) on the new device: the app asks, then pairs.
#
#   scripts/pair-device.sh "<device name>"
#
# Run it on the backend's host. It edits secrets/devices.json from
# a one-off container of the backend image (or $SECRETS_DIR on the host), so
# it works on a running backend without a restart, and also creates the
# file the first time. Needs PUBLIC_URL (env or .env). See
# scripts/devices-lib.sh.
#
# Test backend: SECRETS_DIR=test/.runtime/secrets PUBLIC_URL=http://127.0.0.1:3199 scripts/pair-device.sh admin-cli
set -euo pipefail
. "$(dirname "$0")/devices-lib.sh"

case "${1:-}" in
  ''|-h|--help) sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac

link="$(devices_cli pair "$1")"
show_pair_link "$link"
