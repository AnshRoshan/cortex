//! Authentication: seeded users, password hashing, server-side sessions.
//!
//! Users are created only by backend seeding (see [`seed_from_file`]). There is
//! no signup route. Every data route is gated behind a valid session cookie.

use std::time::{SystemTime, UNIX_EPOCH};

use log::{info, warn};
use rand::RngCore;
use serde::Deserialize;
use serde_json::json;
use warp::{
    http::StatusCode, reject::Reject, reply::Reply, Filter, Rejection,
};

use crate::database::{Database, User};

/// Name of the HttpOnly session cookie.
const SESSION_COOKIE: &str = "authpad_session";
/// Session lifetime in seconds (7 days).
const SESSION_MAX_AGE: i64 = 7 * 24 * 3600;

/// Rejection used when a request lacks a valid session.
#[derive(Debug)]
pub struct Unauthorized;
impl Reject for Unauthorized {}

/// Rejection used when an authenticated user lacks permission for an action.
#[derive(Debug)]
pub struct Forbidden;
impl Reject for Forbidden {}

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("time before epoch")
        .as_secs() as i64
}

/// Hash a plaintext password with bcrypt.
pub fn hash_password(password: &str) -> anyhow::Result<String> {
    Ok(bcrypt::hash(password, bcrypt::DEFAULT_COST)?)
}

/// Constant-ish password check. Returns false on any error (bad hash, etc.).
pub fn verify_password(password: &str, hash: &str) -> bool {
    bcrypt::verify(password, hash).unwrap_or(false)
}

/// Generate a 256-bit random session token, hex-encoded.
fn random_token() -> String {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

#[derive(Deserialize)]
struct SeedUser {
    email: String,
    password: String,
    #[serde(default)]
    name: String,
    #[serde(default = "default_role")]
    role: String,
}

fn default_role() -> String {
    "user".to_string()
}

/// Seed users from a JSON file. This is the ONLY way users are created.
///
/// The file is backend-only and holds plaintext passwords that are hashed on
/// insert; existing emails are skipped, so editing a password there won't change
/// an existing account.
// ponytail: seed-on-startup from a file; matches the "DB-seeding only" rule
// without a separate CLI. Upgrade path: a `seed` subcommand if rotation matters.
pub async fn seed_from_file(db: &Database, path: &str) {
    let contents = match std::fs::read_to_string(path) {
        Ok(c) => c,
        Err(_) => {
            warn!("no seed file at {path:?}; no users will be created this run");
            return;
        }
    };
    let users: Vec<SeedUser> = match serde_json::from_str(&contents) {
        Ok(u) => u,
        Err(e) => {
            warn!("could not parse seed file {path:?}: {e}");
            return;
        }
    };
    for u in users {
        let hash = match hash_password(&u.password) {
            Ok(h) => h,
            Err(e) => {
                warn!("could not hash password for {}: {e}", u.email);
                continue;
            }
        };
        match db
            .create_user_if_absent(&u.email.trim().to_lowercase(), &u.name, &hash, &u.role, None)
            .await
        {
            Ok(true) => info!("seeded user {} ({})", u.email, u.role),
            Ok(false) => {} // already exists
            Err(e) => warn!("could not seed user {}: {e}", u.email),
        }
    }
}

#[derive(Deserialize)]
struct LoginReq {
    email: String,
    password: String,
}

/// A warp filter that requires a valid session and extracts the [`User`].
///
/// Rejects with [`Unauthorized`] when the cookie is missing, unknown, or expired.
pub fn with_auth(db: Database) -> impl Filter<Extract = (User,), Error = Rejection> + Clone {
    warp::cookie::optional(SESSION_COOKIE)
        .and(warp::any().map(move || db.clone()))
        .and_then(|token: Option<String>, db: Database| async move {
            let token = token.ok_or_else(|| warp::reject::custom(Unauthorized))?;
            match db.get_session_user(&token, now_secs()).await {
                Ok(Some(user)) => Ok(user),
                _ => Err(warp::reject::custom(Unauthorized)),
            }
        })
}

/// Public auth routes: `POST /api/login`, `POST /api/logout`, `GET /api/me`.
pub fn routes(
    db: Database,
) -> impl Filter<Extract = (impl Reply,), Error = Rejection> + Clone {
    let auth_db = db.clone();
    let db_filter = warp::any().map(move || db.clone());

    let login = warp::path!("login")
        .and(warp::post())
        .and(warp::body::json())
        .and(db_filter.clone())
        .and_then(login_handler);

    let logout = warp::path!("logout")
        .and(warp::post())
        .and(warp::cookie::optional(SESSION_COOKIE))
        .and(db_filter.clone())
        .and_then(logout_handler);

    let me = warp::path!("me")
        .and(warp::get())
        .and(with_auth(auth_db))
        .and_then(me_handler);

    login.or(logout).or(me)
}

async fn login_handler(body: LoginReq, db: Database) -> Result<impl Reply, Rejection> {
    // Email is case-insensitive and trimmed (stored lowercase).
    let email = body.email.trim().to_lowercase();
    let user = db.get_user_by_email(&email).await.ok().flatten();
    let authed = match &user {
        Some(u) => verify_password(&body.password, &u.password_hash),
        // Spend a real bcrypt on unknown emails so timing doesn't leak which
        // emails exist.
        None => {
            let _ = hash_password(&body.password);
            false
        }
    };
    if !authed {
        let reply = warp::reply::json(&json!({ "error": "invalid credentials" }));
        return Ok(warp::reply::with_status(reply, StatusCode::UNAUTHORIZED).into_response());
    }
    let user = user.expect("authed implies user present");
    let _ = db.purge_expired_sessions(now_secs()).await; // housekeeping
    let token = random_token();
    if db
        .create_session(&token, user.id, now_secs() + SESSION_MAX_AGE)
        .await
        .is_err()
    {
        let reply = warp::reply::json(&json!({ "error": "server error" }));
        return Ok(
            warp::reply::with_status(reply, StatusCode::INTERNAL_SERVER_ERROR).into_response(),
        );
    }
    // Set COOKIE_SECURE=1 when serving over HTTPS (i.e. any real deployment).
    let secure = if std::env::var("COOKIE_SECURE").is_ok() { "; Secure" } else { "" };
    let cookie = format!(
        "{SESSION_COOKIE}={token}; HttpOnly; SameSite=Strict; Path=/; Max-Age={SESSION_MAX_AGE}{secure}"
    );
    let reply = warp::reply::json(
        &json!({ "email": user.email, "name": user.name, "role": user.role }),
    );
    Ok(warp::reply::with_header(reply, "set-cookie", cookie).into_response())
}

async fn logout_handler(token: Option<String>, db: Database) -> Result<impl Reply, Rejection> {
    if let Some(t) = token {
        let _ = db.delete_session(&t).await;
    }
    let cleared = format!("{SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0");
    let reply = warp::reply::json(&json!({ "ok": true }));
    Ok(warp::reply::with_header(reply, "set-cookie", cleared).into_response())
}

async fn me_handler(user: User) -> Result<impl Reply, Rejection> {
    Ok(warp::reply::json(&json!({
        "email": user.email,
        "name": user.name,
        "role": user.role,
    })))
}

/// Convert [`Unauthorized`]/[`Forbidden`] rejections into JSON error responses.
pub async fn handle_rejection(err: Rejection) -> Result<impl Reply, Rejection> {
    if err.find::<Unauthorized>().is_some() {
        let reply = warp::reply::json(&json!({ "error": "unauthorized" }));
        return Ok(warp::reply::with_status(reply, StatusCode::UNAUTHORIZED));
    }
    if err.find::<Forbidden>().is_some() {
        let reply = warp::reply::json(&json!({ "error": "forbidden" }));
        return Ok(warp::reply::with_status(reply, StatusCode::FORBIDDEN));
    }
    Err(err)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn password_roundtrip() {
        let hash = hash_password("correct horse battery staple").unwrap();
        assert!(verify_password("correct horse battery staple", &hash));
        assert!(!verify_password("wrong password", &hash));
        // A malformed hash must never verify as true.
        assert!(!verify_password("anything", "not-a-real-hash"));
    }

    #[test]
    fn tokens_are_unique_and_long() {
        let a = random_token();
        let b = random_token();
        assert_eq!(a.len(), 64);
        assert_ne!(a, b);
    }
}
