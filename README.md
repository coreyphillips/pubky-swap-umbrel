# Pubky Swap — Umbrel app

Run a self-hosted **Lightning↔on-chain swap provider** on your own node. Pubky Swap advertises
**submarine** (on-chain → Lightning) and **reverse** (Lightning → on-chain) swaps at the rates you
set, and facilitates them using **your Umbrel's own LND node and Electrs** — no central server.
Discovery/negotiation ride on the [Pubky](https://pubky.org) network.

> ⚠️ **Early, unaudited software.** The swap engine ([`pubky-swap`](https://github.com/coreyphillips/pubky-swap))
> is implemented and tested (including end-to-end on regtest against real LND), but it has **not** had
> a third-party security review and mainnet hardening is ongoing. Atomic-swap bugs can lose funds.
> Start with small limits and only risk what you can afford to lose.

## How it works

This app is a small web control panel that **supervises the `swap-provider` daemon**:

1. Open the app, paste your **Pubky recovery phrase**, set your **rates/limits**, and hit
   **Save & start**.
2. The provider connects to your Umbrel's LND + Electrs and begins advertising. Reverse swaps are
   funded directly from **LND's own on-chain balance** (`--wallet lnd`) — no separate seed to set up
   or back up; just keep some on-chain liquidity in LND.
3. The status panel shows your **Pubky** — share it with anyone who wants to swap with you.

Your fee is `base_fee + amount × fee_ppm / 1_000_000` (e.g. `1000 sat + 2000 ppm` = `1200 sat` on a
100k-sat swap).

## Swap as a taker

The **Swap with a provider** panel turns it around: paste someone else's Pubky to **check** whether
they're a live provider and see their rates (a quote request — no funds move), then **swap your own
funds in or out**. Both legs are funded/claimed via your LND wallet (`--wallet lnd`), so there's
nothing extra to configure. Identity (recovery phrase or `.pkarr`) is the one you already loaded.

## Dependencies (Umbrel apps)

Declared in `umbrel-app.yml`:

- **`lightning`** — your LND node. The app reads `tls.cert` + `admin.macaroon` from the mounted LND
  data dir and connects to gRPC at `${APP_LIGHTNING_NODE_IP}:${APP_LIGHTNING_NODE_GRPC_PORT}`.
- **`electrs`** — chain access, at `${APP_ELECTRS_NODE_IP}:50001`.

## Build & run locally

The image builds the `swap-provider` binary from the public pubky-swap repo, then runs it under the
Node control server. To test outside Umbrel, supply the connection variables the Umbrel app proxy
would normally inject:

```bash
docker compose build
APP_LIGHTNING_NODE_IP=10.21.0.x APP_LIGHTNING_NODE_GRPC_PORT=10009 \
APP_LIGHTNING_NODE_DATA_DIR=/path/to/lnd \
APP_ELECTRS_NODE_IP=10.21.0.y \
APP_DATA_DIR=$PWD/.appdata \
  docker compose up
# then open http://localhost:3000
```

Build args (Dockerfile): `PUBKY_SWAP_REPO` / `PUBKY_SWAP_REF` pin which pubky-swap to build.

### Publishing for the Umbrel store

Umbrel runs on arm64 (Raspberry Pi) and amd64, so publish a **multi-arch** image and replace
`build: .` in `docker-compose.yml` with the published `image:`:

```bash
docker buildx build --platform linux/amd64,linux/arm64 \
  -t ghcr.io/coreyphillips/pubky-swap-umbrel:0.1.0 --push .
```

## Configuration & data

- Your settings + Pubky identity are stored in the app's persistent volume
  (`${APP_DATA_DIR}/data/config.json`, mode `0600`); in-flight swaps live in `…/data/swap/`. The
  on-chain funding wallet is LND's, so there's no extra seed stored here.
- Network defaults to `bitcoin` (Umbrel mainnet). On mainnet the provider refuses unsafe parameters
  (low confirmations / fee floor) unless you tick **Allow unsafe** (testing only).

## ⚠️ Verify on your Umbrel

This app was built against the documented Umbrel conventions but has **not yet been run on a live
umbrelOS install**. The most likely things to confirm/adjust:

- The exact dependency variables (`APP_LIGHTNING_NODE_IP`, `APP_LIGHTNING_NODE_GRPC_PORT`,
  `APP_LIGHTNING_NODE_DATA_DIR`, `APP_ELECTRS_NODE_IP`) and the LND data-dir layout.
- LND TLS: the cert must be valid for the IP the app dials (Umbrel's `tlsextraip` usually covers the
  app network; if you see a cert error, that's the cause).
- This compose publishes the control-panel port directly (mirroring the bitcoin-regtest-dashboard
  reference app). If your umbrelOS expects an `app_proxy` service instead, add one pointing at
  `APP_HOST: pubky-swap_server_1`, `APP_PORT: 3000`.

If something's off on a real install, capture the app logs and the issue is almost certainly one of
the above.

## License

MIT
