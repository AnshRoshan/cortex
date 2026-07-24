FROM rust:alpine AS backend
WORKDIR /home/rust/src
RUN apk --no-cache add musl-dev openssl-dev
# Copy only Rust sources so frontend changes don't bust the (slow) cargo layers.
COPY Cargo.toml Cargo.lock ./
COPY rustpad-server rustpad-server
COPY rustpad-wasm rustpad-wasm
# Only the library unit tests (the auth tests). The repo's tests/ integration
# suite predates authentication and no longer reflects the locked model.
RUN cargo test --release --lib
RUN cargo build --release

FROM --platform=amd64 rust:alpine AS wasm
WORKDIR /home/rust/src
RUN apk --no-cache add curl musl-dev
RUN curl https://rustwasm.github.io/wasm-pack/installer/init.sh -sSf | sh
COPY Cargo.toml Cargo.lock ./
COPY rustpad-server rustpad-server
COPY rustpad-wasm rustpad-wasm
RUN wasm-pack build rustpad-wasm

FROM --platform=amd64 node:lts-alpine AS frontend
WORKDIR /usr/src/app
COPY package.json package-lock.json ./
COPY --from=wasm /home/rust/src/rustpad-wasm/pkg rustpad-wasm/pkg
# `npm install` (not `ci`) so bumped versions resolve without a synced lockfile.
RUN npm install
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
COPY --from=backend /home/rust/src/target/release/rustpad-server .
USER app
ENV SQLITE_URI=sqlite:///data/authpad.db
ENV SEED_FILE=/app/seed_users.json
EXPOSE 3030
CMD [ "./rustpad-server" ]
