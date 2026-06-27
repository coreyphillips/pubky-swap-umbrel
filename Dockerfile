# ---- Stage 1: build the pubky-swap provider binary ----
FROM rust:1-bookworm AS rust-build

# protoc is needed to compile the LND gRPC backend (feature `lnd`).
RUN apt-get update && apt-get install -y --no-install-recommends protobuf-compiler git \
    && rm -rf /var/lib/apt/lists/*

# Which pubky-swap to build (override at build time if needed).
ARG PUBKY_SWAP_REPO=https://github.com/coreyphillips/pubky-swap.git
ARG PUBKY_SWAP_REF=main

WORKDIR /src
RUN git clone --depth 1 --branch "${PUBKY_SWAP_REF}" "${PUBKY_SWAP_REPO}" .
# Build both the provider (advertise/serve swaps) and the client (swap as a taker).
RUN cargo build --release -p swap-provider -p swap-client --features full
RUN cp target/release/swap-provider /usr/local/bin/swap-provider \
    && cp target/release/swap-client /usr/local/bin/swap-client

# ---- Stage 2: Node control server + the provider binary ----
FROM node:20-bookworm-slim

# ca-certificates for outbound TLS; the provider binary is dynamically linked against glibc
# (provided by the bookworm base).
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY --from=rust-build /usr/local/bin/swap-provider /usr/local/bin/swap-provider

WORKDIR /app
COPY web/package*.json ./
RUN npm install --omit=dev
COPY web/ ./

# /data is the persistent volume (config + identity + swap state).
ENV DATA_DIR=/data \
    SWAP_PROVIDER_BIN=/usr/local/bin/swap-provider \
    PORT=3000

EXPOSE 3000
CMD ["node", "server.js"]
