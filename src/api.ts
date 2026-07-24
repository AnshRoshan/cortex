// Typed client for the AuthPad backend. Same-origin; relies on the HttpOnly
// session cookie set at login.

export type Me = { email: string; name: string; role: string };
export type Org = { id: number; name: string; slug: string };
export type Workspace = { id: number; org_id: number; name: string; slug: string };
export type FileRow = {
  id: number;
  workspace_id: number;
  path: string;
  doc_id: string;
  kind: "text" | "binary";
  mime: string | null;
};
export type Member = { id: number; email: string; name: string; role: string };
export type ChatMessage = {
  id: number;
  body: string;
  author: string;
  email: string;
  created_at: number;
};
export type OrgData = {
  org: Org | null;
  workspaces: Workspace[];
  members: Member[];
  isOwner: boolean;
};
export type WorkspaceDetail = { workspace: Workspace; files: FileRow[] };

export type AdminUser = {
  id: number;
  email: string;
  name: string;
  role: string;
  org_id: number | null;
  org_name: string | null;
};
export type AdminOrg = {
  id: number;
  name: string;
  slug: string;
  members: number;
  workspaces: number;
};

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let message = res.statusText;
    try {
      const body = await res.json();
      if (body?.error) message = body.error;
    } catch {
      /* ignore */
    }
    throw new Error(message);
  }
  return res.json() as Promise<T>;
}

const opts = (method: string, body?: unknown): RequestInit => ({
  method,
  credentials: "include",
  headers: body ? { "Content-Type": "application/json" } : undefined,
  body: body ? JSON.stringify(body) : undefined,
});

// `?org=` is only honored by the backend for the root owner; ignored otherwise.
const orgQ = (orgId?: number) => (orgId != null ? `?org=${orgId}` : "");

// ----- auth / profile -----
export async function getMe(): Promise<Me | null> {
  const res = await fetch("/api/me", { credentials: "include" });
  return res.ok ? ((await res.json()) as Me) : null;
}
export async function logout(): Promise<void> {
  await fetch("/api/logout", opts("POST"));
}
export async function updateName(name: string): Promise<void> {
  await json(await fetch("/api/profile", opts("POST", { name })));
}
export async function changePassword(current: string, newPassword: string): Promise<void> {
  await json(await fetch("/api/profile/password", opts("POST", { current, new: newPassword })));
}

// ----- org / workspaces -----
export async function getOrg(orgId?: number): Promise<OrgData> {
  return json(await fetch(`/api/org${orgQ(orgId)}`, { credentials: "include" }));
}
export async function createWorkspace(name: string, orgId?: number): Promise<{ workspace: Workspace }> {
  return json(await fetch(`/api/workspaces${orgQ(orgId)}`, opts("POST", { name })));
}
export async function getWorkspace(id: number): Promise<WorkspaceDetail> {
  return json(await fetch(`/api/workspaces/${id}`, { credentials: "include" }));
}
export async function renameWorkspace(id: number, name: string): Promise<void> {
  await json(await fetch(`/api/workspaces/${id}`, opts("PUT", { name })));
}
export async function deleteWorkspace(id: number): Promise<void> {
  await json(await fetch(`/api/workspaces/${id}`, opts("DELETE")));
}

// ----- files -----
export async function createFile(workspaceId: number, path: string): Promise<{ file: FileRow }> {
  return json(await fetch("/api/files", opts("POST", { workspace_id: workspaceId, path })));
}
export async function uploadFile(workspaceId: number, file: File): Promise<{ file: FileRow }> {
  const fd = new FormData();
  fd.append("file", file);
  return json(
    await fetch(`/api/files/upload?workspace_id=${workspaceId}`, {
      method: "POST",
      credentials: "include",
      body: fd,
    }),
  );
}
export function rawUrl(file: FileRow): string {
  return `/api/files/${file.id}/raw`;
}
export async function downloadFile(file: FileRow): Promise<void> {
  const res = await fetch(`/api/files/${file.id}/download`, { credentials: "include" });
  if (!res.ok) throw new Error("download failed");
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = file.path.split("/").pop() || "download";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
export async function deleteFile(id: number): Promise<void> {
  await json(await fetch(`/api/files/${id}`, opts("DELETE")));
}

export async function moveFile(id: number, path: string): Promise<void> {
  await json(await fetch(`/api/files/${id}`, opts("PUT", { path })));
}

// ----- chat (org-wide) -----
export async function getChat(orgId?: number): Promise<{ messages: ChatMessage[] }> {
  return json(await fetch(`/api/chat${orgQ(orgId)}`, { credentials: "include" }));
}
export async function postChat(body: string, orgId?: number): Promise<void> {
  await json(await fetch(`/api/chat${orgQ(orgId)}`, opts("POST", { body })));
}

// ----- root owner: users -----
export async function adminListUsers(): Promise<{ users: AdminUser[] }> {
  return json(await fetch("/api/admin/users", { credentials: "include" }));
}
export async function adminCreateUser(u: {
  email: string;
  password: string;
  name: string;
  role: string;
  org_id: number | null;
}): Promise<void> {
  await json(await fetch("/api/admin/users", opts("POST", u)));
}
export async function adminUpdateUser(
  id: number,
  patch: { name?: string; role?: string; org_id?: number },
): Promise<void> {
  await json(await fetch(`/api/admin/users/${id}`, opts("POST", patch)));
}
export async function adminResetPassword(id: number, password: string): Promise<void> {
  await json(await fetch(`/api/admin/users/${id}/password`, opts("POST", { password })));
}
export async function adminDeleteUser(id: number): Promise<void> {
  await json(await fetch(`/api/admin/users/${id}`, opts("DELETE")));
}

// ----- root owner: orgs -----
export async function adminListOrgs(): Promise<{ orgs: AdminOrg[] }> {
  return json(await fetch("/api/admin/orgs", { credentials: "include" }));
}
export async function adminCreateOrg(name: string, slug: string): Promise<void> {
  await json(await fetch("/api/admin/orgs", opts("POST", { name, slug })));
}
export async function adminRenameOrg(id: number, name: string): Promise<void> {
  await json(await fetch(`/api/admin/orgs/${id}`, opts("PUT", { name })));
}
export async function adminDeleteOrg(id: number): Promise<void> {
  await json(await fetch(`/api/admin/orgs/${id}`, opts("DELETE")));
}
