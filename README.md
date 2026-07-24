# Cortex

**Cortex** is a private, authenticated, multi-file collaborative workspace. It
presents as an AI workspace on the surface; behind a locked login it is a
real-time collaborative code editor (Monaco + operational transformation).

Built on top of [Rustpad](https://github.com/ekzhang/rustpad)'s OT engine, with
a closed authentication layer, workspaces, multi-file editing, and admin-only
file upload/download added on top.

## Key properties

- **Closed by default.** No signup. Users exist only by backend seeding. Every
  data route (documents, the collaborative socket, stats) requires a valid
  session; nothing is reachable anonymously.
- **Roles.** `admin` owns a workspace, adds members, and is the only role that
  can upload/download files. Regular `user`s can open and edit files
  collaboratively.
- **Multi-file, multi-user.** Each file is its own OT document; many users edit
  the same file in real time with live cursors.
- **SQLite** for users, sessions, workspaces, files, and document content.

## Prerequisites

- Rust toolchain (`rustup`) **with a C compiler/linker** — on Windows install
  the "Desktop development with C++" workload (provides `link.exe`); SQLite and
  crypto crates compile C.
- `wasm-pack` (`npm i -g wasm-pack`) and the `wasm32-unknown-unknown` target
  (`rustup target add wasm32-unknown-unknown`).
- Node.js + npm.

## Configure

Copy `seed_users.example.json` to `seed_users.json` and set real credentials.
This is the **only** way accounts are created:

```json
[
  { "email": "you@example.com", "password": "a-strong-password", "role": "admin" }
]
```

`.env` controls `SQLITE_URI` (defaults to `sqlite://authpad.db`), `SEED_FILE`,
and `PORT`.

## Run with Docker (recommended — no host toolchain needed)

### Fast dev loop (use this while building)

```bash
docker compose -f docker-compose.dev.yml up
# → open http://localhost:5173
```

- **Frontend hot-reloads** — edit a `.tsx`, the browser updates instantly, no rebuild.
- **Backend auto-recompiles** on Rust changes (cargo-watch, debug build).
- Cargo registry, build cache, `node_modules`, and the wasm package are cached in
  volumes, so only the **first** `up` is slow; every run after is fast.

### Production image (single self-contained container)

```bash
docker compose up --build
# → open http://localhost:3030
```

Stop one before starting the other — both use port 3030.

Sign in with a seeded account (see `seed_users.json`). An admin creates the
workspace, adds members, and manages files; members join and edit.

## Build without Docker

```bash
(cd rustpad-wasm && wasm-pack build)   # WebAssembly OT core
npm install && npm run build           # frontend
cargo run --release --manifest-path rustpad-server/Cargo.toml
```

Requires a Rust toolchain with a C compiler/linker (on Windows: the VS "Desktop
development with C++" workload), `wasm-pack`, and the `wasm32-unknown-unknown`
target.

## Tests

```bash
cargo test --manifest-path rustpad-server/Cargo.toml auth   # auth unit tests
```

> Note: the original Rustpad integration tests under `rustpad-server/tests/`
> predate authentication and assume open access; they need updating for the
> locked model.
