//! Org / workspace / file / chat routes.
//!
//! Access model: a user may act within their assigned org; the root owner may
//! act within any org (passing `?org=<id>`). Any org member can create and open
//! every workspace in their org. Chat is org-wide.

use std::collections::HashMap;
use std::convert::Infallible;
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use bytes::Buf;
use futures::TryStreamExt;
use rand::RngCore;
use serde::Deserialize;
use serde_json::json;
use warp::multipart::{FormData, Part};
use warp::{http::StatusCode, hyper::Body, reply::Reply, Filter, Rejection};

use crate::auth::{with_auth, Forbidden};
use crate::crypto;
use crate::database::{ChatMessage, Database, PersistedDocument, ProviderRow, ReactionView, User, Workspace};

/// Filter extracting the client's ECDH public key header (present when the
/// client encrypts the payload).
fn epk_header() -> impl Filter<Extract = (Option<String>,), Error = Rejection> + Clone {
    warp::header::optional::<String>("x-cortex-epk")
}

/// Ephemeral "who is typing" state. In-memory only (single process): scope
/// string -> user_id -> last-typed unix time. ponytail: a process-global mutex
/// is plenty for one container; move to Redis only if this ever runs multi-node.
fn typing_state() -> &'static Mutex<HashMap<String, HashMap<i64, i64>>> {
    static S: OnceLock<Mutex<HashMap<String, HashMap<i64, i64>>>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(HashMap::new()))
}

/// A typist counts as "typing" for this many seconds after their last keystroke.
const TYPING_TTL: i64 = 6;

fn mark_typing(scope: String, user_id: i64, now: i64) {
    typing_state().lock().unwrap().entry(scope).or_default().insert(user_id, now);
}

/// Who (other than `exclude`) is currently typing in `scope`; also prunes stale entries.
fn who_typing(scope: &str, exclude: i64, now: i64) -> Vec<i64> {
    let mut g = typing_state().lock().unwrap();
    match g.get_mut(scope) {
        Some(m) => {
            m.retain(|_, t| now - *t < TYPING_TTL);
            m.keys().copied().filter(|&id| id != exclude).collect()
        }
        None => Vec::new(),
    }
}

/// Canonical scope key for a 1:1 conversation (order-independent).
fn dm_scope(a: i64, b: i64) -> String {
    let (lo, hi) = if a < b { (a, b) } else { (b, a) };
    format!("dm:{lo}:{hi}")
}

/// Serialize messages to JSON, folding each message's reactions in under a
/// `reactions` key. Kept out of the SQL struct because sqlx can't decode a
/// computed Vec field.
fn attach_reactions(
    messages: Vec<ChatMessage>,
    mut reactions: HashMap<i64, Vec<ReactionView>>,
) -> Vec<serde_json::Value> {
    messages
        .into_iter()
        .map(|m| {
            let r = reactions.remove(&m.id).unwrap_or_default();
            let mut v = serde_json::to_value(&m).unwrap_or_else(|_| json!({}));
            v["reactions"] = json!(r);
            v
        })
        .collect()
}

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("time before epoch")
        .as_secs() as i64
}

fn random_doc_id() -> String {
    let mut bytes = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

/// Normalize a virtual file path: forward slashes, no empty/`.`/`..` segments,
/// bounded length. Returns None if nothing valid remains.
fn clean_path(raw: &str) -> Option<String> {
    let joined = raw
        .replace('\\', "/")
        .split('/')
        .map(str::trim)
        .filter(|s| !s.is_empty() && *s != "." && *s != "..")
        .collect::<Vec<_>>()
        .join("/");
    (!joined.is_empty() && joined.len() <= 512).then_some(joined)
}

#[cfg(test)]
mod tests {
    use super::clean_path;

    #[test]
    fn clean_path_normalizes() {
        assert_eq!(clean_path("a/b.txt"), Some("a/b.txt".into()));
        assert_eq!(clean_path("..\\a//./b"), Some("a/b".into()));
        assert_eq!(clean_path(" / .. / . "), None);
        assert_eq!(clean_path(&"x".repeat(600)), None);
    }
}

fn with_db(db: Database) -> impl Filter<Extract = (Database,), Error = Infallible> + Clone {
    warp::any().map(move || db.clone())
}

fn err(status: StatusCode, msg: &str) -> warp::reply::Response {
    warp::reply::with_status(warp::reply::json(&json!({ "error": msg })), status).into_response()
}

/// The org a request acts within: the user's own org, or (for root) `?org=`.
fn acting_org(user: &User, q: &OrgQuery) -> Option<i64> {
    if user.role == "root" {
        q.org
    } else {
        user.org_id
    }
}

/// Resolve a workspace the user may access, else reject with Forbidden.
async fn ensure_ws(db: &Database, user: &User, ws_id: i64) -> Result<Workspace, Rejection> {
    match db.get_workspace(ws_id).await.ok().flatten() {
        Some(ws) if user.role == "root" || Some(ws.org_id) == user.org_id => Ok(ws),
        _ => Err(warp::reject::custom(Forbidden)),
    }
}

#[derive(Deserialize, Default)]
struct OrgQuery {
    org: Option<i64>,
}

#[derive(Deserialize)]
struct WsUpload {
    workspace_id: i64,
    #[serde(default)]
    org: Option<i64>,
}

#[derive(Deserialize)]
struct CreateWorkspace {
    name: String,
}

#[derive(Deserialize)]
struct RenameReq {
    name: String,
}

#[derive(Deserialize)]
struct CreateFile {
    workspace_id: i64,
    path: String,
}

#[derive(Deserialize)]
struct MoveFile {
    path: String,
}

#[derive(Deserialize)]
struct ChatPost {
    body: String,
}

#[derive(Deserialize)]
struct EditBody {
    body: String,
}

#[derive(Deserialize)]
struct ChatQuery {
    workspace_id: i64,
}

#[derive(Deserialize)]
struct DmQuery {
    with: i64,
    #[serde(default)]
    org: Option<i64>,
}

#[derive(Deserialize, Default)]
struct OverviewReq {
    #[serde(default)]
    workspace_id: Option<i64>,
    #[serde(default)]
    org: Option<i64>,
    #[serde(default)]
    ws_read: Option<i64>,
    #[serde(default)]
    dm_read: HashMap<i64, i64>,
}

/// Trim a message body to a short one-line preview for the sidebar.
fn preview(body: &str) -> String {
    let s = body.trim().replace('\n', " ");
    if s.chars().count() > 140 {
        s.chars().take(140).collect::<String>() + "…"
    } else {
        s
    }
}

/// The org a DM acts within: the user's own, or (for root) `?org=`.
fn dm_org(user: &User, q: &DmQuery) -> Option<i64> {
    if user.role == "root" {
        q.org
    } else {
        user.org_id
    }
}

pub fn routes(db: Database) -> impl Filter<Extract = (impl Reply,), Error = Rejection> + Clone {
    let get_org = warp::path!("org")
        .and(warp::get())
        .and(with_auth(db.clone()))
        .and(with_db(db.clone()))
        .and(warp::query::<OrgQuery>())
        .and_then(get_org);

    let create_ws = warp::path!("workspaces")
        .and(warp::post())
        .and(with_auth(db.clone()))
        .and(with_db(db.clone()))
        .and(warp::query::<OrgQuery>())
        .and(warp::body::json())
        .and_then(create_workspace);

    let get_ws = warp::path!("workspaces" / i64)
        .and(warp::get())
        .and(with_auth(db.clone()))
        .and(with_db(db.clone()))
        .and_then(get_workspace);

    let rename_ws = warp::path!("workspaces" / i64)
        .and(warp::put())
        .and(with_auth(db.clone()))
        .and(with_db(db.clone()))
        .and(warp::body::json())
        .and_then(rename_workspace);

    let delete_ws = warp::path!("workspaces" / i64)
        .and(warp::delete())
        .and(with_auth(db.clone()))
        .and(with_db(db.clone()))
        .and_then(delete_workspace);

    let create_file = warp::path!("files")
        .and(warp::post())
        .and(with_auth(db.clone()))
        .and(with_db(db.clone()))
        .and(warp::body::json())
        .and_then(create_file);

    let upload = warp::path!("files" / "upload")
        .and(warp::post())
        .and(with_auth(db.clone()))
        .and(with_db(db.clone()))
        .and(warp::query::<WsUpload>())
        .and(warp::multipart::form().max_length(32 * 1024 * 1024))
        .and_then(upload_file);

    let raw = warp::path!("files" / i64 / "raw")
        .and(warp::get())
        .and(with_auth(db.clone()))
        .and(with_db(db.clone()))
        .and_then(raw_file);

    let download = warp::path!("files" / i64 / "download")
        .and(warp::get())
        .and(with_auth(db.clone()))
        .and(with_db(db.clone()))
        .and_then(download_file);

    let move_file = warp::path!("files" / i64)
        .and(warp::put())
        .and(with_auth(db.clone()))
        .and(with_db(db.clone()))
        .and(warp::body::json())
        .and_then(move_file);

    let delete_file = warp::path!("files" / i64)
        .and(warp::delete())
        .and(with_auth(db.clone()))
        .and(with_db(db.clone()))
        .and_then(delete_file);

    // Workspace group chat.
    let chat_overview_r = warp::path!("chat" / "overview")
        .and(warp::post())
        .and(with_auth(db.clone()))
        .and(with_db(db.clone()))
        .and(epk_header())
        .and(warp::body::bytes())
        .and_then(chat_overview);

    let get_chat_r = warp::path!("chat")
        .and(warp::get())
        .and(with_auth(db.clone()))
        .and(with_db(db.clone()))
        .and(warp::query::<ChatQuery>())
        .and(epk_header())
        .and_then(get_chat);

    let post_chat_r = warp::path!("chat")
        .and(warp::post())
        .and(with_auth(db.clone()))
        .and(with_db(db.clone()))
        .and(warp::query::<ChatQuery>())
        .and(epk_header())
        .and(warp::body::bytes())
        .and_then(post_chat);

    let clear_chat_r = warp::path!("chat")
        .and(warp::delete())
        .and(with_auth(db.clone()))
        .and(with_db(db.clone()))
        .and(warp::query::<ChatQuery>())
        .and_then(clear_chat);

    // Org-wide 1:1 direct messages.
    let get_dm_r = warp::path!("dm")
        .and(warp::get())
        .and(with_auth(db.clone()))
        .and(with_db(db.clone()))
        .and(warp::query::<DmQuery>())
        .and(epk_header())
        .and_then(get_dm);

    let post_dm_r = warp::path!("dm")
        .and(warp::post())
        .and(with_auth(db.clone()))
        .and(with_db(db.clone()))
        .and(warp::query::<DmQuery>())
        .and(epk_header())
        .and(warp::body::bytes())
        .and_then(post_dm);

    let clear_dm_r = warp::path!("dm")
        .and(warp::delete())
        .and(with_auth(db.clone()))
        .and(with_db(db.clone()))
        .and(warp::query::<DmQuery>())
        .and_then(clear_dm);

    // Per-message edit / delete (author-scoped). `chat / i64` vs `chat` keeps
    // these distinct from the "clear whole thread" routes above.
    let edit_chat_r = warp::path!("chat" / i64)
        .and(warp::patch())
        .and(with_auth(db.clone()))
        .and(with_db(db.clone()))
        .and(epk_header())
        .and(warp::body::bytes())
        .and_then(edit_chat);

    let delete_chat_msg_r = warp::path!("chat" / i64)
        .and(warp::delete())
        .and(with_auth(db.clone()))
        .and(with_db(db.clone()))
        .and_then(delete_chat_msg);

    let edit_dm_r = warp::path!("dm" / i64)
        .and(warp::patch())
        .and(with_auth(db.clone()))
        .and(with_db(db.clone()))
        .and(epk_header())
        .and(warp::body::bytes())
        .and_then(edit_dm);

    let delete_dm_msg_r = warp::path!("dm" / i64)
        .and(warp::delete())
        .and(with_auth(db.clone()))
        .and(with_db(db.clone()))
        .and_then(delete_dm_msg);

    // Typing pings ("chat"/"dm" + literal "typing" — distinct from the /{id} routes).
    let typing_chat_r = warp::path!("chat" / "typing")
        .and(warp::post())
        .and(with_auth(db.clone()))
        .and(with_db(db.clone()))
        .and(warp::query::<ChatQuery>())
        .and_then(typing_chat);

    let typing_dm_r = warp::path!("dm" / "typing")
        .and(warp::post())
        .and(with_auth(db.clone()))
        .and(with_db(db.clone()))
        .and(warp::query::<DmQuery>())
        .and_then(typing_dm);

    // Emoji reactions (toggle).
    let react_r = warp::path!("reaction")
        .and(warp::post())
        .and(with_auth(db.clone()))
        .and(with_db(db.clone()))
        .and(epk_header())
        .and(warp::body::bytes())
        .and_then(toggle_reaction);

    // Presence: GET the org roster's online state, POST a heartbeat.
    let presence_get_r = warp::path!("presence")
        .and(warp::get())
        .and(with_auth(db.clone()))
        .and(with_db(db.clone()))
        .and(warp::query::<OrgQuery>())
        .and_then(presence_get);

    let presence_ping_r = warp::path!("presence")
        .and(warp::post())
        .and(with_auth(db.clone()))
        .and(with_db(db.clone()))
        .and_then(presence_ping);

    let audit_r = warp::path!("audit")
        .and(warp::get())
        .and(with_auth(db.clone()))
        .and(with_db(db.clone()))
        .and_then(audit_log);

    let ai_chat_r = warp::path!("ai" / "chat")
        .and(warp::post())
        .and(with_auth(db.clone()))
        .and(with_db(db.clone()))
        .and(warp::body::json())
        .and_then(ai_chat);

    let ai_settings_r = warp::path!("ai" / "settings")
        .and(warp::get())
        .and(with_auth(db.clone()))
        .and(with_db(db.clone()))
        .and_then(get_ai_settings);

    let ai_set_r = warp::path!("ai" / "providers")
        .and(warp::post())
        .and(with_auth(db.clone()))
        .and(with_db(db.clone()))
        .and(warp::body::json())
        .and_then(set_ai_provider);

    let ai_del_r = warp::path!("ai" / "providers")
        .and(warp::delete())
        .and(with_auth(db.clone()))
        .and(with_db(db.clone()))
        .and(warp::query::<ProviderScope>())
        .and_then(delete_ai_provider);

    // Fire a one-shot completion at the given config to check it actually works.
    // The provider call happens here in the backend — the browser never touches it.
    let ai_test_r = warp::path!("ai" / "test")
        .and(warp::post())
        .and(with_auth(db.clone()))
        .and(with_db(db.clone()))
        .and(warp::body::json())
        .and_then(test_ai_provider);

    let storage_r = warp::path!("admin" / "storage")
        .and(warp::get())
        .and(with_auth(db.clone()))
        .and(with_db(db.clone()))
        .and_then(admin_storage);

    // Grouped + boxed to keep the `.or()` type shallow (E0275 guard).
    let ai_routes = ai_chat_r
        .or(ai_settings_r)
        .or(ai_set_r)
        .or(ai_del_r)
        .or(ai_test_r)
        .or(storage_r)
        .boxed();

    // Chat images (pasted into chat) — stored separately from workspace files.
    let post_chat_image = warp::path!("chat-image")
        .and(warp::post())
        .and(with_auth(db.clone()))
        .and(with_db(db.clone()))
        .and(warp::query::<OrgQuery>())
        .and(warp::multipart::form().max_length(16 * 1024 * 1024))
        .and_then(upload_chat_image);

    let get_chat_image_r = warp::path!("chat-image" / i64)
        .and(warp::get())
        .and(with_auth(db.clone()))
        .and(with_db(db))
        .and_then(get_chat_image);

    // Box the two halves: warp's `.or()` builds a deeply-nested type, and past
    // ~two-dozen routes the compiler overflows resolving it (E0275). `.boxed()`
    // erases each half's type so the final combination stays shallow.
    let workspace_routes = get_org
        .or(create_ws)
        .or(upload)
        .or(raw)
        .or(download)
        .or(get_ws)
        .or(rename_ws)
        .or(delete_ws)
        .or(create_file)
        .or(move_file)
        .or(delete_file)
        .or(audit_r)
        .boxed();

    let chat_routes = chat_overview_r
        .or(get_chat_r)
        .or(post_chat_r)
        .or(clear_chat_r)
        .or(get_dm_r)
        .or(post_dm_r)
        .or(clear_dm_r)
        .or(edit_chat_r)
        .or(delete_chat_msg_r)
        .or(edit_dm_r)
        .or(delete_dm_msg_r)
        .or(typing_chat_r)
        .or(typing_dm_r)
        .or(react_r)
        .or(presence_get_r)
        .or(presence_ping_r)
        .or(post_chat_image)
        .or(get_chat_image_r)
        .boxed();

    workspace_routes.or(chat_routes).or(ai_routes)
}

async fn get_org(user: User, db: Database, q: OrgQuery) -> Result<impl Reply, Rejection> {
    let is_owner = user.role == "root";
    let org_id = acting_org(&user, &q);
    let (org, workspaces, members) = match org_id {
        Some(oid) => (
            db.get_org(oid).await.ok().flatten(),
            db.list_workspaces(oid).await.unwrap_or_default(),
            db.list_org_members(oid).await.unwrap_or_default(),
        ),
        None => (None, Vec::new(), Vec::new()),
    };
    Ok(warp::reply::json(&json!({
        "org": org,
        "workspaces": workspaces,
        "members": members,
        "isOwner": is_owner,
    })))
}

async fn create_workspace(
    user: User,
    db: Database,
    q: OrgQuery,
    body: CreateWorkspace,
) -> Result<impl Reply, Rejection> {
    let org_id = match acting_org(&user, &q) {
        Some(o) => o,
        None => return Ok(err(StatusCode::FORBIDDEN, "you are not assigned to an org")),
    };
    let name = body.name.trim();
    if name.is_empty() {
        return Ok(err(StatusCode::BAD_REQUEST, "name cannot be empty"));
    }
    match db.create_workspace(org_id, name, user.id, now_secs()).await {
        Ok(ws) => Ok(warp::reply::json(&json!({ "workspace": ws })).into_response()),
        Err(_) => Ok(err(StatusCode::BAD_REQUEST, "could not create workspace")),
    }
}

async fn get_workspace(ws_id: i64, user: User, db: Database) -> Result<impl Reply, Rejection> {
    let ws = ensure_ws(&db, &user, ws_id).await?;
    let files = db.list_files(ws.id).await.unwrap_or_default();
    Ok(warp::reply::json(&json!({ "workspace": ws, "files": files })))
}

async fn rename_workspace(
    ws_id: i64,
    user: User,
    db: Database,
    body: RenameReq,
) -> Result<impl Reply, Rejection> {
    let ws = ensure_ws(&db, &user, ws_id).await?;
    let name = body.name.trim();
    if name.is_empty() {
        return Ok(err(StatusCode::BAD_REQUEST, "name cannot be empty"));
    }
    let _ = db.rename_workspace(ws.id, name).await;
    Ok(warp::reply::json(&json!({ "ok": true })).into_response())
}

async fn delete_workspace(ws_id: i64, user: User, db: Database) -> Result<impl Reply, Rejection> {
    let ws = ensure_ws(&db, &user, ws_id).await?;
    let _ = db.delete_workspace(ws.id).await;
    Ok(warp::reply::json(&json!({ "ok": true })).into_response())
}

async fn create_file(user: User, db: Database, body: CreateFile) -> Result<impl Reply, Rejection> {
    ensure_ws(&db, &user, body.workspace_id).await?;
    let path = match clean_path(&body.path) {
        Some(p) => p,
        None => return Ok(err(StatusCode::BAD_REQUEST, "invalid file name")),
    };
    let doc_id = random_doc_id();
    match db
        .create_file(body.workspace_id, &path, &doc_id, "text", None, now_secs())
        .await
    {
        Ok(file) => {
            let _ = db.audit(user.org_id, Some(user.id), "create_file", Some(&path), now_secs()).await;
            Ok(warp::reply::json(&json!({ "file": file })).into_response())
        }
        Err(_) => Ok(err(
            StatusCode::BAD_REQUEST,
            "could not create file (name may already exist)",
        )),
    }
}

async fn read_part(part: Part) -> Result<Vec<u8>, warp::Error> {
    part.stream()
        .try_fold(Vec::new(), |mut acc, buf| async move {
            acc.extend_from_slice(buf.chunk());
            Ok(acc)
        })
        .await
}

async fn upload_file(
    user: User,
    db: Database,
    q: WsUpload,
    mut form: FormData,
) -> Result<impl Reply, Rejection> {
    ensure_ws(&db, &user, q.workspace_id).await?;
    let mut found: Option<(String, Option<String>, Vec<u8>)> = None;
    loop {
        match form.try_next().await {
            Ok(Some(part)) => {
                if part.name() == "file" {
                    let filename = clean_path(part.filename().unwrap_or("upload"))
                        .unwrap_or_else(|| "upload".to_string());
                    let mime = part.content_type().map(|s| s.to_string());
                    let bytes = match read_part(part).await {
                        Ok(b) => b,
                        Err(_) => return Ok(err(StatusCode::BAD_REQUEST, "could not read file")),
                    };
                    found = Some((filename, mime, bytes));
                    break;
                }
            }
            Ok(None) => break,
            Err(_) => return Ok(err(StatusCode::BAD_REQUEST, "invalid upload")),
        }
    }
    let (filename, mime, bytes) = match found {
        Some(f) => f,
        None => return Ok(err(StatusCode::BAD_REQUEST, "no file field")),
    };
    // Text uploads (source, .txt, .md, JSON…) open in the editor; store them as
    // seeded OT documents so they're readable and collaboratively editable.
    // Anything that isn't valid UTF-8, contains a NUL byte, or is large stays a
    // binary blob. ponytail: 1 MB text cap keeps huge files out of the in-memory
    // OT model; raise it if real docs get truncated to binary.
    let text = if bytes.len() <= 1_000_000 {
        std::str::from_utf8(&bytes).ok().filter(|s| !s.contains('\0'))
    } else {
        None
    };
    let doc_id = random_doc_id();
    let kind = if text.is_some() { "text" } else { "binary" };
    let file = match db
        .create_file(q.workspace_id, &filename, &doc_id, kind, mime.as_deref(), now_secs())
        .await
    {
        Ok(file) => file,
        Err(_) => {
            return Ok(err(
                StatusCode::BAD_REQUEST,
                "could not create file (name may already exist)",
            ))
        }
    };
    let stored = match text {
        Some(t) => db
            .store(
                &doc_id,
                &PersistedDocument { text: t.replace("\r\n", "\n"), language: None },
            )
            .await
            .is_ok(),
        None => db.store_blob(file.id, &bytes).await.is_ok(),
    };
    if !stored {
        return Ok(err(StatusCode::INTERNAL_SERVER_ERROR, "could not store file"));
    }
    let _ = db.audit(user.org_id, Some(user.id), "upload", Some(&filename), now_secs()).await;
    Ok(warp::reply::json(&json!({ "file": file })).into_response())
}

/// Whether the user may access a file (same org, or root).
async fn file_allowed(db: &Database, user: &User, file_id: i64) -> bool {
    match db.file_org(file_id).await.ok().flatten() {
        Some(org) => user.role == "root" || Some(org) == user.org_id,
        None => false,
    }
}

async fn raw_file(file_id: i64, user: User, db: Database) -> Result<impl Reply, Rejection> {
    if !file_allowed(&db, &user, file_id).await {
        return Err(warp::reject::custom(Forbidden));
    }
    let file = match db.get_file(file_id).await.ok().flatten() {
        Some(f) if f.kind == "binary" => f,
        Some(_) => return Ok(err(StatusCode::BAD_REQUEST, "not a binary file")),
        None => return Ok(err(StatusCode::NOT_FOUND, "no such file")),
    };
    let bytes = db.load_blob(file.id).await.ok().flatten().unwrap_or_default();
    let mime = file.mime.unwrap_or_else(|| "application/octet-stream".to_string());
    let resp = warp::http::Response::builder()
        .header("content-type", mime)
        .body(Body::from(bytes))
        .expect("valid response");
    Ok(resp)
}

async fn download_file(file_id: i64, user: User, db: Database) -> Result<impl Reply, Rejection> {
    if !file_allowed(&db, &user, file_id).await {
        return Err(warp::reject::custom(Forbidden));
    }
    let file = match db.get_file(file_id).await.ok().flatten() {
        Some(f) => f,
        None => return Ok(err(StatusCode::NOT_FOUND, "no such file")),
    };
    let _ = db.audit(user.org_id, Some(user.id), "download", Some(&file.path), now_secs()).await;
    let bytes: Vec<u8> = if file.kind == "binary" {
        db.load_blob(file.id).await.ok().flatten().unwrap_or_default()
    } else {
        db.load(&file.doc_id)
            .await
            .map(|d| d.text.into_bytes())
            .unwrap_or_default()
    };
    // Keep the header well-formed regardless of what the path contains.
    let filename: String = file
        .path
        .rsplit('/')
        .next()
        .unwrap_or("download")
        .chars()
        .filter(|c| !c.is_control() && *c != '"' && *c != '\\')
        .collect();
    let resp = warp::http::Response::builder()
        .header(
            "content-disposition",
            format!("attachment; filename=\"{filename}\""),
        )
        .body(Body::from(bytes))
        .expect("valid response");
    Ok(resp)
}

async fn delete_file(file_id: i64, user: User, db: Database) -> Result<impl Reply, Rejection> {
    if !file_allowed(&db, &user, file_id).await {
        return Err(warp::reject::custom(Forbidden));
    }
    let path = db.get_file(file_id).await.ok().flatten().map(|f| f.path);
    let _ = db.delete_file(file_id).await;
    let _ = db.audit(user.org_id, Some(user.id), "delete_file", path.as_deref(), now_secs()).await;
    Ok(warp::reply::json(&json!({ "ok": true })).into_response())
}

async fn move_file(
    file_id: i64,
    user: User,
    db: Database,
    body: MoveFile,
) -> Result<impl Reply, Rejection> {
    if !file_allowed(&db, &user, file_id).await {
        return Err(warp::reject::custom(Forbidden));
    }
    let path = match clean_path(&body.path) {
        Some(p) => p,
        None => return Ok(err(StatusCode::BAD_REQUEST, "invalid path")),
    };
    match db.rename_file(file_id, &path).await {
        Ok(_) => Ok(warp::reply::json(&json!({ "ok": true })).into_response()),
        Err(_) => Ok(err(StatusCode::BAD_REQUEST, "a file already exists at that path")),
    }
}

#[derive(Deserialize)]
struct AiMsg {
    role: String,
    content: String,
}

#[derive(Deserialize)]
struct AiChatReq {
    workspace_id: i64,
    messages: Vec<AiMsg>,
}

/// A resolved, ready-to-call provider: a decrypted key plus where/how to call.
struct ResolvedProvider {
    provider: String, // "anthropic" | "openai"
    base_url: Option<String>,
    model: String,
    api_key: String,
    source: &'static str, // "user" | "org" | "env"
}

/// Resolve which provider to use for this user: their personal config, else the
/// org default, else the server ANTHROPIC_API_KEY env fallback, else none.
async fn resolve_provider(db: &Database, user: &User) -> Option<ResolvedProvider> {
    if let Some(row) = db.get_provider("user", user.id).await.ok().flatten() {
        if let Some(key) = crypto::secret_decrypt(&row.key_cipher) {
            return Some(ResolvedProvider {
                provider: row.provider,
                base_url: row.base_url,
                model: row.model,
                api_key: key,
                source: "user",
            });
        }
    }
    if let Some(org) = user.org_id {
        if let Some(row) = db.get_provider("org", org).await.ok().flatten() {
            if let Some(key) = crypto::secret_decrypt(&row.key_cipher) {
                return Some(ResolvedProvider {
                    provider: row.provider,
                    base_url: row.base_url,
                    model: row.model,
                    api_key: key,
                    source: "org",
                });
            }
        }
    }
    match std::env::var("ANTHROPIC_API_KEY") {
        Ok(k) if !k.trim().is_empty() => Some(ResolvedProvider {
            provider: "anthropic".to_string(),
            base_url: None,
            model: std::env::var("AI_MODEL").unwrap_or_else(|_| "claude-opus-5".to_string()),
            api_key: k,
            source: "env",
        }),
        _ => None,
    }
}

/// Build the capped file-context blob for a workspace.
async fn workspace_context(db: &Database, workspace_id: i64) -> String {
    // ponytail: whole-file stuffing, no embeddings/RAG — fine for the small
    // workspaces this targets; add retrieval if files outgrow the cap.
    let files = db.list_files(workspace_id).await.unwrap_or_default();
    let mut ctx = String::new();
    let mut budget: usize = 120_000; // ~30k tokens of file text
    for f in &files {
        if f.kind != "text" || budget == 0 {
            continue;
        }
        if let Ok(doc) = db.load(&f.doc_id).await {
            let header = format!("\n\n===== FILE: {} =====\n", f.path);
            ctx.push_str(&header);
            let room = budget.saturating_sub(header.len());
            if doc.text.len() > room {
                ctx.extend(doc.text.chars().take(room));
                ctx.push_str("\n…(truncated)…");
                budget = 0;
            } else {
                ctx.push_str(&doc.text);
                budget -= header.len() + doc.text.len();
            }
        }
    }
    ctx
}

fn trim_url(base: &str) -> &str {
    base.trim().trim_end_matches('/')
}

/// Truncate a provider's raw error body so we surface a useful hint without
/// dumping an entire HTML error page into the response.
fn short_detail(s: &str) -> String {
    let t = s.trim();
    let short: String = t.chars().take(300).collect();
    if short.len() < t.len() { format!("{}…", short) } else { short }
}

/// One completion call to a resolved provider. `Ok(reply_text)` on HTTP 200,
/// `Err(user_facing_detail)` otherwise. All provider HTTP happens here — this is
/// the single place outbound AI calls are made, shared by chat and test.
async fn provider_complete(
    prov: &ResolvedProvider,
    system: &str,
    msgs: &[serde_json::Value],
    max_tokens: u32,
) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|_| "AI client init failed".to_string())?;

    // "openai" and "azure" share the Chat Completions wire format; only the URL
    // and auth header differ.
    let openai_style = prov.provider == "openai" || prov.provider == "azure";

    let req = if openai_style {
        let mut oai_msgs = vec![json!({ "role": "system", "content": system })];
        oai_msgs.extend(msgs.iter().cloned());
        // Newer OpenAI reasoning models (o-series, gpt-5) reject `max_tokens` and
        // require `max_completion_tokens`; everything else uses `max_tokens`.
        let m = prov.model.to_lowercase();
        let token_key = if m.starts_with("o1") || m.starts_with("o3") || m.starts_with("o4") || m.starts_with("gpt-5") {
            "max_completion_tokens"
        } else {
            "max_tokens"
        };
        let mut body = json!({ "model": prov.model, "messages": oai_msgs });
        body[token_key] = json!(max_tokens);

        if prov.provider == "azure" {
            // Azure: full deployment base in base_url, `api-key` header, api-version query.
            let base = match prov.base_url.as_deref() {
                Some(b) if !b.trim().is_empty() => trim_url(b),
                _ => return Err("Azure needs the deployment base URL".to_string()),
            };
            client
                .post(format!("{}/chat/completions?api-version=2024-10-21", base))
                .header("api-key", prov.api_key.clone())
                .json(&body)
        } else {
            let base = prov.base_url.as_deref().map(trim_url).unwrap_or("https://api.openai.com/v1");
            client
                .post(format!("{}/chat/completions", base))
                .header("authorization", format!("Bearer {}", prov.api_key))
                .json(&body)
        }
    } else {
        let base = prov.base_url.as_deref().map(trim_url).unwrap_or("https://api.anthropic.com");
        client
            .post(format!("{}/v1/messages", base))
            .header("x-api-key", prov.api_key.clone())
            .header("anthropic-version", "2023-06-01")
            .json(&json!({ "model": prov.model, "max_tokens": max_tokens, "system": system, "messages": msgs }))
    };

    let resp = req
        .header("content-type", "application/json")
        .send()
        .await
        .map_err(|_| "could not reach the AI service".to_string())?;
    if !resp.status().is_success() {
        let code = resp.status();
        let detail = resp.text().await.unwrap_or_default();
        log::warn!("AI provider error {}: {}", code, detail);
        return Err(format!("provider returned {} — {}", code.as_u16(), short_detail(&detail)));
    }
    let val: serde_json::Value = resp.json().await.map_err(|_| "bad AI response".to_string())?;

    let reply = if openai_style {
        val.pointer("/choices/0/message/content").and_then(|v| v.as_str()).unwrap_or_default().to_string()
    } else {
        val.get("content")
            .and_then(|c| c.as_array())
            .map(|blocks| {
                blocks
                    .iter()
                    .filter(|b| b.get("type").and_then(|t| t.as_str()) == Some("text"))
                    .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
                    .collect::<Vec<_>>()
                    .join("")
            })
            .unwrap_or_default()
    };
    Ok(reply)
}

/// AI assistant grounded in the workspace's text files. Calls the resolved
/// provider (Anthropic Messages API or any OpenAI-compatible chat endpoint) over
/// raw HTTPS. Keys stay server-side — never sent to the browser.
async fn ai_chat(user: User, db: Database, body: AiChatReq) -> Result<impl Reply, Rejection> {
    ensure_ws(&db, &user, body.workspace_id).await?;

    let prov = match resolve_provider(&db, &user).await {
        Some(p) => p,
        None => return Ok(err(StatusCode::SERVICE_UNAVAILABLE, "AI is not configured. Add a provider in Settings → AI.")),
    };

    let context = workspace_context(&db, body.workspace_id).await;
    let system = format!(
        "You are Cortex Assistant, an AI helper embedded in a private, self-hosted collaborative \
         workspace for code and notes. Answer the user's questions about the workspace's files. \
         Be concise and accurate, use Markdown, and name the file when you reference one. If the \
         answer isn't in the files, say so plainly. Do not include internal or system XML tags in \
         your reply.\n\nWorkspace files:\n{}",
        if context.is_empty() { "(no readable text files yet)".to_string() } else { context }
    );

    let msgs: Vec<serde_json::Value> = body
        .messages
        .iter()
        .filter(|m| m.role == "user" || m.role == "assistant")
        .map(|m| json!({ "role": m.role, "content": m.content }))
        .collect();
    if msgs.is_empty() {
        return Ok(err(StatusCode::BAD_REQUEST, "no message"));
    }

    let reply = match provider_complete(&prov, &system, &msgs, 8192).await {
        Ok(r) => r,
        Err(_) => return Ok(err(StatusCode::BAD_GATEWAY, "the AI service returned an error")),
    };
    let _ = db.audit(user.org_id, Some(user.id), "ai_chat", None, now_secs()).await;
    Ok(warp::reply::json(&json!({ "reply": reply, "source": prov.source })).into_response())
}

#[derive(Deserialize)]
struct ProviderBody {
    scope: String, // "user" | "org"
    provider: String,
    #[serde(default)]
    base_url: Option<String>,
    model: String,
    #[serde(default)]
    key: Option<String>,
}

#[derive(Deserialize)]
struct ProviderScope {
    scope: String,
}

fn mask_provider(row: &ProviderRow) -> serde_json::Value {
    json!({ "provider": row.provider, "base_url": row.base_url, "model": row.model, "has_key": true })
}

/// The caller's AI settings view: their own config, the org default + per-user
/// overview (owner/admin only), and whether the feature is usable at all.
async fn get_ai_settings(user: User, db: Database) -> Result<impl Reply, Rejection> {
    let is_admin = user.role == "admin" || user.role == "root";
    let mine = db.get_provider("user", user.id).await.ok().flatten();
    let effective = resolve_provider(&db, &user).await;

    let mut out = json!({
        "storage_ready": crypto::secret_storage_ready(),
        "env_fallback": std::env::var("ANTHROPIC_API_KEY").map(|k| !k.trim().is_empty()).unwrap_or(false),
        "is_admin": is_admin,
        "mine": mine.as_ref().map(mask_provider),
        "effective": effective.map(|e| json!({ "source": e.source, "provider": e.provider, "model": e.model })),
    });

    if is_admin {
        if let Some(org) = user.org_id {
            let org_cfg = db.get_provider("org", org).await.ok().flatten();
            let users: Vec<serde_json::Value> = db
                .org_user_providers(org)
                .await
                .unwrap_or_default()
                .into_iter()
                .map(|(uid, provider, model)| json!({ "user_id": uid, "provider": provider, "model": model }))
                .collect();
            out["org"] = org_cfg.as_ref().map(mask_provider).unwrap_or(serde_json::Value::Null);
            out["org_users"] = json!(users);
        }
    }
    Ok(warp::reply::json(&out).into_response())
}

/// Create/update a provider config. Users may set only their own; org scope is
/// owner/admin only. Key is required on first save; omit it to keep the existing.
async fn set_ai_provider(user: User, db: Database, body: ProviderBody) -> Result<impl Reply, Rejection> {
    if !crypto::secret_storage_ready() {
        return Ok(err(StatusCode::SERVICE_UNAVAILABLE, "Key storage isn't configured (set AI_KEY_SECRET)."));
    }
    if !matches!(body.provider.as_str(), "anthropic" | "openai" | "azure") {
        return Ok(err(StatusCode::BAD_REQUEST, "unknown provider"));
    }
    if body.model.trim().is_empty() {
        return Ok(err(StatusCode::BAD_REQUEST, "model is required"));
    }
    let is_admin = user.role == "admin" || user.role == "root";
    let (scope, scope_id) = match body.scope.as_str() {
        "user" => ("user", user.id),
        "org" => {
            if !is_admin {
                return Err(warp::reject::custom(Forbidden));
            }
            match user.org_id {
                Some(o) => ("org", o),
                None => return Ok(err(StatusCode::BAD_REQUEST, "no org to configure")),
            }
        }
        _ => return Ok(err(StatusCode::BAD_REQUEST, "bad scope")),
    };

    // Encrypt the new key, or keep the existing cipher when the key is omitted.
    let key_cipher = match body.key.as_deref().map(str::trim).filter(|k| !k.is_empty()) {
        Some(k) => match crypto::secret_encrypt(k) {
            Some(c) => c,
            None => return Ok(err(StatusCode::INTERNAL_SERVER_ERROR, "could not encrypt key")),
        },
        None => match db.get_provider(scope, scope_id).await.ok().flatten() {
            Some(row) => row.key_cipher,
            None => return Ok(err(StatusCode::BAD_REQUEST, "an API key is required")),
        },
    };
    let base = body.base_url.as_deref().map(str::trim).filter(|s| !s.is_empty());
    if db
        .upsert_provider(scope, scope_id, &body.provider, base, body.model.trim(), &key_cipher, now_secs())
        .await
        .is_err()
    {
        return Ok(err(StatusCode::INTERNAL_SERVER_ERROR, "could not save"));
    }
    let _ = db.audit(user.org_id, Some(user.id), "ai_provider_set", Some(scope), now_secs()).await;
    Ok(warp::reply::json(&json!({ "ok": true })).into_response())
}

async fn delete_ai_provider(user: User, db: Database, q: ProviderScope) -> Result<impl Reply, Rejection> {
    let is_admin = user.role == "admin" || user.role == "root";
    let (scope, scope_id) = match q.scope.as_str() {
        "user" => ("user", user.id),
        "org" => {
            if !is_admin {
                return Err(warp::reject::custom(Forbidden));
            }
            match user.org_id {
                Some(o) => ("org", o),
                None => return Ok(err(StatusCode::BAD_REQUEST, "no org")),
            }
        }
        _ => return Ok(err(StatusCode::BAD_REQUEST, "bad scope")),
    };
    let _ = db.delete_provider(scope, scope_id).await;
    Ok(warp::reply::json(&json!({ "ok": true })).into_response())
}

/// Test a provider config by firing one real completion at it from the backend.
/// Uses the key typed in the form if present, else the saved key for that scope,
/// so "Test" works whether or not the user re-entered the key. Reports the real
/// provider error on failure so the user can tell exactly what's wrong.
async fn test_ai_provider(user: User, db: Database, body: ProviderBody) -> Result<impl Reply, Rejection> {
    if !matches!(body.provider.as_str(), "anthropic" | "openai" | "azure") {
        return Ok(err(StatusCode::BAD_REQUEST, "unknown provider"));
    }
    if body.model.trim().is_empty() {
        return Ok(err(StatusCode::BAD_REQUEST, "model is required"));
    }
    let is_admin = user.role == "admin" || user.role == "root";
    let (scope, scope_id) = match body.scope.as_str() {
        "user" => ("user", user.id),
        "org" => {
            if !is_admin {
                return Err(warp::reject::custom(Forbidden));
            }
            match user.org_id {
                Some(o) => ("org", o),
                None => return Ok(err(StatusCode::BAD_REQUEST, "no org")),
            }
        }
        _ => return Ok(err(StatusCode::BAD_REQUEST, "bad scope")),
    };

    let api_key = match body.key.as_deref().map(str::trim).filter(|k| !k.is_empty()) {
        Some(k) => k.to_string(),
        None => match db
            .get_provider(scope, scope_id)
            .await
            .ok()
            .flatten()
            .and_then(|r| crypto::secret_decrypt(&r.key_cipher))
        {
            Some(k) => k,
            None => return Ok(err(StatusCode::BAD_REQUEST, "Enter an API key to test.")),
        },
    };
    let prov = ResolvedProvider {
        provider: body.provider.clone(),
        base_url: body.base_url.as_deref().map(str::trim).filter(|s| !s.is_empty()).map(str::to_string),
        model: body.model.trim().to_string(),
        api_key,
        source: "test",
    };

    let msgs = vec![json!({ "role": "user", "content": "Reply with the single word: OK" })];
    match provider_complete(&prov, "You are a connection test. Reply with exactly: OK", &msgs, 64).await {
        Ok(reply) => {
            let _ = db.audit(user.org_id, Some(user.id), "ai_provider_test", Some(scope), now_secs()).await;
            Ok(warp::reply::json(&json!({ "ok": true, "reply": reply.trim() })).into_response())
        }
        Err(detail) => Ok(err(StatusCode::BAD_GATEWAY, &format!("Test failed — {}", detail))),
    }
}

/// Owner/admin storage readout: DB file size, blob bytes, and per-table rows.
async fn admin_storage(user: User, db: Database) -> Result<impl Reply, Rejection> {
    if user.role != "admin" && user.role != "root" {
        return Err(warp::reject::custom(Forbidden));
    }
    const TABLES: &[&str] = &[
        "users", "org", "workspace", "file", "document", "message", "dm",
        "reaction", "chat_image", "file_blob", "audit", "session",
    ];
    let mut tables = Vec::new();
    for t in TABLES {
        if let Ok(n) = db.table_rows(t).await {
            tables.push(json!({ "name": t, "rows": n }));
        }
    }
    Ok(warp::reply::json(&json!({
        "db_bytes": db.db_size_bytes().await.unwrap_or(0),
        "blob_bytes": db.blob_bytes().await.unwrap_or(0),
        "tables": tables,
    }))
    .into_response())
}

/// Per-thread summary for the sidebar: latest message (id, sender, preview, time)
/// plus the unread count relative to the client's read markers. Carries message
/// previews, so it's ECIES-sealed like the rest of chat.
/// ponytail: one COUNT query per thread — fine for the small locked-down orgs this
/// targets; batch into a single grouped query if peer counts ever get large.
async fn chat_overview(
    user: User,
    db: Database,
    epk: Option<String>,
    raw: bytes::Bytes,
) -> Result<impl Reply, Rejection> {
    let req: OverviewReq = crypto::open_request(&epk, &raw)
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default();

    let ws = if let Some(id) = req.workspace_id {
        if ensure_ws(&db, &user, id).await.is_ok() {
            match db.workspace_last_msg(id).await.ok().flatten() {
                Some((last_id, sender, body, at)) => {
                    let unread = db
                        .ws_unread_count(id, user.id, req.ws_read.unwrap_or(0))
                        .await
                        .unwrap_or(0);
                    Some(json!({ "last_id": last_id, "last_sender": sender, "body": preview(&body), "at": at, "unread": unread }))
                }
                None => None,
            }
        } else {
            None
        }
    } else {
        None
    };

    let org = if user.role == "root" { req.org } else { user.org_id };
    let mut dms = Vec::new();
    if let Some(org) = org {
        for (peer, last_id, sender, body, at) in db.dm_overview(org, user.id).await.unwrap_or_default() {
            let after = req.dm_read.get(&peer).copied().unwrap_or(0);
            let unread = db.dm_unread_count(org, user.id, peer, after).await.unwrap_or(0);
            dms.push(json!({ "peer_id": peer, "last_id": last_id, "last_sender": sender, "body": preview(&body), "at": at, "unread": unread }));
        }
    }
    Ok(crypto::seal_reply(&epk, &json!({ "ws": ws, "dms": dms })))
}

async fn get_chat(
    user: User,
    db: Database,
    q: ChatQuery,
    epk: Option<String>,
) -> Result<impl Reply, Rejection> {
    ensure_ws(&db, &user, q.workspace_id).await?;
    let messages = db.list_messages(q.workspace_id, 300).await.unwrap_or_default();
    let reactions = db.reactions_for_workspace(q.workspace_id, user.id).await.unwrap_or_default();
    let messages = attach_reactions(messages, reactions);
    let typing = who_typing(&format!("ws:{}", q.workspace_id), user.id, now_secs());
    Ok(crypto::seal_reply(&epk, &json!({ "messages": messages, "typing": typing })))
}

async fn post_chat(
    user: User,
    db: Database,
    q: ChatQuery,
    epk: Option<String>,
    raw: bytes::Bytes,
) -> Result<impl Reply, Rejection> {
    ensure_ws(&db, &user, q.workspace_id).await?;
    let body: ChatPost = match crypto::open_request(&epk, &raw)
        .and_then(|b| serde_json::from_slice(&b).ok())
    {
        Some(v) => v,
        None => return Ok(err(StatusCode::BAD_REQUEST, "bad payload")),
    };
    let text = body.body.trim();
    if text.is_empty() {
        return Ok(err(StatusCode::BAD_REQUEST, "empty message"));
    }
    if text.len() > 8000 {
        return Ok(err(StatusCode::BAD_REQUEST, "message too long"));
    }
    if db.create_message(q.workspace_id, user.id, text, now_secs()).await.is_err() {
        return Ok(err(StatusCode::INTERNAL_SERVER_ERROR, "could not send message"));
    }
    Ok(crypto::seal_reply(&epk, &json!({ "ok": true })))
}

/// Clear a workspace's group chat. Admin or root only.
async fn clear_chat(user: User, db: Database, q: ChatQuery) -> Result<impl Reply, Rejection> {
    ensure_ws(&db, &user, q.workspace_id).await?;
    if user.role != "admin" && user.role != "root" {
        return Err(warp::reject::custom(Forbidden));
    }
    let _ = db.clear_messages(q.workspace_id).await;
    Ok(warp::reply::json(&json!({ "ok": true })).into_response())
}

/// Resolve the org for a DM and verify the peer is a co-member. Returns the org.
async fn dm_ctx(db: &Database, user: &User, q: &DmQuery) -> Result<i64, Rejection> {
    let org = dm_org(user, q).ok_or_else(|| warp::reject::custom(Forbidden))?;
    // The peer must belong to the same org; the actor must too (or be root).
    let peer_ok = db.user_org(q.with).await.ok().flatten() == Some(org);
    let self_ok = user.role == "root" || user.org_id == Some(org);
    if peer_ok && self_ok {
        Ok(org)
    } else {
        Err(warp::reject::custom(Forbidden))
    }
}

async fn get_dm(
    user: User,
    db: Database,
    q: DmQuery,
    epk: Option<String>,
) -> Result<impl Reply, Rejection> {
    let org = dm_ctx(&db, &user, &q).await?;
    let messages = db.list_dm(org, user.id, q.with, 300).await.unwrap_or_default();
    let reactions = db.reactions_for_dm(org, user.id, q.with, user.id).await.unwrap_or_default();
    let messages = attach_reactions(messages, reactions);
    let typing = who_typing(&dm_scope(user.id, q.with), user.id, now_secs());
    Ok(crypto::seal_reply(&epk, &json!({ "messages": messages, "typing": typing })))
}

async fn post_dm(
    user: User,
    db: Database,
    q: DmQuery,
    epk: Option<String>,
    raw: bytes::Bytes,
) -> Result<impl Reply, Rejection> {
    let org = dm_ctx(&db, &user, &q).await?;
    let body: ChatPost = match crypto::open_request(&epk, &raw)
        .and_then(|b| serde_json::from_slice(&b).ok())
    {
        Some(v) => v,
        None => return Ok(err(StatusCode::BAD_REQUEST, "bad payload")),
    };
    let text = body.body.trim();
    if text.is_empty() {
        return Ok(err(StatusCode::BAD_REQUEST, "empty message"));
    }
    if text.len() > 8000 {
        return Ok(err(StatusCode::BAD_REQUEST, "message too long"));
    }
    if db.create_dm(org, user.id, q.with, text, now_secs()).await.is_err() {
        return Ok(err(StatusCode::INTERNAL_SERVER_ERROR, "could not send message"));
    }
    Ok(crypto::seal_reply(&epk, &json!({ "ok": true })))
}

/// Clear a 1:1 conversation. Either participant may do this (clears for both).
async fn clear_dm(user: User, db: Database, q: DmQuery) -> Result<impl Reply, Rejection> {
    let org = dm_ctx(&db, &user, &q).await?;
    let _ = db.clear_dm(org, user.id, q.with).await;
    Ok(warp::reply::json(&json!({ "ok": true })).into_response())
}

/// Validate an edited body (shared by chat + DM edits).
fn valid_edit(text: &str) -> Option<&str> {
    let t = text.trim();
    if t.is_empty() || t.len() > 8000 {
        None
    } else {
        Some(t)
    }
}

/// Edit one of your own group-chat messages. Author-scoped in the query, so
/// there's no separate ownership check to get wrong.
async fn edit_chat(
    id: i64,
    user: User,
    db: Database,
    epk: Option<String>,
    raw: bytes::Bytes,
) -> Result<impl Reply, Rejection> {
    let body: EditBody = match crypto::open_request(&epk, &raw)
        .and_then(|b| serde_json::from_slice(&b).ok())
    {
        Some(v) => v,
        None => return Ok(err(StatusCode::BAD_REQUEST, "bad payload")),
    };
    let text = match valid_edit(&body.body) {
        Some(t) => t,
        None => return Ok(err(StatusCode::BAD_REQUEST, "empty or oversized message")),
    };
    match db.edit_message(id, user.id, text, now_secs()).await {
        Ok(true) => Ok(crypto::seal_reply(&epk, &json!({ "ok": true }))),
        _ => Ok(err(StatusCode::FORBIDDEN, "cannot edit this message")),
    }
}

/// Delete one of your own group-chat messages.
async fn delete_chat_msg(id: i64, user: User, db: Database) -> Result<impl Reply, Rejection> {
    match db.delete_message(id, user.id).await {
        Ok(true) => Ok(warp::reply::json(&json!({ "ok": true })).into_response()),
        _ => Ok(err(StatusCode::FORBIDDEN, "cannot delete this message")),
    }
}

/// Edit one of your own direct messages (sender-scoped).
async fn edit_dm(
    id: i64,
    user: User,
    db: Database,
    epk: Option<String>,
    raw: bytes::Bytes,
) -> Result<impl Reply, Rejection> {
    let body: EditBody = match crypto::open_request(&epk, &raw)
        .and_then(|b| serde_json::from_slice(&b).ok())
    {
        Some(v) => v,
        None => return Ok(err(StatusCode::BAD_REQUEST, "bad payload")),
    };
    let text = match valid_edit(&body.body) {
        Some(t) => t,
        None => return Ok(err(StatusCode::BAD_REQUEST, "empty or oversized message")),
    };
    match db.edit_dm(id, user.id, text, now_secs()).await {
        Ok(true) => Ok(crypto::seal_reply(&epk, &json!({ "ok": true }))),
        _ => Ok(err(StatusCode::FORBIDDEN, "cannot edit this message")),
    }
}

/// Delete one of your own direct messages.
async fn delete_dm_msg(id: i64, user: User, db: Database) -> Result<impl Reply, Rejection> {
    match db.delete_dm_message(id, user.id).await {
        Ok(true) => Ok(warp::reply::json(&json!({ "ok": true })).into_response()),
        _ => Ok(err(StatusCode::FORBIDDEN, "cannot delete this message")),
    }
}

/// "I'm typing" ping for a workspace's group chat (ephemeral, no body).
async fn typing_chat(user: User, db: Database, q: ChatQuery) -> Result<impl Reply, Rejection> {
    ensure_ws(&db, &user, q.workspace_id).await?;
    mark_typing(format!("ws:{}", q.workspace_id), user.id, now_secs());
    Ok(warp::reply::json(&json!({ "ok": true })).into_response())
}

/// "I'm typing" ping for a 1:1 conversation.
async fn typing_dm(user: User, db: Database, q: DmQuery) -> Result<impl Reply, Rejection> {
    let _ = dm_ctx(&db, &user, &q).await?;
    mark_typing(dm_scope(user.id, q.with), user.id, now_secs());
    Ok(warp::reply::json(&json!({ "ok": true })).into_response())
}

#[derive(Deserialize)]
struct ReactBody {
    kind: String,
    msg_id: i64,
    emoji: String,
}

/// Toggle an emoji reaction on a message. Reactions only ever surface through
/// the thread-scoped join, so a reaction to an unseen id stays invisible —
/// ponytail: no extra ownership/access check needed here.
async fn toggle_reaction(
    user: User,
    db: Database,
    epk: Option<String>,
    raw: bytes::Bytes,
) -> Result<impl Reply, Rejection> {
    let body: ReactBody = match crypto::open_request(&epk, &raw)
        .and_then(|b| serde_json::from_slice(&b).ok())
    {
        Some(v) => v,
        None => return Ok(err(StatusCode::BAD_REQUEST, "bad payload")),
    };
    if body.kind != "ws" && body.kind != "dm" {
        return Ok(err(StatusCode::BAD_REQUEST, "bad kind"));
    }
    let emoji = body.emoji.trim();
    if emoji.is_empty() || emoji.chars().count() > 8 {
        return Ok(err(StatusCode::BAD_REQUEST, "bad emoji"));
    }
    let _ = db.toggle_reaction(&body.kind, body.msg_id, user.id, emoji).await;
    Ok(crypto::seal_reply(&epk, &json!({ "ok": true })))
}

/// Heartbeat: record that the caller is currently online.
async fn presence_ping(user: User, db: Database) -> Result<impl Reply, Rejection> {
    let _ = db.touch_last_seen(user.id, now_secs()).await;
    Ok(warp::reply::json(&json!({ "ok": true })).into_response())
}

/// Who in the org is online / when they were last seen.
async fn presence_get(user: User, db: Database, q: OrgQuery) -> Result<impl Reply, Rejection> {
    let now = now_secs();
    let list = match acting_org(&user, &q) {
        Some(org) => db.org_presence(org).await.unwrap_or_default(),
        None => Vec::new(),
    };
    let presence: Vec<_> = list
        .into_iter()
        .map(|(id, seen)| json!({ "id": id, "last_seen": seen, "online": now - seen < 45 }))
        .collect();
    Ok(warp::reply::json(&json!({ "presence": presence })).into_response())
}

/// Recent audit entries. Admins see their org; root sees every org.
async fn audit_log(user: User, db: Database) -> Result<impl Reply, Rejection> {
    if user.role != "admin" && user.role != "root" {
        return Err(warp::reject::custom(Forbidden));
    }
    let all = user.role == "root";
    let entries = db.list_audit(user.org_id, all, 300).await.unwrap_or_default();
    Ok(warp::reply::json(&json!({ "entries": entries })).into_response())
}

/// Store an image pasted into chat; returns its id + URL.
async fn upload_chat_image(
    user: User,
    db: Database,
    q: OrgQuery,
    mut form: FormData,
) -> Result<impl Reply, Rejection> {
    let org = match acting_org(&user, &q) {
        Some(o) => o,
        None => return Ok(err(StatusCode::FORBIDDEN, "no org")),
    };
    let mut found: Option<(Option<String>, Vec<u8>)> = None;
    loop {
        match form.try_next().await {
            Ok(Some(part)) => {
                if part.name() == "file" {
                    let mime = part.content_type().map(|s| s.to_string());
                    let bytes = match read_part(part).await {
                        Ok(b) => b,
                        Err(_) => return Ok(err(StatusCode::BAD_REQUEST, "could not read image")),
                    };
                    found = Some((mime, bytes));
                    break;
                }
            }
            Ok(None) => break,
            Err(_) => return Ok(err(StatusCode::BAD_REQUEST, "invalid upload")),
        }
    }
    let (mime, bytes) = match found {
        Some(f) => f,
        None => return Ok(err(StatusCode::BAD_REQUEST, "no file field")),
    };
    match db.create_chat_image(org, mime.as_deref(), &bytes, now_secs()).await {
        Ok(id) => Ok(
            warp::reply::json(&json!({ "id": id, "url": format!("/api/chat-image/{}", id) })).into_response(),
        ),
        Err(_) => Ok(err(StatusCode::INTERNAL_SERVER_ERROR, "could not store image")),
    }
}

/// Serve a chat image to members of its org (root may view any).
async fn get_chat_image(id: i64, user: User, db: Database) -> Result<impl Reply, Rejection> {
    match db.get_chat_image(id).await.ok().flatten() {
        Some((org, mime, data)) if user.role == "root" || Some(org) == user.org_id => {
            let mime = mime.unwrap_or_else(|| "application/octet-stream".to_string());
            let resp = warp::http::Response::builder()
                .header("content-type", mime)
                .header("cache-control", "private, max-age=86400")
                .body(Body::from(data))
                .expect("valid response");
            Ok(resp)
        }
        Some(_) => Err(warp::reject::custom(Forbidden)),
        None => Ok(err(StatusCode::NOT_FOUND, "no such image")),
    }
}
