import {
  Box,
  Center,
  Flex,
  HStack,
  Icon,
  IconButton,
  Text,
  Tooltip,
  useColorMode,
  useToast,
} from "@chakra-ui/react";
import { MouseEvent as ReactMouseEvent, useCallback, useEffect, useRef, useState } from "react";
import { FiMoon, FiSun } from "react-icons/fi";
import useLocalStorageState from "use-local-storage-state";
import {
  VscArrowLeft,
  VscCloudUpload,
  VscCollapseAll,
  VscNewFile,
  VscNewFolder,
  VscOrganization,
  VscSearch,
  VscSettingsGear,
  VscSignOut,
} from "react-icons/vsc";

import ActivityBar, { Section } from "./ActivityBar";
import * as api from "./api";
import { FileRow, Me, OrgData, Workspace, WorkspaceDetail } from "./api";
import ChatChannels, { ChatTarget } from "./ChatChannels";
import CommandPalette, { PaletteItem } from "./CommandPalette";
import { fileIcon } from "./fileIcon";
import ChatView from "./ChatView";
import { ConfirmModal, PromptModal } from "./Dialogs";
import EditorPane from "./EditorPane";
import FileTree, { allFolderPaths, FileTreeHandle } from "./FileTree";
import Loader from "./Loader";
import Settings from "./Settings";
import SourceControl, { ChangeType, SessionChange } from "./SourceControl";
import { PanelHeader, PanelIconButton } from "./ui";
import WorkspaceSwitcher from "./WorkspaceSwitcher";

type Props = {
  me: Me;
  orgId?: number; // set when the owner is browsing a specific org
  onExit?: () => void; // back to the owner console
  onLogout: () => void;
  onUpdated?: () => void; // refresh `me` after a profile/2FA change
};

type PromptCfg = { title: string; label?: string; initial?: string; cta?: string; onSubmit: (v: string) => void };
type ConfirmCfg = { title: string; body: string; cta?: string; onConfirm: () => void };

// An editor group holds a set of open file ids and which one is active. There
// are one or two groups (split view). Files are stored by id and resolved to
// rows at render time, so a rename/move updates tabs automatically.
type GroupState = { fileIds: number[]; activeId: number | null };
const EMPTY_GROUPS: GroupState[] = [{ fileIds: [], activeId: null }];

function pruneGroups(gs: GroupState[], exist: Set<number>): GroupState[] {
  const mapped = gs.map((g) => {
    const ids = g.fileIds.filter((id) => exist.has(id));
    const activeId = g.activeId != null && ids.includes(g.activeId) ? g.activeId : ids[ids.length - 1] ?? null;
    return { fileIds: ids, activeId };
  });
  const pruned = mapped.filter((g) => g.fileIds.length > 0);
  return pruned.length ? pruned : [{ fileIds: [], activeId: null }];
}

function WorkspaceApp({ me, orgId, onExit, onLogout, onUpdated }: Props) {
  const toast = useToast();
  const { colorMode, toggleColorMode } = useColorMode();
  const [org, setOrg] = useState<OrgData | null>(null);
  const [activeWsId, setActiveWsId] = useState<number | null>(null);
  const [ws, setWs] = useState<WorkspaceDetail | null>(null);
  const [groups, setGroups] = useState<GroupState[]>(EMPTY_GROUPS);
  const [focused, setFocused] = useState(0);
  const [section, setSection] = useState<Section>("explorer");
  const [chatTarget, setChatTarget] = useState<ChatTarget>({ kind: "ws" });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [palette, setPalette] = useState<null | "files" | "commands">(null);
  const [sidebarW, setSidebarW] = useLocalStorageState<number>("cortex-sidebar-w", { defaultValue: 260 });
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [changes, setChanges] = useState<SessionChange[]>([]);
  const [prompt, setPrompt] = useState<PromptCfg | null>(null);
  const [confirm, setConfirm] = useState<ConfirmCfg | null>(null);

  const treeRef = useRef<FileTreeHandle>(null);
  const uploadInput = useRef<HTMLInputElement>(null);

  // VS Code-style shortcuts the browser lets us intercept. (Ctrl+T/W/N/Tab are
  // reserved by the browser itself and can't be captured by a web app.)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const k = e.key.toLowerCase();
      if (e.key === ",") {
        e.preventDefault();
        setSettingsOpen(true);
      } else if (k === "p" && e.shiftKey) {
        e.preventDefault();
        setPalette("commands");
      } else if (k === "p") {
        e.preventDefault();
        setPalette("files");
      } else if (k === "b") {
        e.preventDefault();
        setSidebarCollapsed((c) => !c);
      } else if (k === "s") {
        // Everything syncs live; swallow the browser's "save page" dialog.
        e.preventDefault();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const uploadDir = useRef<string>("");
  const editorLike = section === "explorer" || section === "scm";

  // Drag the sidebar's right edge to resize it (persisted).
  function startSidebarDrag(e: ReactMouseEvent) {
    e.preventDefault();
    const startX = e.clientX;
    const startW = sidebarW;
    const move = (ev: MouseEvent) =>
      setSidebarW(Math.min(520, Math.max(180, startW + ev.clientX - startX)));
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }

  const fail = (e: unknown) =>
    toast({
      title: e instanceof Error ? e.message : "Something went wrong",
      status: "error",
      duration: 3500,
    });

  const wsRef = useRef<Workspace[]>([]);

  const loadOrg = useCallback(async () => {
    const data = await api.getOrg(orgId);
    setOrg(data);
    wsRef.current = data.workspaces;
    setActiveWsId((cur) => {
      if (cur && data.workspaces.some((w) => w.id === cur)) return cur;
      if (orgId == null) {
        const slug = window.location.pathname.replace(/^\/+/, "").split("/")[0];
        const bySlug = data.workspaces.find((w) => w.slug === slug);
        if (bySlug) return bySlug.id;
      }
      return data.workspaces[0]?.id ?? null;
    });
    return data;
  }, [orgId]);

  useEffect(() => {
    loadOrg().catch(() => setOrg({ org: null, workspaces: [], members: [], isOwner: false }));
  }, [loadOrg]);

  // Keep the URL (/slug) in sync with the active workspace (member view only).
  useEffect(() => {
    if (orgId != null || activeWsId == null) return;
    const w = wsRef.current.find((x) => x.id === activeWsId);
    const cur = window.location.pathname.replace(/^\/+/, "").split("/")[0];
    if (w && cur !== w.slug) window.history.replaceState({}, "", "/" + w.slug);
  }, [activeWsId, orgId]);

  useEffect(() => {
    if (orgId != null) return;
    const onPop = () => {
      const slug = window.location.pathname.replace(/^\/+/, "").split("/")[0];
      const m = wsRef.current.find((w) => w.slug === slug);
      if (m) {
        setActiveWsId(m.id);
        setGroups(EMPTY_GROUPS);
        setFocused(0);
      }
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [orgId]);

  const loadWs = useCallback(() => {
    if (activeWsId == null) {
      setWs(null);
      return;
    }
    api
      .getWorkspace(activeWsId)
      .then((d) => {
        setWs(d);
        // Drop tabs for files that no longer exist (paths update automatically
        // since tabs are resolved from ids at render time).
        const exist = new Set(d.files.map((f) => f.id));
        setGroups((gs) => pruneGroups(gs, exist));
      })
      .catch(() => setWs(null));
  }, [activeWsId]);

  useEffect(loadWs, [loadWs]);

  // ----- session change tracking (feeds Source Control) -----
  function noteChange(id: number, path: string, type: ChangeType) {
    setChanges((prev) => {
      const existing = prev.find((c) => c.id === id);
      const finalType: ChangeType = existing?.type === "added" ? "added" : type;
      return [...prev.filter((c) => c.id !== id), { id, path, type: finalType }];
    });
  }
  const dropChange = (id: number) => setChanges((prev) => prev.filter((c) => c.id !== id));

  function selectWorkspace(id: number) {
    setActiveWsId(id);
    setGroups(EMPTY_GROUPS);
    setFocused(0);
    setSection("explorer");
    setChanges([]);
    if (orgId == null) {
      const w = wsRef.current.find((x) => x.id === id);
      if (w) window.history.pushState({}, "", "/" + w.slug);
    }
  }

  function openFile(file: FileRow) {
    setSettingsOpen(false); // opening a file leaves the Settings view
    setGroups((gs) => {
      const g = gs.map((x) => ({ ...x }));
      const cur = g[focused] ?? g[0];
      if (!cur.fileIds.includes(file.id)) cur.fileIds = [...cur.fileIds, file.id];
      cur.activeId = file.id;
      return g;
    });
    setSection((s) => (s === "explorer" || s === "scm" ? s : "explorer"));
  }

  function selectTab(gi: number, id: number) {
    setSettingsOpen(false); // selecting a file tab leaves Settings
    setGroups((gs) => gs.map((g, i) => (i === gi ? { ...g, activeId: id } : g)));
    setFocused(gi);
  }

  function focusGroup(gi: number) {
    setFocused(gi);
  }

  function closeTab(gi: number, id: number) {
    setGroups((gs) => {
      const mapped = gs.map((g, i) => {
        if (i !== gi) return g;
        const ids = g.fileIds.filter((x) => x !== id);
        return { fileIds: ids, activeId: g.activeId === id ? ids[ids.length - 1] ?? null : g.activeId };
      });
      const pruned = mapped.filter((g) => g.fileIds.length > 0);
      return pruned.length ? pruned : EMPTY_GROUPS;
    });
    setFocused(0);
  }

  function splitGroup(gi: number) {
    setGroups((gs) => {
      if (gs.length >= 2) return gs;
      const active = gs[gi]?.activeId;
      if (active == null) return gs;
      return [...gs, { fileIds: [active], activeId: active }];
    });
    setFocused(1);
  }

  function reorderTab(gi: number, id: number, toIndex: number) {
    setGroups((gs) =>
      gs.map((g, i) => {
        if (i !== gi) return g;
        const arr = g.fileIds.filter((x) => x !== id);
        arr.splice(Math.max(0, Math.min(toIndex, arr.length)), 0, id);
        return { fileIds: arr, activeId: g.activeId };
      }),
    );
  }

  function moveTab(fromG: number, id: number, toG: number) {
    if (fromG === toG) return;
    setGroups((gs) => {
      const g = gs.map((x) => ({ fileIds: [...x.fileIds], activeId: x.activeId }));
      if (!g[fromG] || !g[toG]) return gs;
      g[fromG].fileIds = g[fromG].fileIds.filter((x) => x !== id);
      if (g[fromG].activeId === id) g[fromG].activeId = g[fromG].fileIds[g[fromG].fileIds.length - 1] ?? null;
      if (!g[toG].fileIds.includes(id)) g[toG].fileIds = [...g[toG].fileIds, id];
      g[toG].activeId = id;
      const pruned = g.filter((x) => x.fileIds.length > 0);
      return pruned.length ? pruned : EMPTY_GROUPS;
    });
    setFocused(0);
  }

  // Open a file (dragged from the Explorer) into a specific group.
  function openInGroup(gi: number, fileId: number) {
    setGroups((gs) =>
      gs.map((g, i) =>
        i === gi
          ? { fileIds: g.fileIds.includes(fileId) ? g.fileIds : [...g.fileIds, fileId], activeId: fileId }
          : g,
      ),
    );
    setFocused(gi);
    setSection((s) => (s === "explorer" || s === "scm" ? s : "explorer"));
  }

  // Split into a second group holding the given file (drag to the right edge).
  function splitFile(fileId: number) {
    setGroups((gs) => {
      if (gs.length >= 2) {
        return gs.map((g, i) =>
          i === 1
            ? { fileIds: g.fileIds.includes(fileId) ? g.fileIds : [...g.fileIds, fileId], activeId: fileId }
            : g,
        );
      }
      return [...gs, { fileIds: [fileId], activeId: fileId }];
    });
    setFocused(1);
  }

  async function run(fn: () => Promise<unknown>, then?: () => void, ok?: string) {
    try {
      await fn();
      then?.();
      if (ok) toast({ title: ok, status: "success", duration: 2000 });
    } catch (e) {
      fail(e);
    }
  }

  function newWorkspace() {
    setPrompt({
      title: "New workspace",
      label: "Name",
      cta: "Create",
      onSubmit: (name) =>
        run(
          async () => {
            const { workspace } = await api.createWorkspace(name, orgId);
            await loadOrg();
            selectWorkspace(workspace.id);
          },
          undefined,
          "Workspace created",
        ),
    });
  }

  function renameWorkspace(w: Workspace) {
    setPrompt({
      title: "Rename workspace",
      label: "Name",
      initial: w.name,
      cta: "Rename",
      onSubmit: (name) => run(() => api.renameWorkspace(w.id, name), loadOrg),
    });
  }

  function deleteWorkspace(w: Workspace) {
    setConfirm({
      title: "Delete workspace",
      body: `Delete "${w.name}" and everything in it? This can't be undone.`,
      onConfirm: () =>
        run(
          () => api.deleteWorkspace(w.id),
          () => {
            setActiveWsId(null);
            loadOrg();
          },
        ),
    });
  }

  // ----- file operations (from the tree; inline create/rename, themed confirm) -----
  function createPath(path: string) {
    if (activeWsId == null) return;
    run(async () => {
      const { file } = await api.createFile(activeWsId, path);
      loadWs();
      if (!path.endsWith("/.keep")) {
        openFile(file);
        noteChange(file.id, file.path, "added");
      }
    });
  }

  function movePath(id: number, newPath: string) {
    run(() => api.moveFile(id, newPath), loadWs);
    noteChange(id, newPath, "renamed");
  }

  function requestUpload(dir: string) {
    uploadDir.current = dir;
    uploadInput.current?.click();
  }

  async function uploadFiles(dir: string, list: FileList | File[] | null) {
    if (!list || activeWsId == null) return;
    const files = Array.from(list);
    if (files.length === 0) return;
    for (const f of files) {
      try {
        const { file } = await api.uploadFile(activeWsId, f);
        const finalPath = dir ? `${dir}/${f.name}` : file.path;
        if (dir) await api.moveFile(file.id, finalPath);
        noteChange(file.id, finalPath, "added");
      } catch (e) {
        fail(e);
      }
    }
    loadWs();
    toast({ title: files.length === 1 ? "Uploaded" : `Uploaded ${files.length} files`, status: "success", duration: 1800 });
  }

  function deleteFiles(targets: FileRow[], label: string) {
    if (targets.length === 0) return;
    setConfirm({
      title: "Delete",
      body:
        targets.length === 1
          ? `Delete ${label}?`
          : `Delete ${label} and its ${targets.length} files? This can't be undone.`,
      onConfirm: () =>
        run(
          async () => {
            for (const f of targets) await api.deleteFile(f.id);
          },
          () => {
            targets.forEach((f) => dropChange(f.id));
            loadWs(); // prunes the deleted files out of any open editor groups
          },
        ),
    });
  }

  function toggleFolder(path: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  if (!org) return <Loader />;

  if (!org.org) {
    return (
      <Flex direction="column" h="100vh" bg="surface.bg" color="ink.base">
        <TopStrip onLogout={onLogout} onExit={onExit} colorMode={colorMode} toggleColorMode={toggleColorMode} />
        <Center flex={1} flexDirection="column" gap={3} px={6} textAlign="center">
          <Icon as={VscOrganization} fontSize="3xl" color="ink.subtle" />
          <Text fontSize="lg" fontWeight="semibold">
            You're not in an org yet
          </Text>
          <Text fontSize="sm" color="ink.muted" maxW="sm">
            The owner needs to assign your account to an org. Once they do, your
            team's workspaces and chat show up here.
          </Text>
        </Center>
      </Flex>
    );
  }

  const canManage = true;
  const activeWs = org.workspaces.find((w) => w.id === activeWsId);
  const allFiles = ws?.files ?? [];
  const filesById = new Map(allFiles.map((f) => [f.id, f]));
  const focusedIdx = Math.min(focused, groups.length - 1);
  const resolvedGroups = groups.map((g) => ({
    files: g.fileIds.map((id) => filesById.get(id)).filter((f): f is FileRow => !!f),
    activeFileId: g.activeId,
  }));
  const treeActiveId = editorLike ? groups[focusedIdx]?.activeId ?? null : null;

  // Quick Open (Ctrl+P): every real file in the workspace, openable by name.
  const fileItems: PaletteItem[] = allFiles
    .filter((f) => !f.path.endsWith("/.keep") && f.path !== ".keep")
    .map((f) => {
      const spec = fileIcon(f.path);
      return {
        id: f.id,
        label: f.path,
        icon: <Icon as={spec.icon} color={spec.color} />,
        run: () => openFile(f),
      };
    });

  // Command Palette (Ctrl+Shift+P): app actions. New file/folder need the
  // Explorer mounted, so switch to it first, then act on the next tick.
  const goExplorerThen = (fn: () => void) => {
    setSettingsOpen(false);
    setSidebarCollapsed(false);
    setSection("explorer");
    setTimeout(fn, 0);
  };
  const showSection = (s: Section) => {
    setSettingsOpen(false);
    setSidebarCollapsed(false);
    setSection(s);
  };
  const commandItems: PaletteItem[] = [
    { id: "goto", label: "Go to File…", hint: "Ctrl+P", icon: <Icon as={VscSearch} />, run: () => setPalette("files") },
    { id: "settings", label: "Open Settings", hint: "Ctrl+,", icon: <Icon as={VscSettingsGear} />, run: () => setSettingsOpen(true) },
    { id: "theme", label: `Switch to ${colorMode === "dark" ? "light" : "dark"} theme`, keywords: "color mode dark light", icon: <Icon as={colorMode === "dark" ? FiSun : FiMoon} />, run: toggleColorMode },
    { id: "sidebar", label: "Toggle Sidebar", hint: "Ctrl+B", run: () => setSidebarCollapsed((c) => !c) },
    { id: "newfile", label: "New File", icon: <Icon as={VscNewFile} />, run: () => goExplorerThen(() => treeRef.current?.startCreate("file")) },
    { id: "newfolder", label: "New Folder", icon: <Icon as={VscNewFolder} />, run: () => goExplorerThen(() => treeRef.current?.startCreate("folder")) },
    { id: "upload", label: "Upload Files…", icon: <Icon as={VscCloudUpload} />, run: () => requestUpload("") },
    { id: "newws", label: "New Workspace", icon: <Icon as={VscOrganization} />, run: newWorkspace },
    { id: "split", label: "Split Editor Right", run: () => splitGroup(focusedIdx) },
    { id: "explorer", label: "Show Explorer", keywords: "files tree", run: () => showSection("explorer") },
    { id: "scm", label: "Show Source Control", keywords: "changes git diff", run: () => showSection("scm") },
    { id: "chat", label: "Show Chat", keywords: "messages dm", run: () => showSection("chat") },
    { id: "collapse", label: "Collapse All Folders", run: () => setCollapsed(new Set(allFolderPaths(allFiles))) },
    { id: "signout", label: "Sign Out", icon: <Icon as={VscSignOut} />, run: onLogout },
  ];

  return (
    <Flex h="100vh" overflow="hidden" bg="surface.bg" color="ink.base">
      <ActivityBar
        section={section}
        onSelect={(s) => {
          if (settingsOpen) {
            setSettingsOpen(false);
            setSection(s);
            setSidebarCollapsed(false);
          } else if (s === section) {
            // Clicking the active icon toggles the side panel, like VS Code.
            setSidebarCollapsed((c) => !c);
          } else {
            setSection(s);
            setSidebarCollapsed(false);
          }
        }}
        changeCount={changes.length}
        me={me}
        onProfile={() => setSettingsOpen(true)}
        colorMode={colorMode}
        toggleColorMode={toggleColorMode}
        onLogout={onLogout}
        onExit={onExit}
      />

      {/* Side panel — Explorer, or Source Control */}
      <Flex
        as="nav"
        display={sidebarCollapsed ? "none" : "flex"}
        w={`${sidebarW}px`}
        flexShrink={0}
        direction="column"
        bg="surface.panel"
        borderRight="1px solid"
        borderColor="surface.border"
        overflow="hidden"
      >
        {section === "scm" ? (
          <SourceControl
            changes={changes}
            onClear={() => setChanges([])}
            onOpen={(id) => {
              const f = ws?.files.find((x) => x.id === id);
              if (f) openFile(f);
            }}
          />
        ) : section === "chat" ? (
          <Flex direction="column" flex={1} minH={0}>
            {org.workspaces.length > 0 && (
              <Box px={3} pt={3} pb={2}>
                <WorkspaceSwitcher
                  workspaces={org.workspaces}
                  activeWsId={activeWsId}
                  activeWs={activeWs}
                  onSelect={selectWorkspace}
                  onNew={newWorkspace}
                  onRename={renameWorkspace}
                  onDelete={deleteWorkspace}
                />
              </Box>
            )}
            <ChatChannels
              me={me}
              workspaceId={activeWsId}
              members={org.members}
              target={chatTarget}
              onSelect={setChatTarget}
            />
          </Flex>
        ) : (
          <Box flex={1} overflowY="auto" pb={2}>
            {/* Workspace switcher — org name intentionally hidden. */}
            <Box px={3} pt={3} pb={2}>
              <WorkspaceSwitcher
                workspaces={org.workspaces}
                activeWsId={activeWsId}
                activeWs={activeWs}
                onSelect={selectWorkspace}
                onNew={newWorkspace}
                onRename={renameWorkspace}
                onDelete={deleteWorkspace}
              />
            </Box>

            {activeWs && (
              <>
                <PanelHeader
                  title="Explorer"
                  actions={
                    <>
                      <Tooltip label="New file" openDelay={400}>
                        <PanelIconButton
                          aria-label="New file"
                          icon={<VscNewFile />}
                          onClick={() => treeRef.current?.startCreate("file")}
                        />
                      </Tooltip>
                      <Tooltip label="New folder" openDelay={400}>
                        <PanelIconButton
                          aria-label="New folder"
                          icon={<VscNewFolder />}
                          onClick={() => treeRef.current?.startCreate("folder")}
                        />
                      </Tooltip>
                      <Tooltip label="Upload" openDelay={400}>
                        <PanelIconButton
                          aria-label="Upload files"
                          icon={<VscCloudUpload />}
                          onClick={() => requestUpload("")}
                        />
                      </Tooltip>
                      <Tooltip label="Collapse all" openDelay={400}>
                        <PanelIconButton
                          aria-label="Collapse all folders"
                          icon={<VscCollapseAll />}
                          onClick={() => {
                            const folders = allFolderPaths(allFiles);
                            const allCollapsed =
                              folders.length > 0 && folders.every((p) => collapsed.has(p));
                            setCollapsed(allCollapsed ? new Set() : new Set(folders));
                          }}
                        />
                      </Tooltip>
                    </>
                  }
                />
                <Box px={2}>
                  <FileTree
                    ref={treeRef}
                    files={allFiles}
                    rootName={activeWs.name}
                    activeFileId={treeActiveId}
                    collapsed={collapsed}
                    onToggle={toggleFolder}
                    onOpen={openFile}
                    onDownload={(f) => api.downloadFile(f).catch(fail)}
                    onDelete={deleteFiles}
                    onMove={movePath}
                    onCreate={createPath}
                    onUpload={requestUpload}
                    onUploadFiles={uploadFiles}
                  />
                  {allFiles.length === 0 && (
                    <Text fontSize="xs" color="ink.subtle" px={2} py={2}>
                      No files yet. Right-click, use the buttons above, or drop files here.
                    </Text>
                  )}
                </Box>
              </>
            )}
          </Box>
        )}
      </Flex>

      {/* Draggable edge to resize the sidebar. */}
      {!sidebarCollapsed && (
        <Box
          w="5px"
          flexShrink={0}
          cursor="col-resize"
          bg="surface.border"
          _hover={{ bg: "brand.500" }}
          onMouseDown={startSidebarDrag}
        />
      )}

      {/* Main pane */}
      {section === "chat" && !settingsOpen ? (
        <ChatView
          me={me}
          orgId={orgId}
          workspaceId={activeWsId}
          members={org.members}
          isAdmin={me.role === "admin" || me.role === "root"}
          target={chatTarget}
        />
      ) : (
        <EditorPane
          groups={resolvedGroups}
          focused={focusedIdx}
          userLabel={me.name || me.email}
          canManage={canManage}
          onSelectTab={selectTab}
          onCloseTab={closeTab}
          onFocusGroup={focusGroup}
          onSplit={splitGroup}
          onReorder={reorderTab}
          onMoveTab={moveTab}
          onOpenInGroup={openInGroup}
          onSplitFile={splitFile}
          settingsActive={settingsOpen}
          settingsNode={
            <Settings me={me} onClose={() => setSettingsOpen(false)} onUpdated={() => onUpdated?.()} />
          }
          onCloseSettings={() => setSettingsOpen(false)}
        />
      )}

      <input
        ref={uploadInput}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          uploadFiles(uploadDir.current, e.target.files);
          e.target.value = "";
        }}
      />

      <PromptModal
        isOpen={!!prompt}
        title={prompt?.title ?? ""}
        label={prompt?.label}
        initial={prompt?.initial}
        cta={prompt?.cta}
        onSubmit={(v) => prompt?.onSubmit(v)}
        onClose={() => setPrompt(null)}
      />
      <ConfirmModal
        isOpen={!!confirm}
        title={confirm?.title ?? ""}
        body={confirm?.body ?? ""}
        cta={confirm?.cta}
        onConfirm={() => confirm?.onConfirm()}
        onClose={() => setConfirm(null)}
      />
      <CommandPalette
        isOpen={palette !== null}
        onClose={() => setPalette(null)}
        placeholder={palette === "commands" ? "Type a command…" : "Search files by name…"}
        items={palette === "commands" ? commandItems : fileItems}
      />
    </Flex>
  );
}

function TopStrip({
  onLogout,
  onExit,
  colorMode,
  toggleColorMode,
}: {
  onLogout: () => void;
  onExit?: () => void;
  colorMode: string;
  toggleColorMode: () => void;
}) {
  return (
    <HStack px={4} h={12} borderBottom="1px solid" borderColor="surface.border" bg="surface.panel">
      {onExit && (
        <IconButton aria-label="Back" icon={<VscArrowLeft />} size="sm" variant="ghost" onClick={onExit} />
      )}
      <Box flex={1} />
      <IconButton
        aria-label="Toggle color mode"
        icon={colorMode === "dark" ? <FiSun /> : <FiMoon />}
        size="sm"
        variant="ghost"
        color="ink.muted"
        onClick={toggleColorMode}
      />
      <IconButton aria-label="Sign out" icon={<VscSignOut />} size="sm" variant="ghost" color="ink.muted" onClick={onLogout} />
    </HStack>
  );
}

export default WorkspaceApp;
