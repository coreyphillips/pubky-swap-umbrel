# Migrate flat storage for version 0.2.5

Version 0.2.5 separates engine state by Bitcoin network. Existing flat state makes the new
dashboard stop before starting either engine. This includes completed swap records, wallet
databases, run history and transport journals. Finishing active swaps alone does not migrate it.

This procedure is for an existing Linux Umbrel installation whose entire flat store belongs to
one verified network. It preserves a full private backup, then moves complete directories while
the app is stopped. Do not use it to combine stores, repair a partially completed migration,
or separate data previously used on multiple networks. Those cases need a record-by-record
recovery plan before any files are moved.

## Verify the network and stop all writers

Before updating, record the currently running provider's public identity and network from the
dashboard. Confirm that its LND and Electrum backends report the same chain. Check the network
fields in the existing provider and client configuration locally if both roles were used.
Use the chain that created the saved data, even if the node's current environment was changed.
If the evidence conflicts or the old network is unknown, stop here. Do not infer it from an
address prefix or choose a network just to make startup succeed.

Use this exact destination name:

| Verified chain | Destination directory |
| --- | --- |
| Bitcoin mainnet, called `mainnet` by Umbrel and LND | `bitcoin` |
| Testnet | `testnet` |
| Signet | `signet` |
| Regtest | `regtest` |

Finish active swaps if possible. Stop Pubky Swap using Umbrel's app controls and prevent any
other process or container from writing its data volume. Check that the app container is stopped:

```sh
sudo docker inspect --format '{{.State.Running}}' pubky-swap_server_1
```

The result must be `false`. Do not uninstall the app, reset its identity, or remove its volume.
Do not restart the old image after the directories have moved: it uses the old flat paths.

Find the existing host path mounted at `/data` without opening any identity file:

```sh
sudo docker inspect --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Source}}{{end}}{{end}}' pubky-swap_server_1
```

## Back up and move the complete stores

The commands below require Bash and GNU coreutils on the Linux Umbrel host. Select the actual
host data path, an unused backup directory outside it, and the verified network. The backup's
parent directory must already exist on private storage with enough free space for the entire
data volume. The backup includes identity material and must not be uploaded or shared.

```sh
SWAP_DATA_DIR='/absolute/host/path/to/pubky-swap/data'
SWAP_BACKUP_DIR='/absolute/private/backup/pubky-swap-before-0.2.5'
SWAP_VERIFIED_NETWORK='bitcoin'
```

The destination `networks/<network>` must not exist. If a previous attempt created it, stop and
inspect that attempt first. Do not merge directories or overwrite a destination. An existing
empty directory may be removed with `rmdir` only after confirming that no migration has started.
Symlinks and special files require a separate backup and migration plan; this procedure refuses
them. It never prints file contents.

Run this block only after the network and stopped-app checks above:

```sh
sudo bash -s -- "$SWAP_DATA_DIR" "$SWAP_BACKUP_DIR" "$SWAP_VERIFIED_NETWORK" <<'MIGRATE'
set -euo pipefail
fail() { printf '%s\n' "$1" >&2; exit 1; }
[ "$#" -eq 3 ] || fail 'Expected data directory, backup directory and verified network.'
case "$3" in bitcoin|testnet|signet|regtest) ;; *) fail 'Unsupported network.' ;; esac
[ ! -L "$1" ] || fail 'The data directory must not be a symlink.'
data=$(realpath -e -- "$1")
[ -d "$data" ] && [ "$data" != / ] || fail 'Expected the existing app data directory.'
backup=$(realpath -m -- "$2")
[ -d "$(dirname -- "$backup")" ] || fail 'Create the private backup parent first.'
case "$backup" in "$data"|"$data"/*) fail 'Backup must be outside app data.' ;; esac
[ ! -e "$backup" ] && [ ! -L "$backup" ] || fail 'Backup destination already exists.'
target="$data/networks/$3"
[ ! -e "$target" ] && [ ! -L "$target" ] || fail 'Network destination already exists.'
[ "$(docker inspect --format '{{.State.Running}}' pubky-swap_server_1)" = false ] \
  || fail 'Stop the app before migration.'
mounted_data=$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Source}}{{end}}{{end}}' pubky-swap_server_1)
[ "$data" = "$(realpath -e -- "$mounted_data")" ] \
  || fail 'The selected data directory is not the app container data mount.'
[ -z "$(find "$data" ! -type d ! -type f -print -quit)" ] \
  || fail 'Data contains a symlink or special file. Manual migration is required.'
found=false
for name in swap client quote; do
  if [ -e "$data/$name" ]; then
    [ -d "$data/$name" ] || fail 'A flat store path is not a directory.'
    found=true
  fi
done
[ "$found" = true ] || fail 'No flat stores found. Do not repeat an existing migration.'

install -d -m 0700 -- "$backup"
cp -a -- "$data/." "$backup/"
chmod 0700 -- "$backup"
diff -qr -- "$data" "$backup" >/dev/null \
  || fail 'Backup verification failed. Original data has not been moved.'
sync

install -d -m 0700 -- "$data/networks"
mkdir -m 0700 -- "$target"
for name in swap client quote; do
  if [ -d "$data/$name" ]; then
    mv -T -- "$data/$name" "$target/$name"
  fi
done
sync
printf 'Migration complete. Keep the original backup at %s\n' "$backup"
printf 'Start only version 0.2.5 or later using network %s.\n' "$3"
MIGRATE
```

The mapping is:

| Old location under `/data` | New location under `/data` |
| --- | --- |
| `swap` | `networks/<network>/swap` |
| `client` | `networks/<network>/client` |
| `quote` | `networks/<network>/quote` |

Every file below those directories moves together, including databases, SQLite sidecar files,
funding-wallet state, completed and pending swaps, run history and delivery journals. Settings
and the entire `secrets` directory stay at their existing root locations. Keep other root files
as well. Do not select individual records or discard journals. The original full backup stays
outside the app volume and is not modified by this procedure.

If any command fails, keep the app stopped. A failure during the three directory moves can
leave some stores at the old paths and others at the new paths. Preserve both locations and the
backup; inspect the failed step before proceeding. Do not rerun against a nonempty destination.

## Start the updated app and verify recovery

Use Umbrel's **Update** action only once its store offers the published version 0.2.5 image.
Confirm that the app's configured network still matches the verified network. The entrypoint
restores the runtime ownership of the working volume, and the dashboard regenerates engine
configuration with the new paths when it starts a provider, swap or recovery run.

Confirm the diagnostic version, public identity, backend chain and funding-wallet balance.
Check that expected swap history and pending recovery records are visible before creating a
new swap. Preserve the complete working volume and the original backup after validation.
If recovery data is missing or startup fails, stop the app and investigate the existing stores.
Do not fix it by choosing another network, clearing files, importing a fresh identity or retrying
an invoice payment.

Rolling back is a separate recovery operation. Do not copy the old backup over the new working
volume. Once the updated app has created or changed swap or delivery state, the old backup is
stale and cannot safely replace that state. Preserve a full copy of the current volume and
obtain a recovery plan before returning to an older image.
