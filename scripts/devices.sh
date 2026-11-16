#!/usr/bin/env bash
# Lists, revokes and rotates paired devices.
#
#   scripts/devices.sh list           every device: id, name, paired, last seen, status
#   scripts/devices.sh revoke <id>    its token and attachment key stop working
#                                     on the backend's next request
#   scripts/devices.sh rotate <id>    revoke, then a new pairing link for the
#                                     same name (printed like pair-device.sh)
#
# Run it on the backend's host: it edits secrets/devices.json (or
# $SECRETS_DIR) directly, no restart needed. "last seen" in the file is
# written at most hourly; the app's Settings > Devices shows the live value.
# See scripts/devices-lib.sh for the env.
set -euo pipefail
. "$(dirname "$0")/devices-lib.sh"

case "${1:-}" in
  list) devices_cli list ;;
  revoke) devices_cli revoke "${2:?usage: devices.sh revoke <id>}" ;;
  rotate)
    link="$(devices_cli rotate "${2:?usage: devices.sh rotate <id>}")"
    show_pair_link "$link"
    ;;
  *) sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac
