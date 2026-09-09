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

## What the app does

It is a small web control panel that supervises the `swap-provider` daemon.

1. Open the app and load your **Pubky identity**: paste its recovery phrase, or upload its
   `.pkarr` recovery file. It has to be an identity that already exists, created in
   [Pubky Ring or pubky.app](https://pubky.app): the app signs in to your identity's homeserver
   and cannot create one, so a phrase you make up has no account behind it and the provider will
   not start.
2. Set your **fees, amount limits and exposure limits**.
3. Save. The provider starts, advertises your offer, and serves swaps against your LND and Electrs.
4. Share the **Pubky it prints** with anyone who wants to swap with you.

The dashboard shows what the daemon reports about itself: which startup checks pass, what is in
flight, how much is committed against your limits, and what you have earned.

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

## License

MIT
