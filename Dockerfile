# syntax=docker/dockerfile:1
FROM rust:alpine AS backend
WORKDIR /home/rust/src
RUN apk --no-cache add musl-dev openssl-dev
# Copy only Rust sources so frontend changes don't bust the (slow) cargo layers.
COPY Cargo.toml Cargo.lock ./
COPY rustpad-server rustpad-server
COPY rustpad-wasm rustpad-wasm
# Cache the compiled target/ dir across builds so only changed crates recompile
# (turns a ~20-min from-scratch build into a ~1-3 min incremental one — the cost
# is compilation, not downloads). We deliberately do NOT cache the cargo registry:
# the corp network truncates crates.io downloads and a cache mount would persist a
# corrupt crate. target/ is a cache mount (not in the image), so copy the binary
# out in the same RUN. No tests here — deploy builds ship the binary; run
# `cargo test` locally / in CI, not on the prod box.
RUN --mount=type=cache,id=cargo-target-backend,target=/home/rust/src/target \
    cargo build --release \
    && cp target/release/rustpad-server /rustpad-server

FROM --platform=amd64 rust:alpine AS wasm
WORKDIR /home/rust/src
RUN apk --no-cache add curl musl-dev
RUN curl https://rustwasm.github.io/wasm-pack/installer/init.sh -sSf | sh
COPY Cargo.toml Cargo.lock ./
COPY rustpad-server rustpad-server
COPY rustpad-wasm rustpad-wasm
# pkg/ is written outside target/, so it survives the cached-target RUN.
# Distinct cache id from the backend stage: the two stages build in parallel and
# a shared target/ dir made them fight over a file lock and churn each other's
# fingerprints, forcing a full recompile every time. Separate caches = each stays
# warm and only changed crates rebuild.
RUN --mount=type=cache,id=cargo-target-wasm,target=/home/rust/src/target \
    wasm-pack build rustpad-wasm

FROM --platform=amd64 node:lts-alpine AS frontend
WORKDIR /usr/src/app
COPY package.json package-lock.json ./
COPY --from=wasm /home/rust/src/rustpad-wasm/pkg rustpad-wasm/pkg
# `npm install` (not `ci`) so bumped versions resolve without a synced lockfile.
RUN --mount=type=cache,target=/root/.npm npm install
COPY . .
RUN npm run check
RUN npm run build

# Alpine (not scratch) so we get a writable data dir, CA certs, and a real user.
FROM alpine AS runtime
RUN apk --no-cache add ca-certificates \
    && adduser -D -u 1000 app \
    && mkdir -p /data && chown app /data
WORKDIR /app
COPY --from=frontend /usr/src/app/dist dist
COPY --from=backend /rustpad-server .
USER app
ENV SQLITE_URI=sqlite:///data/authpad.db
EXPOSE 3030
CMD [ "./rustpad-server" ]
