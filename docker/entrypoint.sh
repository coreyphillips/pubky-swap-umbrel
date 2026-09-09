#!/bin/sh
# Fix up the data volume's ownership as root, then drop privileges for the server itself.
#
# The directories matter as much as the ownership. /data/secrets holds the recovery phrase and the
# passphrase; /data/client/swaps holds the only key that can recover funds from a swap that did not
# finish. Both are created here with their modes, so they never exist at a looser one.
set -e

DATA_DIR="${DATA_DIR:-/data}"
APP_UID="${APP_UID:-1000}"
APP_GID="${APP_GID:-1000}"

mkdir -p "$DATA_DIR/secrets" "$DATA_DIR/swap" "$DATA_DIR/client/swaps" "$DATA_DIR/quote"
chmod 700 "$DATA_DIR/secrets" "$DATA_DIR/client/swaps"

# An install from an earlier build has a root-owned /data.
chown -R "$APP_UID:$APP_GID" "$DATA_DIR" 2>/dev/null || true

exec gosu "$APP_UID:$APP_GID" node server.js
