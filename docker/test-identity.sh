#!/bin/sh
set -eu

probe=$1
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT HUP INT TERM
chmod 700 "$scratch"
printf '%s\n' 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about' > "$scratch/phrase"
chmod 600 "$scratch/phrase"
printf 'data_dir = "%s/unused"\n' "$scratch" > "$scratch/config.toml"
export PUBKY_SWAP_CONFIG="$scratch/config.toml"
export PUBKY_SWAP_RECOVERY_PHRASE__FILE="$scratch/phrase"
"$probe" > "$scratch/output"
grep -Eq '^IDENTITY pubky=[ybndrfg8ejkmcpqxot1uwisza345h769]{52}$' "$scratch/output"
test "$(wc -l < "$scratch/output" | tr -d ' ')" = 1
test ! -e "$scratch/unused"
printf '%s\n' 'invalid recovery phrase' > "$scratch/phrase"
if "$probe" > "$scratch/output" 2> "$scratch/error"; then
    echo 'Invalid identity was accepted' >&2
    exit 1
fi
test ! -s "$scratch/output"
echo 'Offline identity checks passed'
