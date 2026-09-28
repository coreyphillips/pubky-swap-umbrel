# Run the local ARM64 candidate

The community-store manifest still selects published version `0.2.4`. Loading the local archive
does not change that installation. The following separate instance explicitly selects the
`0.2.5` candidate and uses a new persistent data volume. It requires an ARM64 Docker host and an
already configured LND and Electrum backend on the same Bitcoin chain.

From this checkout, verify and load the delivered archive:

```sh
(cd dist && shasum -a 256 -c SHA256SUMS)
docker load -i dist/pubky-swap-app-0.2.5-arm64.tar.gz
docker image inspect pubky-swap-app:durable-20260928 --format '{{.Id}} {{.Architecture}}'
```

The result must be
`sha256:fb52657c69671b28006e9bf87227c50a49c913061287b4d48cac10f2338c9052 arm64`.
The archive is a local artifact, not a registry release. On AMD64, build a matching candidate
for that platform or wait for the published multi-architecture image.

Set these environment variables for your backend before running Compose:

| Variable | Required value |
| --- | --- |
| `CANDIDATE_NETWORK` | `mainnet`, `regtest`, `testnet`, or `signet`; match LND and Electrum |
| `CANDIDATE_BACKEND_NETWORK` | Existing Docker network where the backend is reachable |
| `CANDIDATE_LND_HOST` | LND hostname or IP reachable from that network, covered by its TLS certificate |
| `CANDIDATE_LND_DIR` | Absolute host directory containing `tls.cert` and `data/chain/bitcoin/<network>/admin.macaroon` |
| `CANDIDATE_ELECTRUM_HOST` | Electrum hostname or IP reachable from that network |
| `CANDIDATE_ELECTRUM_PORT` | Electrum TCP port, default `50001` |

`CANDIDATE_LND_PORT` defaults to `10009`; `CANDIDATE_PORT` defaults to `53010`.
Use the daemon's `mainnet` directory name for Bitcoin mainnet macaroons. Container UID 1000 must
be able to read the mounted LND credentials. The mount is read-only. Do not make credentials
world-readable to resolve an access error.

Validate configuration, then start only the candidate dashboard:

```sh
docker compose -f docker/compose.local.yml config --quiet
docker compose -f docker/compose.local.yml up -d --pull never
```

Open `http://127.0.0.1:53010`, adjusted if you selected another port. For a remote or headless Docker
host, first run this on the laptop where you will open the browser, substituting your SSH login:

```sh
ssh -N -L 53010:127.0.0.1:53010 USER@DOCKER_HOST
```

Keep that connection open while using the dashboard. This preserves its loopback-only binding.
This instance stores settings,
identity and all recovery records in `pubky-swap-candidate_candidate-data`, mounted at `/data`.
It does not reuse an installed Umbrel app's volume. If a control action is refused, inspect the
reported source address and set `CANDIDATE_CONTROL_PLANE_ALLOW` to that exact local proxy or
gateway address, then recreate the candidate. Do not use a wildcard.

Choose the provider role, import an existing registered Pubky identity, confirm the displayed
public key, configure the backend and fees, then start the provider. Wait for its live identity
and network before using **Overview > Connect**. The complete backend and wallet must have the
liquidity needed for the chosen swap direction.

For Bitkit, install the matching mainnet or regtest APK and the matching-certificate Ring APK.
Before funding a regtest wallet, set Bitkit's Electrum endpoint to the same isolated chain as the
provider. Its default dev endpoint points to shared staging infrastructure. A regtest QR does
not change Electrum or open a Lightning channel. For a local Android emulator, a host port is
normally reached through `10.0.2.2`; a physical phone needs an endpoint it can reach. Establish
a Lightning route with adequate outbound liquidity before a Lightning-to-on-chain swap.

Scan **Overview > Connect**, select the intended identity in Ring when prompted, and use the
Savings transfer or supported payment flow. See [the integration record](DURABLE_INTEGRATION.md)
for completed validation and remaining limits.

To stop this instance while retaining recovery state:

```sh
docker compose -f docker/compose.local.yml stop
```

Keep the complete data volume while swaps or channels require recovery. A future community-store
update will require publishing the candidate and updating the manifest to its actual digest.
