# The Pubky Swap Umbrel app: the swap binaries, plus the small Node server that supervises them.
#
# Built for linux/amd64 and linux/arm64 by .github/workflows/build-image.yml and published to
# ghcr on tag. Nothing is compiled on the user's node.

# ---- Stage 1: the swap binaries ----
FROM rust:1-bookworm AS rust-build

# protoc compiles LND's protobufs (feature `lnd`). Everything else the build needs is in the base.
RUN apt-get update && apt-get install -y --no-install-recommends protobuf-compiler git \
    && rm -rf /var/lib/apt/lists/*

ARG PUBKY_SWAP_REPO=https://github.com/coreyphillips/pubky-swap.git
# Pinned by the release build to the exact commit an app version was cut from, so an image can be
# rebuilt byte-for-byte from its tag rather than from whatever main happened to be.
ARG PUBKY_SWAP_REF=main

WORKDIR /src
# Fetched by ref rather than cloned by branch, so PUBKY_SWAP_REF can be a commit SHA as well as a
# branch or tag. A release wants the SHA: a tag can be moved, and an image that cannot say exactly
# what it was built from cannot be audited after the fact.
RUN git init -q . \
    && git remote add origin "${PUBKY_SWAP_REPO}" \
    && git fetch --depth 1 origin "${PUBKY_SWAP_REF}" \
    && git checkout -q FETCH_HEAD \
    && git --no-pager log -1 --format='building pubky-swap %H (%cs)'

# `full` is LND + Electrum + the BDK funding wallet + the status API the dashboard reads.
# `beignet` is built in too, so an operator can point the provider at a beignet daemon instead of
# LND without needing a different image.
RUN cargo build --release -p swap-provider -p swap-client --features full,beignet \
    && cp target/release/swap-provider /usr/local/bin/swap-provider \
    && cp target/release/swap-client /usr/local/bin/swap-client \
    && strip /usr/local/bin/swap-provider /usr/local/bin/swap-client

# ---- Stage 2: the runtime ----
FROM node:20-bookworm-slim

# ca-certificates for outbound TLS; gosu to drop privileges in the entrypoint. The binaries are
# dynamically linked against the glibc in this base.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates gosu \
    && rm -rf /var/lib/apt/lists/*

COPY --from=rust-build /usr/local/bin/swap-provider /usr/local/bin/swap-provider
COPY --from=rust-build /usr/local/bin/swap-client /usr/local/bin/swap-client

WORKDIR /app
COPY web/package*.json ./
RUN npm install --omit=dev
COPY web/ ./
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

ENV DATA_DIR=/data \
    SWAP_PROVIDER_BIN=/usr/local/bin/swap-provider \
    SWAP_CLIENT_BIN=/usr/local/bin/swap-client \
    PORT=3000

EXPOSE 3000
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
