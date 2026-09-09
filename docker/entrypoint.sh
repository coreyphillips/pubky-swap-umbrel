#!/bin/sh
set -e

DATA_DIR="${DATA_DIR:-/data}"

# Docker creates a missing bind-mount source as root, so make sure the data volume exists and
# belongs to the unprivileged user before dropping to it. Everything under here is either a
# secret or the record of a funded HTLC, so it is not world-readable.
mkdir -p "$DATA_DIR/secrets" "$DATA_DIR/swaps"
chown -R 1000:1000 "$DATA_DIR"
chmod 700 "$DATA_DIR" "$DATA_DIR/secrets"

# Run as UID 1000. The swap daemons this supervises inherit it, so nothing in this container
# writes as root: a data directory owned by root is one a later version running unprivileged
# cannot read, which for a swap record means a funded HTLC nobody can refund.
exec gosu 1000:1000 node server.js
