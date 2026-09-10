# Pubky Swap: an Umbrel community app store

Run a self-hosted **Lightning to on-chain swap provider** on your own node.

[Pubky Swap](https://github.com/coreyphillips/pubky-swap) advertises **submarine** (on-chain to
Lightning) and **reverse** (Lightning to on-chain) swaps at the rates you set, and facilitates them
using **your Umbrel's own LND node and Electrs**. There is no central swap server: discovery and
negotiation ride on the [Pubky](https://pubky.org) network.

> ⚠️ **Early software, not yet audited.** The swap engine is implemented and tested end-to-end on
> regtest against real LND, and every fund-touching path has regression tests that fail without
> their fix. It has **not** had a third-party security review. Atomic-swap bugs can lose funds.
> Start with small limits and only risk what you can afford to lose.

## Install

In umbrelOS, go to the App Store, open the menu (top right), choose **Community App Stores**, and
add:

```
https://github.com/coreyphillips/pubky-swap-umbrel
```

Then install **Pubky Swap** from the Pubky store that appears.

## Electrs, Fulcrum or ElectrumX

Any of the three, and none of them is required to install. Pick yours in the app: there is a
one-click button for each of Umbrel's Electrum apps, or type in a server of your own.

The app deliberately declares no dependency on `electrs`. Fulcrum and ElectrumX both say
`implements: electrs`, and recent umbrelOS will offer them as alternatives, but an older one
refuses to install without Electrs itself. Umbrel's app network is shared, so the app reaches
whichever server you run without needing to declare it.

They do not agree on the port, which is the detail worth knowing if you set one by hand: Electrs
and ElectrumX listen on 50001, Fulcrum on 50002.

The swap engine speaks plain Electrum protocol and nothing beyond it: script history and
unspents, transaction get and broadcast, block headers, and `estimatefee`. The full HTLC engine,
reorg detection and funding-wallet test suites run green against a real Fulcrum as well as
against Electrs.

## What the app does

A tabbed control panel that supervises the swap daemons.

**Overview** answers three things at a glance: whether the node is healthy, how much of your money
is committed, and whether anything is stuck. **Earn** holds your rates, what you have earned, and
your offer rendered the way a counterparty sees it. **Swap** is the other side of the table: paste
someone's pubky, get a quote, and swap your own funds. **Activity** is every swap, yours and the
ones you served. **Settings** holds your identity, chain access, the diagnostics report and the
daemon's log.

Setting it up:

1. Open the app. It asks what you want to use this for **before** anything else. If you only want
   to swap your own funds, nothing is ever advertised on your behalf.
2. Load your **Pubky identity**: paste its recovery phrase, or upload its `.pkarr` recovery file.
   It has to be an identity that already exists, created in
   [Pubky Ring or pubky.app](https://pubky.app): the app signs in to your identity's homeserver
   and cannot create one, so a phrase you make up has no account behind it.
3. It **checks your node** before anything starts, and shows you the pubky you just loaded so you
   can recognise it. A wrong passphrase does not fail; it quietly derives a different identity,
   and that screen is the only place you would notice.
4. Set your fees and limits, and share the pubky with anyone who wants to swap with you.

Your fee is `base_fee + amount x fee_ppm / 1_000_000`, and the miner fee is quoted on top at cost.

### The advertised minimum is not always the one you set

The engine never advertises a swap smaller than ten times its own on-chain cost, because below
that the fee is most of the trade. That floor is re-priced against a live fee estimate, so at
5 sat/vB it is around 11,500 sat and at 45 sat/vB it is over 100,000. The panel shows the number
actually being advertised, and says so when your configured minimum is not it.

### Where your swap records live

`${APP_DATA_DIR}/data/client/swaps` holds the records for swaps **you** took. A submarine swap's
refund key is generated there and exists nowhere else in the world. Losing it does not fail the
swap; it makes the on-chain output unspendable by anyone, forever. The app will not delete those
records, resumes any it finds still open when it starts, and says so before you do anything that
would remove them.

## Two things worth knowing

**Your seed never reaches a command line.** The recovery phrase is written to a file inside the
app's own data volume, readable only by the app, and the daemon is told the path rather than the
value. Anything that can read the process table on a node can read a process's arguments, so a
seed passed as one is a seed shared with every other app on the box.

**Another app on your Umbrel cannot change your settings.** Every app on an Umbrel shares one
Docker network, so any of them can reach this app's port. The guard here used to accept the whole
private range, which is every one of them: I put two of these containers on a network and had the
second POST `{"action":"clear"}` at the first, and the first app's Pubky identity was gone.

Changes are now accepted only from loopback and the gateway umbrelOS proxies through, which is not
an address another container can present as its own. Reading is deliberately left open: the status
view holds no secret, and gating it would mean that if the allow list were ever wrong you would
meet a blank page instead of the message telling you what to fix. Set `CONTROL_PLANE_ALLOW` on the
container if your setup proxies from somewhere else; the app names the address for you.

**The dashboard asks the daemon, it does not read its logs.** The provider serves a read-only
status API on loopback, and the panel calls it. Deciding whether a daemon is healthy by matching
patterns against its log output works until a message is reworded, and then fails quietly in
whichever direction happens to be wrong.

## Repository layout

```
umbrel-app-store.yml     the community store itself (id: pubky)
pubky-swap/              the app: manifest, compose file, icon
docker/                  Dockerfile and entrypoint for the published image
web/                     the control panel this image runs
  server.js              wiring: env, routes, listen, shut down
  lib/                   everything with a decision in it
  public/                the panel itself: one stylesheet, ES modules, no build step
  test/                  node --test, no dependencies
.github/workflows/       multi-arch image build, and the release guard
```

## Releasing

The app is installed straight from `main`, so `main` must never name an image that does not exist:
an Umbrel that syncs the store would try to pull it, fail, and hang on "Starting" with nothing to
explain why. `check-release.yml` enforces that by requiring the compose file to name the image by
digest, which cannot be known before the build publishes it.

So a release is three steps:

1. Merge the code, leaving `version` in `umbrel-app.yml` and the image line alone.
2. Push a tag (`v0.2.0`). `build-image.yml` resolves `main` to a commit, builds each architecture
   on a runner of that architecture, stitches them into one manifest list, and prints the exact
   `image:` line to use, digest included, alongside the pubky-swap commit it was built from.
3. Open a second PR bumping `version` and the image tag and digest together. That is the only
   commit that changes what Umbrel installs, and it cannot merge until the thing it names is real.

## Building locally

```bash
docker build -f docker/Dockerfile -t pubky-swap-app:dev .
```

The image compiles `swap-provider` and `swap-client` from
[pubky-swap](https://github.com/coreyphillips/pubky-swap) with `--features full,beignet`, so an
operator can point the provider at a [beignet](https://github.com/coreyphillips/beignet) daemon
instead of LND without a different image. `PUBKY_SWAP_REF` selects the upstream commit.

## Running the tests

```bash
cd web && npm test
```

No dependencies and no runner to install. The suite is deliberately small: it locks the handful of
behaviours where a regression would cost money or leak a secret, rather than aiming at coverage.

## License

MIT
