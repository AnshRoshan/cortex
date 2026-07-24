import {
  Avatar,
  Badge,
  Box,
  Button,
  Center,
  Flex,
  HStack,
  Icon,
  IconButton,
  Menu,
  MenuButton,
  MenuDivider,
  MenuItem,
  MenuList,
  Text,
  Tooltip,
  VStack,
  useColorMode,
  useToast,
} from "@chakra-ui/react";
import { ElementType, useCallback, useEffect, useRef, useState } from "react";
import { FiMoon, FiSun } from "react-icons/fi";
import {
  VscAdd,
  VscArrowLeft,
  VscCheck,
  VscChevronDown,
  VscCollapseAll,
  VscComment,
  VscDesktopDownload,
  VscFile,
  VscFileBinary,
  VscNewFile,
  VscNewFolder,
  VscOrganization,
  VscSignOut,
  VscTrash,
} from "react-icons/vsc";

import * as api from "./api";
import { FileRow, Me, OrgData, Workspace, WorkspaceDetail } from "./api";
import ChatView from "./ChatView";
import DocumentsView from "./DocumentsView";
import EditorPane from "./EditorPane";
import FileTree, { allFolderPaths } from "./FileTree";
import Loader from "./Loader";
import Profile from "./Profile";

type View = "editor" | "documents" | "chat" | "members";

type Props = {
  me: Me;
  orgId?: number; // set when the owner is browsing a specific org
  onExit?: () => void; // back to the owner console
  onLogout: () => void;
};

function WorkspaceApp({ me, orgId, onExit, onLogout }: Props) {
  const toast = useToast();
  const { colorMode, toggleColorMode } = useColorMode();
  const [org, setOrg] = useState<OrgData | null>(null);
  const [activeWsId, setActiveWsId] = useState<number | null>(null);
  const [ws, setWs] = useState<WorkspaceDetail | null>(null);
  const [openFiles, setOpenFiles] = useState<FileRow[]>([]);
  const [activeFileId, setActiveFileId] = useState<number | null>(null);
  const [view, setView] = useState<View>("editor");
  const [profileOpen, setProfileOpen] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const fail = (e: unknown) =>
    toast({
      title: e instanceof Error ? e.message : "Something went wrong",
      status: "error",
      duration: 3500,
    });

  // Latest workspaces, for URL/slug resolution without stale closures.
  const wsRef = useRef<Workspace[]>([]);

  const loadOrg = useCallback(async () => {
    const data = await api.getOrg(orgId);
    setOrg(data);
    wsRef.current = data.workspaces;
    setActiveWsId((cur) => {
      if (cur && data.workspaces.some((w) => w.id === cur)) return cur;
      // Member view: honor the workspace slug in the URL.
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

  // Browser back/forward switches workspace.
  useEffect(() => {
    if (orgId != null) return;
    const onPop = () => {
      const slug = window.location.pathname.replace(/^\/+/, "").split("/")[0];
      const m = wsRef.current.find((w) => w.slug === slug);
      if (m) {
        setActiveWsId(m.id);
        setOpenFiles([]);
        setActiveFileId(null);
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
        setOpenFiles((tabs) => tabs.filter((t) => d.files.some((f) => f.id === t.id)));
      })
      .catch(() => setWs(null));
  }, [activeWsId]);

  useEffect(loadWs, [loadWs]);

  function selectWorkspace(id: number) {
    setActiveWsId(id);
    setOpenFiles([]);
    setActiveFileId(null);
    setView("editor");
    if (orgId == null) {
      const w = wsRef.current.find((x) => x.id === id);
      if (w) window.history.pushState({}, "", "/" + w.slug);
    }
  }

  function openFile(file: FileRow) {
    setOpenFiles((tabs) => (tabs.some((t) => t.id === file.id) ? tabs : [...tabs, file]));
    setActiveFileId(file.id);
    setView("editor");
  }

  function closeTab(id: number) {
    setOpenFiles((tabs) => {
      const next = tabs.filter((t) => t.id !== id);
      setActiveFileId((cur) => (cur === id ? next[next.length - 1]?.id ?? null : cur));
      return next;
    });
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
    const name = prompt("New workspace name:");
    if (!name?.trim()) return;
    run(
      async () => {
        const { workspace } = await api.createWorkspace(name.trim(), orgId);
        await loadOrg();
        selectWorkspace(workspace.id);
      },
      undefined,
      "Workspace created",
    );
  }

  function newFile() {
    if (activeWsId == null) return;
    const path = prompt("New file path (e.g. src/main.py):");
    if (!path?.trim()) return;
    run(
      async () => {
        const { file } = await api.createFile(activeWsId, path.trim());
        loadWs();
        openFile(file);
      },
      undefined,
      "File created",
    );
  }

  // Folders are implicit (from paths), so a new folder is seeded with a
  // placeholder file so it shows up in the tree.
  function newFolder() {
    if (activeWsId == null) return;
    const name = prompt("New folder name:");
    if (!name?.trim()) return;
    run(() => api.createFile(activeWsId, `${name.trim()}/.keep`), loadWs, "Folder created");
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

  // Not assigned to an org (normal user waiting for the owner).
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

  const canManage = true; // any org member has full access within the org
  const activeWs = org.workspaces.find((w) => w.id === activeWsId);

  return (
    <Flex h="100vh" overflow="hidden" bg="surface.bg" color="ink.base">
      {/* Sidebar */}
      <Flex
        as="nav"
        w={{ base: "248px", lg: "272px" }}
        flexShrink={0}
        direction="column"
        bg="surface.panel"
        borderRight="1px solid"
        borderColor="surface.border"
      >
        <Box flex={1} overflowY="auto" p={3}>
          {onExit && (
            <Button
              size="xs"
              variant="ghost"
              leftIcon={<Icon as={VscArrowLeft} />}
              mb={2}
              color="ink.muted"
              onClick={onExit}
            >
              Owner console
            </Button>
          )}

          {/* Workspace switcher — change or create. Org name intentionally hidden. */}
          <Menu matchWidth>
            <MenuButton
              as={Button}
              w="full"
              mb={4}
              variant="outline"
              borderColor="surface.borderStrong"
              bg="surface.raised"
              textAlign="left"
              fontWeight={600}
              rightIcon={<Icon as={VscChevronDown} color="ink.muted" />}
              _hover={{ borderColor: "brand.500" }}
            >
              <HStack spacing={2} minW={0}>
                <Box boxSize={2} bg="brand.500" borderRadius="2px" flexShrink={0} />
                <Text isTruncated>{activeWs?.name ?? "Select workspace"}</Text>
              </HStack>
            </MenuButton>
            <MenuList bg="surface.raised" borderColor="surface.border" boxShadow="pop" py={1}>
              {org.workspaces.map((w) => (
                <MenuItem
                  key={w.id}
                  bg="transparent"
                  _hover={{ bg: "surface.hover" }}
                  fontSize="sm"
                  onClick={() => selectWorkspace(w.id)}
                >
                  <HStack w="full" spacing={2}>
                    <Box
                      boxSize={2}
                      borderRadius="2px"
                      bg={w.id === activeWsId ? "brand.500" : "surface.borderStrong"}
                    />
                    <Text flex={1} isTruncated>
                      {w.name}
                    </Text>
                    {w.id === activeWsId && <Icon as={VscCheck} color="brand.400" />}
                  </HStack>
                </MenuItem>
              ))}
              {org.workspaces.length > 0 && <MenuDivider borderColor="surface.border" />}
              <MenuItem
                bg="transparent"
                _hover={{ bg: "surface.hover" }}
                color="brand.400"
                fontSize="sm"
                icon={<Icon as={VscAdd} />}
                onClick={newWorkspace}
              >
                New workspace…
              </MenuItem>
              {activeWs && (
                <>
                  <MenuDivider borderColor="surface.border" />
                  <MenuItem
                    bg="transparent"
                    _hover={{ bg: "surface.hover" }}
                    fontSize="sm"
                    onClick={() => {
                      const n = prompt("Rename workspace", activeWs.name);
                      if (n?.trim()) run(() => api.renameWorkspace(activeWs.id, n.trim()), loadOrg);
                    }}
                  >
                    Rename “{activeWs.name}”
                  </MenuItem>
                  <MenuItem
                    bg="transparent"
                    _hover={{ bg: "surface.hover" }}
                    color="red.400"
                    fontSize="sm"
                    onClick={() => {
                      if (confirm(`Delete workspace "${activeWs.name}"?`))
                        run(
                          () => api.deleteWorkspace(activeWs.id),
                          () => {
                            setActiveWsId(null);
                            loadOrg();
                          },
                        );
                    }}
                  >
                    Delete workspace
                  </MenuItem>
                </>
              )}
            </MenuList>
          </Menu>

          {/* Files in the active workspace */}
          {activeWs && (
            <>
              <Flex align="center" justify="space-between" px={1} mb={1}>
                <Text fontSize="xs" fontWeight="bold" textTransform="uppercase" color="ink.subtle">
                  Files
                </Text>
                <HStack spacing={0}>
                  <Tooltip label="New file">
                    <IconButton
                      aria-label="New file"
                      icon={<VscNewFile />}
                      size="xs"
                      variant="ghost"
                      color="ink.muted"
                      _hover={{ bg: "surface.hover", color: "ink.base" }}
                      onClick={newFile}
                    />
                  </Tooltip>
                  <Tooltip label="New folder">
                    <IconButton
                      aria-label="New folder"
                      icon={<VscNewFolder />}
                      size="xs"
                      variant="ghost"
                      color="ink.muted"
                      _hover={{ bg: "surface.hover", color: "ink.base" }}
                      onClick={newFolder}
                    />
                  </Tooltip>
                  <Tooltip label="Collapse all">
                    <IconButton
                      aria-label="Collapse all folders"
                      icon={<VscCollapseAll />}
                      size="xs"
                      variant="ghost"
                      color="ink.muted"
                      _hover={{ bg: "surface.hover", color: "ink.base" }}
                      onClick={() => {
                        const folders = allFolderPaths(
                          ws?.files.filter((f) => f.kind !== "binary") ?? [],
                        );
                        const allCollapsed =
                          folders.length > 0 && folders.every((p) => collapsed.has(p));
                        setCollapsed(allCollapsed ? new Set() : new Set(folders));
                      }}
                    />
                  </Tooltip>
                </HStack>
              </Flex>
              <Box mb={4}>
                {(ws?.files.filter((f) => f.kind !== "binary").length ?? 0) === 0 ? (
                  <Text fontSize="xs" color="ink.subtle" px={2} py={1}>
                    No files yet.
                  </Text>
                ) : (
                  <FileTree
                    files={ws?.files.filter((f) => f.kind !== "binary") ?? []}
                    activeFileId={view === "editor" ? activeFileId : null}
                    collapsed={collapsed}
                    onToggle={toggleFolder}
                    onOpen={openFile}
                    onDownload={(f) => api.downloadFile(f).catch(fail)}
                    onDelete={(f) => {
                      if (confirm(`Delete ${f.path}?`))
                        run(() => api.deleteFile(f.id), () => {
                          closeTab(f.id);
                          loadWs();
                        });
                    }}
                    onMove={(fileId, newPath) => run(() => api.moveFile(fileId, newPath), loadWs)}
                  />
                )}
              </Box>
            </>
          )}
        </Box>

        {/* Documents / Chat / Members — pinned to the bottom */}
        <VStack
          align="stretch"
          spacing={0}
          px={3}
          py={2}
          borderTop="1px solid"
          borderColor="surface.border"
        >
          {activeWs && (
            <NavButton
              icon={VscFileBinary}
              label="Documents"
              count={ws?.files.filter((f) => f.kind === "binary").length}
              active={view === "documents"}
              onClick={() => setView("documents")}
            />
          )}
          <NavButton icon={VscComment} label="Chat" active={view === "chat"} onClick={() => setView("chat")} />
          <NavButton
            icon={VscOrganization}
            label="Members"
            count={org.members.length}
            active={view === "members"}
            onClick={() => setView("members")}
          />
        </VStack>

        {/* Footer / profile */}
        <HStack px={2.5} py={2.5} spacing={2} borderTop="1px solid" borderColor="surface.border">
          <HStack
            flex={1}
            minW={0}
            p={1}
            spacing={2.5}
            borderRadius="md"
            cursor="pointer"
            _hover={{ bg: "surface.hover" }}
            onClick={() => setProfileOpen(true)}
          >
            <Avatar size="xs" name={me.name || me.email} bg="brand.600" color="white" />
            <Text fontSize="xs" color="ink.base" isTruncated>
              {me.name || me.email}
            </Text>
          </HStack>
          <Tooltip label={colorMode === "dark" ? "Light mode" : "Dark mode"}>
            <IconButton
              aria-label="Toggle color mode"
              icon={colorMode === "dark" ? <FiSun /> : <FiMoon />}
              size="sm"
              variant="ghost"
              color="ink.muted"
              onClick={toggleColorMode}
            />
          </Tooltip>
          <Tooltip label="Sign out">
            <IconButton
              aria-label="Sign out"
              icon={<VscSignOut />}
              size="sm"
              variant="ghost"
              color="ink.muted"
              onClick={onLogout}
            />
          </Tooltip>
        </HStack>
      </Flex>

      {/* Main pane */}
      {view === "documents" && activeWsId != null ? (
        <DocumentsView
          files={ws?.files ?? []}
          workspaceId={activeWsId}
          canManage={canManage}
          onOpenFile={openFile}
          onChanged={loadWs}
        />
      ) : view === "chat" ? (
        <ChatView me={me} orgId={orgId} />
      ) : view === "members" ? (
        <MembersPane org={org} />
      ) : (
        <EditorPane
          openFiles={openFiles}
          activeFileId={activeFileId}
          userLabel={me.name || me.email}
          canManage={canManage}
          onSelectTab={setActiveFileId}
          onCloseTab={closeTab}
        />
      )}

      <Profile me={me} isOpen={profileOpen} onClose={() => setProfileOpen(false)} onUpdated={() => {}} />
    </Flex>
  );
}

function NavButton({
  icon,
  label,
  count,
  active,
  onClick,
}: {
  icon: ElementType;
  label: string;
  count?: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      mt={1}
      size="sm"
      w="full"
      justifyContent="flex-start"
      leftIcon={<Icon as={icon} />}
      variant={active ? "solid" : "ghost"}
      color={active ? undefined : "ink.muted"}
      _hover={active ? undefined : { bg: "surface.hover", color: "ink.base" }}
      onClick={onClick}
    >
      <Text flex={1} textAlign="left">
        {label}
      </Text>
      {count != null && (
        <Badge bg={active ? "whiteAlpha.300" : "surface.raised"} color="inherit" fontSize="0.65rem">
          {count}
        </Badge>
      )}
    </Button>
  );
}

function MembersPane({ org }: { org: OrgData }) {
  return (
    <Box flex={1} minW={0} overflowY="auto" p={6} bg="surface.bg">
      <Text fontSize="md" fontWeight="semibold" mb={4}>
        Members
      </Text>
      <VStack align="stretch" spacing={1} maxW="560px">
        {org.members.map((m) => (
          <HStack key={m.id} p={2} borderRadius="md" _hover={{ bg: "surface.hover" }}>
            <Avatar size="sm" name={m.name || m.email} bg="brand.600" color="white" />
            <Box flex={1} minW={0}>
              <Text fontSize="sm" isTruncated>
                {m.name || m.email}
              </Text>
              {m.name && (
                <Text fontSize="xs" color="ink.subtle" isTruncated>
                  {m.email}
                </Text>
              )}
            </Box>
            {m.role === "admin" && (
              <Badge colorScheme="brand" variant="subtle">
                admin
              </Badge>
            )}
          </HStack>
        ))}
      </VStack>
    </Box>
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
