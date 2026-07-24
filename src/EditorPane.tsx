import {
  Avatar,
  AvatarGroup,
  Box,
  Button,
  Center,
  Flex,
  HStack,
  Icon,
  Select,
  Text,
  Tooltip,
  useColorMode,
  useToast,
} from "@chakra-ui/react";
import Editor, { type Monaco } from "@monaco-editor/react";
import { KeyCode, KeyMod, editor } from "monaco-editor/esm/vs/editor/editor.api";
import { useEffect, useRef, useState } from "react";
import { VscChromeClose, VscCircleFilled, VscDesktopDownload } from "react-icons/vsc";

import * as api from "./api";
import { FileRow } from "./api";
import BinaryView from "./BinaryView";
import Logo from "./Logo";
import Rustpad, { UserInfo } from "./rustpad";

type Connection = "connected" | "disconnected" | "desynchronized";

type EditorPaneProps = {
  openFiles: FileRow[];
  activeFileId: number | null;
  userLabel: string;
  canManage: boolean;
  onSelectTab: (id: number) => void;
  onCloseTab: (id: number) => void;
};

function getWsUri(docId: string) {
  const url = new URL(`api/socket/${docId}`, window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.href;
}

// Stable hue from a string, so each user keeps a consistent cursor color.
function hueFromString(s: string) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return h;
}

const EXT_TO_LANG: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  py: "python",
  rs: "rust",
  go: "go",
  java: "java",
  c: "c",
  cpp: "cpp",
  cs: "csharp",
  json: "json",
  md: "markdown",
  html: "html",
  css: "css",
  sh: "shell",
  sql: "sql",
  yml: "yaml",
  yaml: "yaml",
  toml: "toml",
};

function extToLang(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return EXT_TO_LANG[ext] ?? "plaintext";
}

// Languages offered in the manual override (covers the auto-detected set + more).
const LANGUAGES = [
  "plaintext",
  "javascript",
  "typescript",
  "python",
  "rust",
  "go",
  "java",
  "c",
  "cpp",
  "csharp",
  "json",
  "markdown",
  "html",
  "css",
  "scss",
  "shell",
  "sql",
  "yaml",
  "toml",
  "xml",
  "php",
  "ruby",
];

function countWords(text: string): number {
  const m = text.match(/\S+/g);
  return m ? m.length : 0;
}

// Graphite Monaco themes so the editor matches the app surfaces in both modes.
function defineThemes(monaco: Monaco) {
  monaco.editor.defineTheme("cortex-dark", {
    base: "vs-dark",
    inherit: true,
    rules: [],
    colors: {
      "editor.background": "#15171c",
      "editorGutter.background": "#15171c",
      "editor.lineHighlightBackground": "#1b1e25",
      "editorLineNumber.foreground": "#4b5160",
      "editorLineNumber.activeForeground": "#a1a6b0",
      "editorIndentGuide.background1": "#23262e",
    },
  });
  monaco.editor.defineTheme("cortex-light", {
    base: "vs",
    inherit: true,
    rules: [],
    colors: {
      "editor.background": "#ffffff",
      "editorGutter.background": "#ffffff",
      "editor.lineHighlightBackground": "#f4f5f7",
      "editorLineNumber.foreground": "#b3b8c2",
      "editorLineNumber.activeForeground": "#565c67",
      "editorIndentGuide.background1": "#e3e5ea",
    },
  });
}

function EditorPane({
  openFiles,
  activeFileId,
  userLabel,
  canManage,
  onSelectTab,
  onCloseTab,
}: EditorPaneProps) {
  const toast = useToast();
  const { colorMode } = useColorMode();
  const [monaco, setMonaco] = useState<editor.IStandaloneCodeEditor>();
  const [connection, setConnection] = useState<Connection>("disconnected");
  const [users, setUsers] = useState<Record<number, UserInfo>>({});
  const rustpad = useRef<Rustpad>();

  // Status bar + editor controls.
  const [fontSize, setFontSize] = useState(13);
  const [pos, setPos] = useState({ ln: 1, col: 1 });
  const [counts, setCounts] = useState({ rows: 0, words: 0, chars: 0 });
  const [langOverride, setLangOverride] = useState<string | null>(null);

  // Latest tab state, so keybindings registered once on mount always act on it.
  const stateRef = useRef({ openFiles, activeFileId, onSelectTab, onCloseTab });
  stateRef.current = { openFiles, activeFileId, onSelectTab, onCloseTab };
  const wrapOn = useRef(true);

  function setFont(v: number) {
    const n = Math.max(8, Math.min(48, v));
    setFontSize(n);
    monaco?.updateOptions({ fontSize: n });
  }

  function recount(ed: editor.IStandaloneCodeEditor) {
    const model = ed.getModel();
    if (!model) return;
    const value = model.getValue();
    setCounts({
      rows: model.getLineCount(),
      words: countWords(value),
      chars: value.length,
    });
  }

  function cycleTab(dir: number) {
    const { openFiles, activeFileId, onSelectTab } = stateRef.current;
    if (openFiles.length < 2) return;
    const idx = openFiles.findIndex((f) => f.id === activeFileId);
    const next = (idx + dir + openFiles.length) % openFiles.length;
    onSelectTab(openFiles[next].id);
  }

  function handleMount(ed: editor.IStandaloneCodeEditor) {
    setMonaco(ed);

    // Command palette (F1 / Ctrl+Shift+P) — bound explicitly for reliability.
    ed.addCommand(KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyP, () => {
      ed.trigger("keyboard", "editor.action.quickCommand", {});
    });

    // Toggle word wrap with Alt+Z (VS Code parity).
    ed.addCommand(KeyMod.Alt | KeyCode.KeyZ, () => {
      wrapOn.current = !wrapOn.current;
      ed.updateOptions({ wordWrap: wrapOn.current ? "on" : "off" });
    });

    // Switch tabs: Ctrl+Tab / Ctrl+Shift+Tab.
    ed.addCommand(KeyMod.CtrlCmd | KeyCode.Tab, () => cycleTab(1));
    ed.addCommand(KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.Tab, () => cycleTab(-1));

    // Close the active tab with Ctrl+W (Monaco swallows the browser default).
    ed.addCommand(KeyMod.CtrlCmd | KeyCode.KeyW, () => {
      const { activeFileId, onCloseTab } = stateRef.current;
      if (activeFileId != null) onCloseTab(activeFileId);
    });

    // Status bar: track cursor + document counts.
    ed.onDidChangeCursorPosition((e) =>
      setPos({ ln: e.position.lineNumber, col: e.position.column }),
    );
    ed.onDidChangeModelContent(() => recount(ed));
    recount(ed);

    // Font zoom: Ctrl+= / Ctrl+- / Ctrl+0 (functional update avoids stale state).
    const bump = (d: number) =>
      setFontSize((prev) => {
        const n = Math.max(8, Math.min(48, prev + d));
        ed.updateOptions({ fontSize: n });
        return n;
      });
    const reset = () => {
      setFontSize(13);
      ed.updateOptions({ fontSize: 13 });
    };
    // Bind every "+" / "-" variant: "+" is usually Ctrl+Shift+=, plus the
    // numpad keys. Without these the browser's page-zoom swallows the shortcut.
    ed.addCommand(KeyMod.CtrlCmd | KeyCode.Equal, () => bump(1));
    ed.addCommand(KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.Equal, () => bump(1));
    ed.addCommand(KeyMod.CtrlCmd | KeyCode.NumpadAdd, () => bump(1));
    ed.addCommand(KeyMod.CtrlCmd | KeyCode.Minus, () => bump(-1));
    ed.addCommand(KeyMod.CtrlCmd | KeyCode.NumpadSubtract, () => bump(-1));
    ed.addCommand(KeyMod.CtrlCmd | KeyCode.Digit0, reset);
    ed.addCommand(KeyMod.CtrlCmd | KeyCode.Numpad0, reset);
  }

  const activeFile = openFiles.find((f) => f.id === activeFileId);
  const isBinary = activeFile?.kind === "binary";
  // Only text files connect to the collaborative engine.
  const docId = isBinary ? undefined : activeFile?.doc_id;
  const autoLang = activeFile ? extToLang(activeFile.path) : "plaintext";
  // Manual override wins over the extension-based guess (e.g. a .mpy → Python).
  const language = langOverride ?? autoLang;

  // Reset the language override when switching files.
  useEffect(() => {
    setLangOverride(null);
  }, [docId]);

  // (Re)connect the collaborative engine whenever the active document changes.
  useEffect(() => {
    if (monaco?.getModel() && docId) {
      const model = monaco.getModel()!;
      model.setValue("");
      model.setEOL(0); // LF
      rustpad.current = new Rustpad({
        uri: getWsUri(docId),
        editor: monaco,
        onConnected: () => setConnection("connected"),
        onDisconnected: () => setConnection("disconnected"),
        onDesynchronized: () => setConnection("desynchronized"),
        onChangeUsers: setUsers,
      });
      return () => {
        rustpad.current?.dispose();
        rustpad.current = undefined;
        setUsers({});
      };
    }
  }, [docId, monaco]);

  useEffect(() => {
    if (connection === "connected") {
      rustpad.current?.setInfo({ name: userLabel, hue: hueFromString(userLabel) });
    }
  }, [connection, userLabel]);

  if (openFiles.length === 0) {
    return (
      <Center flex={1} minW={0} flexDirection="column" gap={4} bg="surface.bg" px={6} textAlign="center">
        <Box opacity={0.45}>
          <Logo size={48} />
        </Box>
        <Box>
          <Text fontSize="lg" fontWeight="semibold" color="ink.base">
            No file open
          </Text>
          <Text fontSize="sm" color="ink.muted" mt={1.5} maxW="xs">
            Open a file from the sidebar to edit together in real time, or browse
            Documents for uploads.
          </Text>
        </Box>
      </Center>
    );
  }

  const collaborators = Object.values(users);
  const connectionColor =
    connection === "connected"
      ? "green.400"
      : connection === "desynchronized"
        ? "red.400"
        : "orange.300";

  return (
    <Flex flex={1} minW={0} direction="column" overflow="hidden" bg="surface.bg">
      {/* Tab bar */}
      <Flex
        h={10}
        bg="surface.panel"
        borderBottom="1px solid"
        borderColor="surface.border"
        align="stretch"
        flexShrink={0}
      >
        <Flex align="stretch" overflowX="auto" flex={1} minW={0}>
          {openFiles.map((f) => {
            const active = f.id === activeFileId;
            return (
              <HStack
                key={f.id}
                px={3}
                spacing={2}
                cursor="pointer"
                role="group"
                bg={active ? "surface.bg" : "transparent"}
                color={active ? "ink.base" : "ink.muted"}
                borderRight="1px solid"
                borderColor="surface.border"
                borderBottom="2px solid"
                borderBottomColor={active ? "brand.500" : "transparent"}
                _hover={{ color: "ink.base" }}
                transition="color 0.12s ease"
                onClick={() => onSelectTab(f.id)}
              >
                <Text fontSize="sm" whiteSpace="nowrap">
                  {f.path.split("/").pop()}
                </Text>
                <Icon
                  as={VscChromeClose}
                  fontSize="sm"
                  color="ink.subtle"
                  opacity={active ? 1 : 0}
                  _groupHover={{ opacity: 1 }}
                  _hover={{ color: "red.300" }}
                  onClick={(e) => {
                    e.stopPropagation();
                    onCloseTab(f.id);
                  }}
                />
              </HStack>
            );
          })}
        </Flex>

        <HStack flexShrink={0} px={3} spacing={3}>
          {canManage && activeFile && (
            <Button
              size="xs"
              leftIcon={<VscDesktopDownload />}
              colorScheme="green"
              variant="outline"
              onClick={() =>
                activeFile &&
                api.downloadFile(activeFile).catch(() =>
                  toast({ title: "Download failed", status: "error", duration: 3000 }),
                )
              }
            >
              Download
            </Button>
          )}
          <Tooltip label={`Editor is ${connection}`} openDelay={300}>
            <HStack spacing={1.5} color={connectionColor}>
              <Icon as={VscCircleFilled} fontSize="0.6rem" />
              <Text fontSize="xs" fontWeight={500} textTransform="capitalize">
                {connection}
              </Text>
            </HStack>
          </Tooltip>
          {collaborators.length > 0 && (
            <AvatarGroup size="xs" max={4}>
              {collaborators.map((u, i) => (
                <Avatar
                  key={i}
                  name={u.name}
                  bg={`hsl(${u.hue}, 55%, 48%)`}
                  color="white"
                />
              ))}
            </AvatarGroup>
          )}
        </HStack>
      </Flex>

      {/* Editor stays mounted (hidden) so its instance survives tab switches;
          binary files render their own view on top. */}
      <Box flex={1} minH={0} display={isBinary ? "none" : "block"}>
        <Editor
          theme={colorMode === "dark" ? "cortex-dark" : "cortex-light"}
          beforeMount={defineThemes}
          language={language}
          options={{
            automaticLayout: true,
            fontSize,
            minimap: { enabled: true },
            wordWrap: "on",
            scrollBeyondLastLine: false,
            padding: { top: 12 },
          }}
          onMount={handleMount}
        />
      </Box>
      {isBinary && activeFile && <BinaryView file={activeFile} canManage={canManage} />}

      {/* Status bar (text files only) */}
      {!isBinary && (
        <Flex
          h={7}
          align="center"
          px={2}
          bg="surface.panel"
          borderTop="1px solid"
          borderColor="surface.border"
          fontFamily="mono"
          fontSize="11px"
          color="ink.muted"
          flexShrink={0}
        >
          <HStack spacing={0} divider={<Box w="1px" h="12px" bg="surface.border" mx={2} />}>
            <Text px={1} sx={{ fontVariantNumeric: "tabular-nums" }}>
              Ln {pos.ln}, Col {pos.col}
            </Text>
            <Text px={1} sx={{ fontVariantNumeric: "tabular-nums" }}>
              {counts.rows} {counts.rows === 1 ? "row" : "rows"}
            </Text>
            <Text px={1} sx={{ fontVariantNumeric: "tabular-nums" }}>
              {counts.words} words
            </Text>
            <Text px={1} sx={{ fontVariantNumeric: "tabular-nums" }}>
              {counts.chars} chars
            </Text>
          </HStack>

          <Box flex={1} />

          {/* Font size */}
          <HStack spacing={0} mr={2}>
            <Tooltip label="Smaller (Ctrl -)" openDelay={400}>
              <Button size="xs" variant="ghost" color="ink.muted" minW={6} h={5} onClick={() => setFont(fontSize - 1)}>
                A−
              </Button>
            </Tooltip>
            <Text px={1} minW="34px" textAlign="center" color="ink.base">
              {fontSize}px
            </Text>
            <Tooltip label="Larger (Ctrl +)" openDelay={400}>
              <Button size="xs" variant="ghost" color="ink.muted" minW={6} h={5} onClick={() => setFont(fontSize + 1)}>
                A+
              </Button>
            </Tooltip>
            <Tooltip label="Reset (Ctrl 0)" openDelay={400}>
              <Button size="xs" variant="ghost" color="ink.muted" minW={6} h={5} onClick={() => setFont(13)}>
                ⟲
              </Button>
            </Tooltip>
          </HStack>

          {/* Language override */}
          <Select
            size="xs"
            variant="unstyled"
            value={language}
            onChange={(e) => setLangOverride(e.target.value)}
            w="auto"
            color="ink.base"
            fontFamily="body"
            fontWeight={600}
            cursor="pointer"
            sx={{ "& option": { background: "surface.raised", color: "ink.base" } }}
            title="Set language (overrides the file extension)"
          >
            {(LANGUAGES.includes(language) ? LANGUAGES : [language, ...LANGUAGES]).map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </Select>
        </Flex>
      )}
    </Flex>
  );
}

export default EditorPane;
