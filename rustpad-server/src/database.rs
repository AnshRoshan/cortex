//! Backend SQLite database handlers.
//!
//! Model: **Org → Workspaces → files**, plus one org-wide chat. Every user is
//! assigned to at most one org (by the root owner). Access to a workspace is by
//! org membership; the root owner bypasses org checks (full cross-org access).

use std::str::FromStr;

use anyhow::{bail, Result};
use serde::Serialize;
use sqlx::{sqlite::SqliteConnectOptions, ConnectOptions, SqlitePool};

/// Represents a document persisted in database storage.
#[derive(sqlx::FromRow, PartialEq, Eq, Clone, Debug)]
pub struct PersistedDocument {
    /// Text content of the document.
    pub text: String,
    /// Language of the document for editor syntax highlighting.
    pub language: Option<String>,
}

/// A seeded application user.
#[derive(sqlx::FromRow, PartialEq, Eq, Clone, Debug)]
pub struct User {
    /// Primary key.
    pub id: i64,
    /// Login email (unique).
    pub email: String,
    /// Display name (editable in profile).
    pub name: String,
    /// bcrypt hash of the password.
    pub password_hash: String,
    /// "root" (hidden owner), "admin", or "user".
    pub role: String,
    /// Org the user is assigned to (None for root / unassigned).
    pub org_id: Option<i64>,
}

/// A user as shown in the root admin console (never includes root accounts).
#[derive(sqlx::FromRow, Serialize, PartialEq, Eq, Clone, Debug)]
pub struct AdminUser {
    /// Primary key.
    pub id: i64,
    /// Login email.
    pub email: String,
    /// Display name.
    pub name: String,
    /// Role ("admin" or "user").
    pub role: String,
    /// Assigned org id (nullable).
    pub org_id: Option<i64>,
    /// Assigned org name (nullable).
    pub org_name: Option<String>,
}

/// An org.
#[derive(sqlx::FromRow, Serialize, PartialEq, Eq, Clone, Debug)]
pub struct Org {
    /// Primary key.
    pub id: i64,
    /// Display name.
    pub name: String,
    /// URL slug (unique), e.g. "dev".
    pub slug: String,
}

/// An org as shown in the owner console, with counts.
#[derive(sqlx::FromRow, Serialize, PartialEq, Eq, Clone, Debug)]
pub struct AdminOrg {
    /// Primary key.
    pub id: i64,
    /// Display name.
    pub name: String,
    /// URL slug.
    pub slug: String,
    /// Number of assigned users.
    pub members: i64,
    /// Number of workspaces.
    pub workspaces: i64,
}

/// A workspace within an org.
#[derive(sqlx::FromRow, Serialize, PartialEq, Eq, Clone, Debug)]
pub struct Workspace {
    /// Primary key.
    pub id: i64,
    /// Owning org.
    pub org_id: i64,
    /// Display name.
    pub name: String,
    /// URL slug, unique within the org (e.g. "backend").
    pub slug: String,
}

/// Turn a name into a URL slug.
fn slugify(s: &str) -> String {
    let mut out = String::new();
    let mut prev_dash = false;
    for c in s.chars() {
        if c.is_alphanumeric() {
            out.extend(c.to_lowercase());
            prev_dash = false;
        } else if !prev_dash && !out.is_empty() {
            out.push('-');
            prev_dash = true;
        }
    }
    let t = out.trim_matches('-').to_string();
    if t.is_empty() {
        "workspace".to_string()
    } else {
        t
    }
}

/// A file within a workspace.
#[derive(sqlx::FromRow, Serialize, PartialEq, Eq, Clone, Debug)]
pub struct FileRow {
    /// Primary key.
    pub id: i64,
    /// Owning workspace.
    pub workspace_id: i64,
    /// Path/name within the workspace.
    pub path: String,
    /// Id of the collaborative document holding this file's text.
    pub doc_id: String,
    /// "text" (collaborative) or "binary" (uploaded document).
    pub kind: String,
    /// MIME type for binary files.
    pub mime: Option<String>,
}

/// A chat message with its author's name/email.
#[derive(sqlx::FromRow, Serialize, PartialEq, Eq, Clone, Debug)]
pub struct ChatMessage {
    /// Primary key.
    pub id: i64,
    /// Markdown body.
    pub body: String,
    /// Author display name (falls back to email on the client).
    pub author: String,
    /// Author email.
    pub email: String,
    /// Unix seconds.
    pub created_at: i64,
}

/// A member of an org, as returned to the client.
#[derive(sqlx::FromRow, Serialize, PartialEq, Eq, Clone, Debug)]
pub struct Member {
    /// User id.
    pub id: i64,
    /// User email.
    pub email: String,
    /// Display name.
    pub name: String,
    /// User role ("admin" or "user").
    pub role: String,
}

/// A driver for database operations wrapping a pool connection.
#[derive(Clone, Debug)]
pub struct Database {
    pool: SqlitePool,
}

impl Database {
    /// Construct a new database, creating the file and running migrations.
    pub async fn new(uri: &str) -> Result<Self> {
        {
            let mut conn = SqliteConnectOptions::from_str(uri)?
                .create_if_missing(true)
                .connect()
                .await?;
            sqlx::migrate!().run(&mut conn).await?;
        }
        Ok(Database {
            pool: SqlitePool::connect(uri).await?,
        })
    }

    // ----- Documents (OT content) -----

    /// Load the text of a document from the database.
    pub async fn load(&self, document_id: &str) -> Result<PersistedDocument> {
        sqlx::query_as(r#"SELECT text, language FROM document WHERE id = $1"#)
            .bind(document_id)
            .fetch_one(&self.pool)
            .await
            .map_err(|e| e.into())
    }

    /// Store the text of a document in the database.
    pub async fn store(&self, document_id: &str, document: &PersistedDocument) -> Result<()> {
        let result = sqlx::query(
            r#"INSERT INTO document (id, text, language) VALUES ($1, $2, $3)
               ON CONFLICT(id) DO UPDATE SET text = excluded.text, language = excluded.language"#,
        )
        .bind(document_id)
        .bind(&document.text)
        .bind(&document.language)
        .execute(&self.pool)
        .await?;
        if result.rows_affected() != 1 {
            bail!(
                "expected store() to affect 1 row, but affected {}",
                result.rows_affected()
            );
        }
        Ok(())
    }

    /// Count the number of documents in the database.
    pub async fn count(&self) -> Result<usize> {
        let row: (i64,) = sqlx::query_as("SELECT count(*) FROM document")
            .fetch_one(&self.pool)
            .await?;
        Ok(row.0 as usize)
    }

    // ----- Users / auth -----

    /// Insert a user if the email doesn't already exist. Returns true if inserted.
    pub async fn create_user_if_absent(
        &self,
        email: &str,
        name: &str,
        password_hash: &str,
        role: &str,
        org_id: Option<i64>,
    ) -> Result<bool> {
        let result = sqlx::query(
            r#"INSERT INTO users (email, name, password_hash, role, org_id)
               VALUES ($1, $2, $3, $4, $5) ON CONFLICT(email) DO NOTHING"#,
        )
        .bind(email)
        .bind(name)
        .bind(password_hash)
        .bind(role)
        .bind(org_id)
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected() == 1)
    }

    /// Look up a user by email for login.
    pub async fn get_user_by_email(&self, email: &str) -> Result<Option<User>> {
        sqlx::query_as(
            r#"SELECT id, email, name, password_hash, role, org_id FROM users WHERE email = $1"#,
        )
        .bind(email)
        .fetch_optional(&self.pool)
        .await
        .map_err(|e| e.into())
    }

    /// Update a user's display name.
    pub async fn update_name(&self, user_id: i64, name: &str) -> Result<()> {
        sqlx::query(r#"UPDATE users SET name = $1 WHERE id = $2"#)
            .bind(name)
            .bind(user_id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// Update a user's password hash.
    pub async fn update_password(&self, user_id: i64, password_hash: &str) -> Result<()> {
        sqlx::query(r#"UPDATE users SET password_hash = $1 WHERE id = $2"#)
            .bind(password_hash)
            .bind(user_id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// Create a session row.
    pub async fn create_session(&self, token: &str, user_id: i64, expires_at: i64) -> Result<()> {
        sqlx::query(r#"INSERT INTO session (token, user_id, expires_at) VALUES ($1, $2, $3)"#)
            .bind(token)
            .bind(user_id)
            .bind(expires_at)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// Resolve a session token to its user, only if the session is unexpired.
    pub async fn get_session_user(&self, token: &str, now: i64) -> Result<Option<User>> {
        sqlx::query_as(
            r#"SELECT u.id, u.email, u.name, u.password_hash, u.role, u.org_id
               FROM session s JOIN users u ON u.id = s.user_id
               WHERE s.token = $1 AND s.expires_at > $2"#,
        )
        .bind(token)
        .bind(now)
        .fetch_optional(&self.pool)
        .await
        .map_err(|e| e.into())
    }

    /// Delete all expired sessions (housekeeping, run on login).
    pub async fn purge_expired_sessions(&self, now: i64) -> Result<()> {
        sqlx::query(r#"DELETE FROM session WHERE expires_at <= $1"#)
            .bind(now)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// Delete a session (logout).
    pub async fn delete_session(&self, token: &str) -> Result<()> {
        sqlx::query(r#"DELETE FROM session WHERE token = $1"#)
            .bind(token)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    // ----- Root admin: users -----

    /// List all non-root users, with their org name.
    pub async fn admin_list_users(&self) -> Result<Vec<AdminUser>> {
        sqlx::query_as(
            r#"SELECT u.id, u.email, u.name, u.role, u.org_id, o.name AS org_name
               FROM users u LEFT JOIN org o ON o.id = u.org_id
               WHERE u.role != 'root' ORDER BY u.email"#,
        )
        .fetch_all(&self.pool)
        .await
        .map_err(|e| e.into())
    }

    /// Change a user's role (never touches root accounts).
    pub async fn admin_set_role(&self, id: i64, role: &str) -> Result<()> {
        sqlx::query(r#"UPDATE users SET role = $1 WHERE id = $2 AND role != 'root'"#)
            .bind(role)
            .bind(id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// Assign a user to an org (or None to unassign). Never touches root.
    pub async fn admin_set_org(&self, id: i64, org_id: Option<i64>) -> Result<()> {
        sqlx::query(r#"UPDATE users SET org_id = $1 WHERE id = $2 AND role != 'root'"#)
            .bind(org_id)
            .bind(id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// Delete a user and their sessions. Never deletes root.
    pub async fn admin_delete_user(&self, id: i64) -> Result<()> {
        let mut tx = self.pool.begin().await?;
        sqlx::query(r#"DELETE FROM session WHERE user_id = $1"#)
            .bind(id)
            .execute(&mut tx)
            .await?;
        sqlx::query(r#"DELETE FROM users WHERE id = $1 AND role != 'root'"#)
            .bind(id)
            .execute(&mut tx)
            .await?;
        tx.commit().await?;
        Ok(())
    }

    // ----- Orgs -----

    /// Create an org.
    pub async fn create_org(&self, name: &str, slug: &str, now: i64) -> Result<Org> {
        let row: (i64,) = sqlx::query_as(
            r#"INSERT INTO org (name, slug, created_at) VALUES ($1, $2, $3) RETURNING id"#,
        )
        .bind(name)
        .bind(slug)
        .bind(now)
        .fetch_one(&self.pool)
        .await?;
        Ok(Org {
            id: row.0,
            name: name.to_string(),
            slug: slug.to_string(),
        })
    }

    /// List all orgs with member and workspace counts.
    pub async fn list_orgs(&self) -> Result<Vec<AdminOrg>> {
        sqlx::query_as(
            r#"SELECT o.id, o.name, o.slug,
                      (SELECT count(*) FROM users u WHERE u.org_id = o.id) AS members,
                      (SELECT count(*) FROM workspace w WHERE w.org_id = o.id) AS workspaces
               FROM org o ORDER BY o.name"#,
        )
        .fetch_all(&self.pool)
        .await
        .map_err(|e| e.into())
    }

    /// Fetch an org by id.
    pub async fn get_org(&self, id: i64) -> Result<Option<Org>> {
        sqlx::query_as(r#"SELECT id, name, slug FROM org WHERE id = $1"#)
            .bind(id)
            .fetch_optional(&self.pool)
            .await
            .map_err(|e| e.into())
    }

    /// Rename an org.
    pub async fn rename_org(&self, id: i64, name: &str) -> Result<()> {
        sqlx::query(r#"UPDATE org SET name = $1 WHERE id = $2"#)
            .bind(name)
            .bind(id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// Delete an org and everything in it (workspaces, files, chat), and
    /// unassign its users.
    pub async fn delete_org(&self, id: i64) -> Result<()> {
        let mut tx = self.pool.begin().await?;
        sqlx::query(
            r#"DELETE FROM file_blob WHERE file_id IN
               (SELECT f.id FROM file f JOIN workspace w ON w.id = f.workspace_id WHERE w.org_id = $1)"#,
        )
        .bind(id)
        .execute(&mut tx)
        .await?;
        sqlx::query(
            r#"DELETE FROM document WHERE id IN
               (SELECT f.doc_id FROM file f JOIN workspace w ON w.id = f.workspace_id WHERE w.org_id = $1)"#,
        )
        .bind(id)
        .execute(&mut tx)
        .await?;
        sqlx::query(
            r#"DELETE FROM file WHERE workspace_id IN (SELECT id FROM workspace WHERE org_id = $1)"#,
        )
        .bind(id)
        .execute(&mut tx)
        .await?;
        sqlx::query(r#"DELETE FROM workspace WHERE org_id = $1"#)
            .bind(id)
            .execute(&mut tx)
            .await?;
        sqlx::query(r#"DELETE FROM message WHERE org_id = $1"#)
            .bind(id)
            .execute(&mut tx)
            .await?;
        sqlx::query(r#"UPDATE users SET org_id = NULL WHERE org_id = $1"#)
            .bind(id)
            .execute(&mut tx)
            .await?;
        sqlx::query(r#"DELETE FROM org WHERE id = $1"#)
            .bind(id)
            .execute(&mut tx)
            .await?;
        tx.commit().await?;
        Ok(())
    }

    /// List the members (non-root users) of an org.
    pub async fn list_org_members(&self, org_id: i64) -> Result<Vec<Member>> {
        sqlx::query_as(
            r#"SELECT id, email, name, role FROM users
               WHERE org_id = $1 AND role != 'root' ORDER BY email"#,
        )
        .bind(org_id)
        .fetch_all(&self.pool)
        .await
        .map_err(|e| e.into())
    }

    // ----- Workspaces (org-scoped) -----

    /// Create a workspace in an org, with a slug unique within that org.
    pub async fn create_workspace(
        &self,
        org_id: i64,
        name: &str,
        created_by: i64,
        now: i64,
    ) -> Result<Workspace> {
        let base = slugify(name);
        let mut slug = base.clone();
        let mut n = 2;
        while self.slug_taken(org_id, &slug).await? {
            slug = format!("{base}-{n}");
            n += 1;
        }
        let row: (i64,) = sqlx::query_as(
            r#"INSERT INTO workspace (org_id, name, slug, created_by, created_at)
               VALUES ($1, $2, $3, $4, $5) RETURNING id"#,
        )
        .bind(org_id)
        .bind(name)
        .bind(&slug)
        .bind(created_by)
        .bind(now)
        .fetch_one(&self.pool)
        .await?;
        Ok(Workspace {
            id: row.0,
            org_id,
            name: name.to_string(),
            slug,
        })
    }

    async fn slug_taken(&self, org_id: i64, slug: &str) -> Result<bool> {
        let row: (i64,) = sqlx::query_as(
            r#"SELECT count(*) FROM workspace WHERE org_id = $1 AND slug = $2"#,
        )
        .bind(org_id)
        .bind(slug)
        .fetch_one(&self.pool)
        .await?;
        Ok(row.0 > 0)
    }

    /// List the workspaces in an org.
    pub async fn list_workspaces(&self, org_id: i64) -> Result<Vec<Workspace>> {
        sqlx::query_as(
            r#"SELECT id, org_id, name, slug FROM workspace WHERE org_id = $1 ORDER BY name"#,
        )
        .bind(org_id)
        .fetch_all(&self.pool)
        .await
        .map_err(|e| e.into())
    }

    /// Fetch a workspace by id.
    pub async fn get_workspace(&self, id: i64) -> Result<Option<Workspace>> {
        sqlx::query_as(r#"SELECT id, org_id, name, slug FROM workspace WHERE id = $1"#)
            .bind(id)
            .fetch_optional(&self.pool)
            .await
            .map_err(|e| e.into())
    }

    /// Rename a workspace.
    pub async fn rename_workspace(&self, id: i64, name: &str) -> Result<()> {
        sqlx::query(r#"UPDATE workspace SET name = $1 WHERE id = $2"#)
            .bind(name)
            .bind(id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// Delete a workspace and all its files/blobs/documents.
    pub async fn delete_workspace(&self, id: i64) -> Result<()> {
        let mut tx = self.pool.begin().await?;
        sqlx::query(
            r#"DELETE FROM file_blob WHERE file_id IN (SELECT id FROM file WHERE workspace_id = $1)"#,
        )
        .bind(id)
        .execute(&mut tx)
        .await?;
        sqlx::query(
            r#"DELETE FROM document WHERE id IN (SELECT doc_id FROM file WHERE workspace_id = $1)"#,
        )
        .bind(id)
        .execute(&mut tx)
        .await?;
        sqlx::query(r#"DELETE FROM file WHERE workspace_id = $1"#)
            .bind(id)
            .execute(&mut tx)
            .await?;
        sqlx::query(r#"DELETE FROM workspace WHERE id = $1"#)
            .bind(id)
            .execute(&mut tx)
            .await?;
        tx.commit().await?;
        Ok(())
    }

    /// The org that owns a workspace, if it exists.
    pub async fn workspace_org(&self, workspace_id: i64) -> Result<Option<i64>> {
        let row: Option<(i64,)> =
            sqlx::query_as(r#"SELECT org_id FROM workspace WHERE id = $1"#)
                .bind(workspace_id)
                .fetch_optional(&self.pool)
                .await?;
        Ok(row.map(|r| r.0))
    }

    /// The org that owns the workspace containing a file, if it exists.
    pub async fn file_org(&self, file_id: i64) -> Result<Option<i64>> {
        let row: Option<(i64,)> = sqlx::query_as(
            r#"SELECT w.org_id FROM file f JOIN workspace w ON w.id = f.workspace_id
               WHERE f.id = $1"#,
        )
        .bind(file_id)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.map(|r| r.0))
    }

    /// The org that owns the workspace containing the file for a document.
    pub async fn doc_org(&self, doc_id: &str) -> Result<Option<i64>> {
        let row: Option<(i64,)> = sqlx::query_as(
            r#"SELECT w.org_id FROM file f JOIN workspace w ON w.id = f.workspace_id
               WHERE f.doc_id = $1"#,
        )
        .bind(doc_id)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.map(|r| r.0))
    }

    // ----- Files -----

    /// Create a file row in a workspace.
    pub async fn create_file(
        &self,
        workspace_id: i64,
        path: &str,
        doc_id: &str,
        kind: &str,
        mime: Option<&str>,
        now: i64,
    ) -> Result<FileRow> {
        let row: (i64,) = sqlx::query_as(
            r#"INSERT INTO file (workspace_id, path, doc_id, kind, mime, created_at)
               VALUES ($1, $2, $3, $4, $5, $6) RETURNING id"#,
        )
        .bind(workspace_id)
        .bind(path)
        .bind(doc_id)
        .bind(kind)
        .bind(mime)
        .bind(now)
        .fetch_one(&self.pool)
        .await?;
        Ok(FileRow {
            id: row.0,
            workspace_id,
            path: path.to_string(),
            doc_id: doc_id.to_string(),
            kind: kind.to_string(),
            mime: mime.map(str::to_string),
        })
    }

    /// List files in a workspace, ordered by path.
    pub async fn list_files(&self, workspace_id: i64) -> Result<Vec<FileRow>> {
        sqlx::query_as(
            r#"SELECT id, workspace_id, path, doc_id, kind, mime FROM file
               WHERE workspace_id = $1 ORDER BY path"#,
        )
        .bind(workspace_id)
        .fetch_all(&self.pool)
        .await
        .map_err(|e| e.into())
    }

    /// Fetch a file by id.
    pub async fn get_file(&self, id: i64) -> Result<Option<FileRow>> {
        sqlx::query_as(r#"SELECT id, workspace_id, path, doc_id, kind, mime FROM file WHERE id = $1"#)
            .bind(id)
            .fetch_optional(&self.pool)
            .await
            .map_err(|e| e.into())
    }

    /// Move/rename a file (change its path within the workspace).
    pub async fn rename_file(&self, id: i64, path: &str) -> Result<()> {
        sqlx::query(r#"UPDATE file SET path = $1 WHERE id = $2"#)
            .bind(path)
            .bind(id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// Store raw bytes for a binary file.
    pub async fn store_blob(&self, file_id: i64, data: &[u8]) -> Result<()> {
        sqlx::query(
            r#"INSERT INTO file_blob (file_id, data) VALUES ($1, $2)
               ON CONFLICT(file_id) DO UPDATE SET data = excluded.data"#,
        )
        .bind(file_id)
        .bind(data)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Load raw bytes for a binary file.
    pub async fn load_blob(&self, file_id: i64) -> Result<Option<Vec<u8>>> {
        let row: Option<(Vec<u8>,)> =
            sqlx::query_as(r#"SELECT data FROM file_blob WHERE file_id = $1"#)
                .bind(file_id)
                .fetch_optional(&self.pool)
                .await?;
        Ok(row.map(|r| r.0))
    }

    /// Delete a file row and its underlying content (OT document or blob).
    pub async fn delete_file(&self, id: i64) -> Result<()> {
        let mut tx = self.pool.begin().await?;
        let file: Option<FileRow> = sqlx::query_as(
            r#"SELECT id, workspace_id, path, doc_id, kind, mime FROM file WHERE id = $1"#,
        )
        .bind(id)
        .fetch_optional(&mut tx)
        .await?;
        if let Some(f) = file {
            sqlx::query(r#"DELETE FROM file_blob WHERE file_id = $1"#)
                .bind(id)
                .execute(&mut tx)
                .await?;
            sqlx::query(r#"DELETE FROM file WHERE id = $1"#)
                .bind(id)
                .execute(&mut tx)
                .await?;
            sqlx::query(r#"DELETE FROM document WHERE id = $1"#)
                .bind(&f.doc_id)
                .execute(&mut tx)
                .await?;
        }
        tx.commit().await?;
        Ok(())
    }

    // ----- Chat (org-wide) -----

    /// Post a chat message to an org.
    pub async fn create_message(
        &self,
        org_id: i64,
        user_id: i64,
        body: &str,
        now: i64,
    ) -> Result<()> {
        sqlx::query(
            r#"INSERT INTO message (org_id, user_id, body, created_at) VALUES ($1, $2, $3, $4)"#,
        )
        .bind(org_id)
        .bind(user_id)
        .bind(body)
        .bind(now)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// The most recent messages in an org, oldest-first.
    pub async fn list_messages(&self, org_id: i64, limit: i64) -> Result<Vec<ChatMessage>> {
        let mut rows: Vec<ChatMessage> = sqlx::query_as(
            r#"SELECT m.id, m.body, u.name AS author, u.email AS email, m.created_at
               FROM message m JOIN users u ON u.id = m.user_id
               WHERE m.org_id = $1 ORDER BY m.id DESC LIMIT $2"#,
        )
        .bind(org_id)
        .bind(limit)
        .fetch_all(&self.pool)
        .await?;
        rows.reverse();
        Ok(rows)
    }
}
