# Pubky Swap - Umbrel app

Run a self-hosted **Lightning to on-chain swap provider** on your own node. Pubky Swap advertises
**submarine** (on-chain to Lightning) and **reverse** (Lightning to on-chain) swaps at the rates you
set, and facilitates them using **your Umbrel's own LND node and Electrs**. There is no central swap
server; discovery and negotiation ride on the [Pubky](https://pubky.org) network.

> **Early, unaudited software.** The swap engine ([`pubky-swap`](https://github.com/coreyphillips/pubky-swap))
> is implemented and tested, including end to end on regtest against real LND, but it has not had a
> third-party security review. A bug in an atomic swap can lose money. Start with small limits and
> only risk what you can afford to lose.

## What the panel does

A tabbed control panel that supervises two binaries from the swap engine.

**Overview** answers three things at a glance: whether the node is healthy, how much of your money
is committed, and whether anything is stuck. **Earn** holds your rates, what you have earned, and
your offer rendered the way a counterparty sees it. **Swap** is the other side of the table: paste
someone's pubky, get a quote, and swap your own funds. **Activity** is every swap, yours and the
ones you served, with an honest progress track. **Settings** holds your identity, the diagnostics
report and the daemon's log.

Nothing here is read out of the daemon's log output. The provider serves a read-only status API on
loopback, and the panel reads that. Log lines are still shown, as something to read rather than as a
source of truth.

## Setting it up

Open the app and the guided setup asks, in order: the risk you are taking on, what you want to use
this for, your Pubky identity, and then it checks your node before anything starts.

**You need a Pubky identity that already exists.** This app signs in with one; it cannot create one.
Generate it in a Pubky app first, then paste the recovery phrase or upload the `.pkarr` file.

**Choosing a role matters.** If you only want to swap your own funds, choose "move my own funds" and
no provider ever runs. The earlier version of this app started advertising as soon as you saved an
identity, whether or not you wanted to.

Your fee is `base_fee + amount x fee_ppm / 1_000_000`, and the miner fee is quoted on top at cost.

### The advertised minimum is not always the one you set

The engine never advertises a swap smaller than ten times its own on-chain cost, because below that
the fee is most of the trade. That floor is re-priced against a live fee estimate, so at 5 sat/vB it
is around 11,500 sat and at 45 sat/vB it is over 100,000. The panel shows the number actually being
advertised, and says when your configured minimum is not it.

## Dependencies

Declared in `umbrel-app.yml`:

- **`lightning`** - your LND node. The app reads `tls.cert` and `admin.macaroon` from the mounted
  LND data dir and connects to gRPC at `${APP_LIGHTNING_NODE_IP}:${APP_LIGHTNING_NODE_GRPC_PORT}`.
- **`electrs`** - chain access, at `${APP_ELECTRS_NODE_IP}:50001`.

Reverse swaps are funded from LND's own on-chain balance, so there is no second seed to back up.
Keep some on-chain liquidity in LND.

## Where things are kept

Everything lives on the app's persistent volume, under `${APP_DATA_DIR}/data`:

| Path | What it holds |
|---|---|
| `settings.json` | rates, limits and preferences. Never secrets |
| `secrets/` | the recovery phrase, passphrase or `.pkarr`, at `0600` in a `0700` directory |
| `swap/` | the provider's config, its status token, and its swap records |
| `client/swaps/` | **your own swaps' records** |

The last one is worth knowing about. A submarine swap's refund key is generated into that directory
and exists nowhere else in the world. Losing it does not fail the swap; it makes the on-chain output
unspendable by anyone, forever. The panel will not delete those records, and it says so before you
do anything that would.

Secrets never reach the process table: the engine is told the *path* to a secret file, never its
value, which is why the recovery phrase has no command-line flag.

## Build and run locally

```bash
docker compose -f docker-compose.dev.yml up --build
# then open http://localhost:3737
```

The dev compose exists because the real one declares Umbrel's `app_proxy`, which umbrelOS provides
and which has no image anywhere else. Point it at whatever LND and Electrs you are testing against
with `LND_IP`, `LND_GRPC_PORT`, `LND_DATA_DIR`, `ELECTRS_IP`, `ELECTRS_PORT` and `NETWORK`.

For a regtest backplane, `pubky-swap` ships `docker-compose.regtest.yml` and
`scripts/setup-regtest-lnd.sh`; both take container-name and port overrides, so they can run
alongside a stack you already have.

Build args pin which engine is built: `PUBKY_SWAP_REPO` and `PUBKY_SWAP_REF`. Pin `PUBKY_SWAP_REF`
to a commit for a release, or a rebuild months from now produces a different app than the one that
was tested.

### Publishing for the Umbrel store

Umbrel runs on arm64 and amd64, so publish a multi-arch image and replace `build: .` in
`docker-compose.yml` with the published `image:`:

```bash
docker buildx build --platform linux/amd64,linux/arm64 \
  -t ghcr.io/coreyphillips/pubky-swap-umbrel:0.2.0 --push .
```

## Running the tests

```bash
cd web && npm test
```

No dependencies and no test runner to install. The suite is small on purpose: it locks the handful
of behaviours where a regression would cost money or leak a secret, rather than aiming at coverage.

## Not yet verified on a live umbrelOS install

This app was built against the documented Umbrel conventions. Three things to confirm on real
hardware:

- Whether `app_proxy` buffers `text/event-stream`. The panel uses server-sent events, and falls back
  to polling on its own if the stream keeps dropping, so a buffering proxy degrades rather than
  breaks. Worth knowing which path you are on.
- Whether UID 1000 can read the LND certificate and macaroon through the read-only mount. The
  container drops privileges after fixing up `/data`; if it cannot read them, that has to change.
- The exact `APP_*` variable names and the LND data-dir layout for your umbrelOS version.

LND's TLS certificate must be valid for the address the app dials. Umbrel's `tlsextraip` usually
covers the app network; a certificate error on startup is almost always this.

## License

MIT
