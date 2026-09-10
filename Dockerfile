# ---- Stage 1: build the pubky-swap binaries ----
FROM rust:1-bookworm AS rust-build

# protoc is needed to compile the LND gRPC backend (feature `lnd`).
RUN apt-get update && apt-get install -y --no-install-recommends protobuf-compiler git \
    && rm -rf /var/lib/apt/lists/*

# Which pubky-swap to build.
#
# Pinned to a commit rather than a branch: `main` means a rebuild months from now produces a
# different app than the one that was tested, and an Umbrel install rebuilt on a new machine would
# silently differ from the one that was verified.
ARG PUBKY_SWAP_REPO=https://github.com/coreyphillips/pubky-swap.git
ARG PUBKY_SWAP_REF=5192e63227bec3bf03166f9007681180bdd1fbf6

WORKDIR /src
# Fetched by ref rather than cloned with `--branch`, which only accepts a branch or tag name and
# would reject the commit this is pinned to. A single-commit fetch, so pinning costs no more than
# a shallow clone did.
RUN git init -q . \
    && git remote add origin "${PUBKY_SWAP_REPO}" \
    && git fetch -q --depth 1 origin "${PUBKY_SWAP_REF}" \
    && git checkout -q FETCH_HEAD
# The provider advertises and serves swaps; the client swaps this node's own funds.
RUN cargo build --release -p swap-provider -p swap-client --features full
RUN cp target/release/swap-provider target/release/swap-client /usr/local/bin/

# The whole panel is built on the provider's status API, which lives behind the `status` feature.
# Assert it is present here, so a feature regression upstream fails the build rather than shipping
# an app whose dashboard silently has nothing to read.
RUN /usr/local/bin/swap-provider --help | grep -q -- '--status-addr' \
    && /usr/local/bin/swap-client --help | grep -q -- '--resume-only'

# ---- Stage 2: the Node control server, and both binaries ----
FROM node:20-bookworm-slim

# ca-certificates for outbound TLS; gosu to drop privileges after fixing up /data ownership.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates gosu \
    && rm -rf /var/lib/apt/lists/*

COPY --from=rust-build /usr/local/bin/swap-provider /usr/local/bin/swap-provider
COPY --from=rust-build /usr/local/bin/swap-client   /usr/local/bin/swap-client

WORKDIR /app
COPY web/package*.json ./
COPY web/ ./
# One source of truth for the icon: umbrel-app.yml points at it in the repo root, and the panel
# serves it as its favicon.
COPY icon.svg /app/public/icon.svg
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# /data is the persistent volume: settings, secrets, and in-flight swap records.
ENV DATA_DIR=/data \
    SWAP_PROVIDER_BIN=/usr/local/bin/swap-provider \
    SWAP_CLIENT_BIN=/usr/local/bin/swap-client \
    PORT=3000

EXPOSE 3000
ENTRYPOINT ["/entrypoint.sh"]
