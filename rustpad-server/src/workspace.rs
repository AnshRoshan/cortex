//! Org / workspace / file / chat routes.
//!
//! Access model: a user may act within their assigned org; the root owner may
//! act within any org (passing `?org=<id>`). Any org member can create and open
//! every workspace in their org. Chat is org-wide.

use std::convert::Infallible;
use std::time::{SystemTime, UNIX_EPOCH};

use bytes::Buf;
use futures::TryStreamExt;
use rand::RngCore;
use serde::Deserialize;
use serde_json::json;
use warp::multipart::{FormData, Part};
use warp::{http::StatusCode, hyper::Body, reply::Reply, Filter, Rejection};

use crate::auth::{with_auth, Forbidden};
use crate::database::{Database, User, Workspace};

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

    let get_chat_r = warp::path!("chat")
        .and(warp::get())
        .and(with_auth(db.clone()))
        .and(with_db(db.clone()))
        .and(warp::query::<OrgQuery>())
        .and_then(get_chat);

    let post_chat_r = warp::path!("chat")
        .and(warp::post())
        .and(with_auth(db.clone()))
        .and(with_db(db))
        .and(warp::query::<OrgQuery>())
        .and(warp::body::json())
        .and_then(post_chat);

    get_org
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
        .or(get_chat_r)
        .or(post_chat_r)
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
        Ok(file) => Ok(warp::reply::json(&json!({ "file": file })).into_response()),
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
    let doc_id = random_doc_id();
    let file = match db
        .create_file(q.workspace_id, &filename, &doc_id, "binary", mime.as_deref(), now_secs())
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
    if db.store_blob(file.id, &bytes).await.is_err() {
        return Ok(err(StatusCode::INTERNAL_SERVER_ERROR, "could not store file"));
    }
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
    let _ = db.delete_file(file_id).await;
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

async fn get_chat(user: User, db: Database, q: OrgQuery) -> Result<impl Reply, Rejection> {
    let messages = match acting_org(&user, &q) {
        Some(oid) => db.list_messages(oid, 300).await.unwrap_or_default(),
        None => Vec::new(),
    };
    Ok(warp::reply::json(&json!({ "messages": messages })))
}

async fn post_chat(
    user: User,
    db: Database,
    q: OrgQuery,
    body: ChatPost,
) -> Result<impl Reply, Rejection> {
    let org_id = match acting_org(&user, &q) {
        Some(o) => o,
        None => return Ok(err(StatusCode::FORBIDDEN, "no org")),
    };
    let text = body.body.trim();
    if text.is_empty() {
        return Ok(err(StatusCode::BAD_REQUEST, "empty message"));
    }
    if text.len() > 8000 {
        return Ok(err(StatusCode::BAD_REQUEST, "message too long"));
    }
    if db.create_message(org_id, user.id, text, now_secs()).await.is_err() {
        return Ok(err(StatusCode::INTERNAL_SERVER_ERROR, "could not send message"));
    }
    Ok(warp::reply::json(&json!({ "ok": true })).into_response())
}
