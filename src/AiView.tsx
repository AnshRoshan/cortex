import {
  Box,
  Button,
  Center,
  Flex,
  HStack,
  Icon,
  IconButton,
  Menu,
  MenuButton,
  MenuItem,
  MenuList,
  StackDivider,
  Text,
  Textarea,
  Tooltip,
  useToast,
} from "@chakra-ui/react";
import { ChangeEvent, FormEvent, KeyboardEvent, MouseEvent as ReactMouseEvent, useEffect, useRef, useState } from "react";
import { VscCheck, VscChevronDown, VscComment, VscCopy, VscListSelection, VscSparkle, VscSend } from "react-icons/vsc";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import useLocalStorageState from "use-local-storage-state";

import * as api from "./api";
import { AiMessage, AiUsage, FileRow } from "./api";
import { fileIcon } from "./fileIcon";

// Cost comes straight from the provider's usage in the response (many gateways
// return a `usage.cost`). Free models report 0.
function fmtCost(c: number): string {
  if (!c) return "$0.00";
  return c < 0.01 ? `$${c.toFixed(4)}` : `$${c.toFixed(2)}`;
}

const SLASH: { cmd: string; desc: string }[] = [
  { cmd: "/verbose", desc: "Toggle reasoning & activity detail" },
  { cmd: "/clear", desc: "Clear this conversation" },
  { cmd: "/help", desc: "List commands" },
];

// A tiny hover copy button, reused for user + assistant messages.
function CopyButton({ text, label }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <Tooltip label={done ? "Copied" : label || "Copy"} openDelay={300}>
      <IconButton
        aria-label={label || "Copy"}
        icon={<Icon as={done ? VscCheck : VscCopy} />}
        size="xs"
        variant="ghost"
        color="ink.subtle"
        _hover={{ color: "ink.base", bg: "surface.hover" }}
        onClick={() => {
          navigator.clipboard?.writeText(text);
          setDone(true);
          window.setTimeout(() => setDone(false), 1200);
        }}
      />
    </Tooltip>
  );
}

// Same Markdown styling the chat bubbles use, kept local to avoid coupling.
const mdSx = {
  "& > *:first-of-type": { mt: 0 },
  "& > *:last-child": { mb: 0 },
  "& p": { lineHeight: 1.6, my: 2 },
  "& a": { color: "brand.400", textDecoration: "underline" },
  "& code": { fontFamily: "mono", fontSize: "0.85em", bg: "surface.hover", px: 1.5, py: 0.5, borderRadius: "sm" },
  "& pre": { bg: "surface.raised", border: "1px solid", borderColor: "surface.border", p: 3, borderRadius: "md", overflowX: "auto", my: 3 },
  "& pre code": { bg: "transparent", p: 0 },
  "& ul, & ol": { pl: 6, my: 2 },
  "& li": { mb: 1 },
  "& h1, & h2, & h3": { fontWeight: 700, mt: 3, mb: 1.5 },
  "& table": { borderCollapse: "collapse", my: 3, fontSize: "sm", display: "block", overflowX: "auto" },
  "& th, & td": { border: "1px solid", borderColor: "surface.border", px: 2, py: 1 },
};

function AiView({
  workspaceId,
  onFilesChanged,
  files = [],
  initialMessages = [],
  onPersist,
  recent = [],
  onOpenConversation,
}: {
  workspaceId: number | null;
  onFilesChanged?: () => void;
  files?: FileRow[];
  initialMessages?: AiMessage[];
  onPersist?: (messages: AiMessage[]) => void;
  recent?: { id: string; title: string }[];
  onOpenConversation?: (id: string) => void;
}) {
  const toast = useToast();
  const [messages, setMessages] = useState<AiMessage[]>(initialMessages);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [mention, setMention] = useState<{ query: string; start: number; end: number } | null>(null);
  const [menuIndex, setMenuIndex] = useState(0); // highlighted item in the @/slash menu
  const [verbose, setVerbose] = useLocalStorageState<boolean>("cortex-ai-verbose", { defaultValue: true });
  const [profiles, setProfiles] = useState<api.AiProviderView[]>([]);
  const [selectedProfile, setSelectedProfile] = useLocalStorageState<string>("cortex-ai-profile", { defaultValue: "" });
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Load available model profiles for the chooser (falls back to the current one).
  useEffect(() => {
    api
      .getAiSettings()
      .then((s) => {
        setProfiles([...s.profiles, ...(s.org_profiles ?? [])]);
        setSelectedProfile((cur) => cur || s.current || "");
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Conversation totals for the header.
  const totals = messages.reduce(
    (acc, m) => {
      if (m.role === "assistant" && m.usage) {
        acc.input += m.usage.input;
        acc.output += m.usage.output;
        acc.cached += m.usage.cached ?? 0;
        acc.cost += m.usage.cost ?? 0;
      }
      return acc;
    },
    { input: 0, output: 0, cached: 0, cost: 0 },
  );
  const cacheRate = totals.input + totals.cached > 0 ? Math.round((totals.cached / (totals.input + totals.cached)) * 100) : 0;
  const last = [...messages].reverse().find((m) => m.role === "assistant" && m.usage)?.usage;
  const lastContext = last ? last.input + (last.cached ?? 0) : 0;

  const realFiles = files.filter((f) => !f.path.endsWith("/.keep") && f.path !== ".keep");
  const mentionList = mention
    ? realFiles.filter((f) => f.path.toLowerCase().includes(mention.query)).slice(0, 8)
    : [];
  // Slash-command menu shows while the draft is just "/word" (no args yet).
  const slashMatch = /^\/(\w*)$/.exec(draft);
  const slashList = slashMatch ? SLASH.filter((s) => s.cmd.startsWith("/" + slashMatch[1])) : [];

  const pushNote = (content: string) =>
    setMessages((m) => [...m, { role: "assistant", content, note: true }]);

  // Local slash commands — handled in the client, never sent to the model.
  function runSlash(raw: string): boolean {
    if (!raw.startsWith("/")) return false;
    const cmd = raw.split(/\s+/)[0];
    if (cmd === "/verbose") {
      setVerbose((v) => !v);
      pushNote(`Verbose ${verbose ? "off" : "on"} — reasoning & activity ${verbose ? "hidden" : "shown"}.`);
    } else if (cmd === "/clear") {
      setMessages([]);
    } else if (cmd === "/help") {
      pushNote(
        "**Commands**\n\n" +
          SLASH.map((s) => `\`${s.cmd}\` — ${s.desc}`).join("\n") +
          "\n\nType `@` to attach a file's content to your message.",
      );
    } else {
      pushNote(`Unknown command \`${cmd}\`. Try \`/help\`.`);
    }
    return true;
  }

  // Detect an in-progress "@path" before the caret so we can autocomplete files.
  function onDraftChange(e: ChangeEvent<HTMLTextAreaElement>) {
    const v = e.target.value;
    setDraft(v);
    setMenuIndex(0);
    const caret = e.target.selectionStart ?? v.length;
    const m = /(?:^|\s)@([^\s@]*)$/.exec(v.slice(0, caret));
    if (m) setMention({ query: m[1].toLowerCase(), start: caret - m[1].length - 1, end: caret });
    else setMention(null);
  }

  // Accept the highlighted item: insert a file mention, or RUN a slash command.
  function acceptMenu(idx: number) {
    if (mentionList.length) {
      insertMention(mentionList[idx].path);
    } else if (slashList.length) {
      setDraft("");
      setMention(null);
      runSlash(slashList[idx].cmd);
    }
  }

  function insertMention(path: string) {
    if (!mention) return;
    const nextText = draft.slice(0, mention.start) + `@${path} ` + draft.slice(mention.end);
    setDraft(nextText);
    setMention(null);
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, busy]);

  // Persist the conversation whenever it settles (not mid-stream). A ref keeps
  // the callback out of the deps so this only reacts to message changes.
  const persistRef = useRef(onPersist);
  persistRef.current = onPersist;
  useEffect(() => {
    if (!busy) persistRef.current?.(messages);
  }, [busy, messages]);

  async function send() {
    const text = draft.trim();
    if (!text || busy) return;
    setMention(null);
    // Slash commands run locally and never hit the model.
    if (text.startsWith("/")) {
      setDraft("");
      runSlash(text);
      return;
    }
    if (workspaceId == null) return;
    // Files the user @-mentioned (that actually exist) → attach their content.
    const pathSet = new Set(files.map((f) => f.path));
    const attachments = Array.from(
      new Set((text.match(/@([^\s@]+)/g) || []).map((t) => t.slice(1))),
    ).filter((p) => pathSet.has(p));
    // Notes are local-only — exclude them from what the model sees.
    const next = [...messages.filter((m) => !m.note), { role: "user" as const, content: text }];
    // Add an empty assistant bubble to stream the reply into.
    setMessages([...next, { role: "assistant" as const, content: "" }]);
    setDraft("");
    setBusy(true);
    let acc = "";
    let reasoning = "";
    const steps: string[] = [];
    let filesChanged = false;
    const paint = () =>
      setMessages((m) => {
        const copy = m.slice();
        copy[copy.length - 1] = {
          role: "assistant",
          content: acc,
          reasoning: reasoning || undefined,
          steps: steps.length ? [...steps] : undefined,
        };
        return copy;
      });
    try {
      const done = await api.aiChat(
        workspaceId,
        next,
        (e) => {
        if (e.kind === "reasoning") reasoning += e.text;
        else if (e.kind === "text") acc += e.text;
        else if (e.kind === "status") steps.push(e.text);
        else if (e.kind === "tool") {
          steps.push(`🔧 ${e.name}${e.arg ? ` (${e.arg})` : ""}${e.result ? ` — ${e.result}` : ""}`);
          if (e.name === "create_file" || e.name === "edit_file") filesChanged = true;
        }
          paint();
        },
        attachments,
        selectedProfile || undefined,
      );
      setMessages((m) => {
        const copy = m.slice();
        copy[copy.length - 1] = {
          role: "assistant",
          content: acc || "(no response)",
          reasoning: reasoning || undefined,
          steps: steps.length ? [...steps] : undefined,
          usage: done.usage,
          ms: done.ms,
          model: done.model,
        };
        return copy;
      });
      // The assistant created/edited files — refresh the Explorer so they appear.
      if (filesChanged) onFilesChanged?.();
    } catch (e) {
      toast({ title: e instanceof Error ? e.message : "AI request failed", status: "error", duration: 4000 });
      setMessages((m) => m.slice(0, -2)); // roll back the empty reply + the prompt
      setDraft(text);
      if (filesChanged) onFilesChanged?.(); // some files may have been created before the error
    } finally {
      setBusy(false);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    const menuLen = mentionList.length || slashList.length;
    if (menuLen > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setMenuIndex((i) => (i + 1) % menuLen);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setMenuIndex((i) => (i - 1 + menuLen) % menuLen);
        return;
      }
      // Tab or Enter accepts the highlighted item (insert a mention, or run the
      // highlighted slash command).
      if (e.key === "Tab" || e.key === "Enter") {
        e.preventDefault();
        acceptMenu(Math.min(menuIndex, menuLen - 1));
        return;
      }
      if (e.key === "Escape") {
        setMention(null);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  return (
    <Flex flex={1} minW={0} direction="column" bg="surface.bg" overflow="hidden">
      {/* Slim header: model chooser (left) · inline metrics (center) · verbosity (right). */}
      <Flex
        align="center"
        gap={2}
        px={2}
        h="40px"
        borderBottom="1px solid"
        borderColor="surface.border"
        bg="surface.panel"
        flexShrink={0}
      >
        <Menu placement="bottom-start" isLazy>
          <MenuButton
            as={Button}
            variant="ghost"
            size="xs"
            h="28px"
            px={2}
            borderRadius="md"
            fontWeight={600}
            fontSize="13px"
            color="ink.base"
            flexShrink={0}
            leftIcon={<Icon as={VscSparkle} color="brand.400" fontSize="14px" />}
            rightIcon={<Icon as={VscChevronDown} fontSize="11px" color="ink.subtle" />}
            _hover={{ bg: "surface.hover" }}
            _active={{ bg: "surface.hover" }}
          >
            {selectedProfile || "Model"}
          </MenuButton>
          <MenuList bg="surface.raised" borderColor="surface.border" boxShadow="pop" py={1} minW="300px">
            <Text px={3} py={1} fontSize="10px" fontWeight={700} textTransform="uppercase" letterSpacing="0.05em" color="ink.subtle">
              Model
            </Text>
            {profiles.length === 0 ? (
              <MenuItem isDisabled fontSize="sm">
                No models configured — add one in Settings → AI
              </MenuItem>
            ) : (
              profiles.map((p) => (
                <MenuItem
                  key={p.name}
                  bg="transparent"
                  _hover={{ bg: "surface.hover" }}
                  onClick={() => setSelectedProfile(p.name)}
                  icon={<Icon as={VscCheck} boxSize={3.5} opacity={p.name === selectedProfile ? 1 : 0} color="brand.400" />}
                >
                  <Flex justify="space-between" align="center" w="full" gap={4}>
                    <Text fontSize="sm" color="ink.base" fontWeight={500} flexShrink={0}>
                      {p.name}
                    </Text>
                    <Text fontSize="xs" color="ink.subtle" isTruncated>
                      {p.model}
                    </Text>
                  </Flex>
                </MenuItem>
              ))
            )}
          </MenuList>
        </Menu>

        <HStack
          flex={1}
          justify="center"
          spacing={2.5}
          divider={<StackDivider borderColor="surface.border" />}
          fontSize="12px"
          color="ink.muted"
          minW={0}
          overflow="hidden"
          sx={{ fontVariantNumeric: "tabular-nums" }}
        >
          <Tooltip
            label={`Input ${(totals.input + totals.cached).toLocaleString()} = ${totals.cached.toLocaleString()} cached + ${totals.input.toLocaleString()} fresh`}
            openDelay={400}
          >
            <HStack spacing={1} flexShrink={0}>
              <Text color="ink.subtle">In</Text>
              <Text color="ink.base" fontWeight={600}>
                {(totals.input + totals.cached).toLocaleString()}
              </Text>
              {totals.cached > 0 && (
                <Text color="green.400" fontSize="11px">
                  (⚡{totals.cached.toLocaleString()}+{totals.input.toLocaleString()})
                </Text>
              )}
            </HStack>
          </Tooltip>
          <Tooltip label="Output tokens" openDelay={400}>
            <HStack spacing={1} flexShrink={0}>
              <Text color="ink.subtle">Out</Text>
              <Text color="ink.base" fontWeight={600}>
                {totals.output.toLocaleString()}
              </Text>
            </HStack>
          </Tooltip>
          <Tooltip label={`Cost reported by the provider · ${cacheRate}% of input cached`} openDelay={400}>
            <Text color="yellow.400" fontWeight={700} flexShrink={0}>
              {fmtCost(totals.cost)}
            </Text>
          </Tooltip>
          <Tooltip label="Context — last request's total input tokens" openDelay={400}>
            <HStack spacing={1} flexShrink={0}>
              <Text color="ink.subtle">ctx</Text>
              <Text color="ink.base" fontWeight={600}>
                {lastContext.toLocaleString()}
              </Text>
            </HStack>
          </Tooltip>
        </HStack>

        <Tooltip label={verbose ? "Hide reasoning & activity" : "Show reasoning & activity"} openDelay={300}>
          <IconButton
            aria-label="Toggle reasoning & activity"
            icon={<Icon as={VscListSelection} />}
            size="xs"
            variant="ghost"
            color={verbose ? "brand.400" : "ink.subtle"}
            _hover={{ bg: "surface.hover" }}
            flexShrink={0}
            onClick={() => setVerbose((v) => !v)}
          />
        </Tooltip>
      </Flex>

      <Box
        flex={1}
        minH={0}
        overflowY="auto"
        px={{ base: 4, md: 8 }}
        py={6}
        sx={{
          // Slim, rounded scrollbar (ChatGPT-style), only visible on hover-ish.
          "&::-webkit-scrollbar": { width: "10px" },
          "&::-webkit-scrollbar-thumb": {
            background: "var(--chakra-colors-surface-border)",
            borderRadius: "8px",
            border: "3px solid transparent",
            backgroundClip: "content-box",
          },
          "&::-webkit-scrollbar-thumb:hover": { background: "var(--chakra-colors-surface-borderStrong)", backgroundClip: "content-box" },
          scrollbarWidth: "thin",
        }}
      >
        {messages.length === 0 ? (
          <Flex direction="column" align="center" gap={5} py={12} maxW="520px" mx="auto">
            <Center flexDirection="column" gap={2} textAlign="center">
              <Center boxSize="48px" borderRadius="2xl" bg="accent.tint" color="brand.400">
                <Icon as={VscSparkle} fontSize="24px" />
              </Center>
              <Text fontSize="md" fontWeight={600} color="ink.base">
                Ask about this workspace
              </Text>
              <Text fontSize="sm" color="ink.muted">
                Summaries, where something's defined, how files relate — or ask it to create and edit files.
              </Text>
            </Center>

            {recent.length > 0 && (
              <Box w="full">
                <Text fontSize="11px" fontWeight={700} textTransform="uppercase" letterSpacing="0.05em" color="ink.subtle" mb={2} px={1}>
                  Recent
                </Text>
                <Flex direction="column" gap={1}>
                  {recent.slice(0, 6).map((c) => (
                    <HStack
                      key={c.id}
                      px={3}
                      py={2.5}
                      spacing={3}
                      borderRadius="lg"
                      border="1px solid"
                      borderColor="surface.border"
                      bg="surface.raised"
                      cursor="pointer"
                      _hover={{ bg: "surface.hover", borderColor: "surface.borderStrong" }}
                      onClick={() => onOpenConversation?.(c.id)}
                    >
                      <Icon as={VscComment} color="ink.subtle" fontSize="sm" flexShrink={0} />
                      <Text fontSize="sm" color="ink.base" isTruncated>
                        {c.title}
                      </Text>
                    </HStack>
                  ))}
                </Flex>
              </Box>
            )}
          </Flex>
        ) : (
          <Flex direction="column" gap={5} maxW="820px" mx="auto">
            {messages.map((m, i) =>
              m.note ? (
                <Box
                  key={i}
                  alignSelf="center"
                  maxW="90%"
                  fontSize="xs"
                  color="ink.subtle"
                  bg="surface.raised"
                  border="1px solid"
                  borderColor="surface.border"
                  borderRadius="10px"
                  px={3}
                  py={2}
                  sx={mdSx}
                >
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown>
                </Box>
              ) : m.role === "user" ? (
                <Flex key={i} role="group" justify="flex-end" align="center" gap={1}>
                  <Box opacity={0} _groupHover={{ opacity: 1 }} transition="opacity 0.12s">
                    <CopyButton text={m.content} label="Copy message" />
                  </Box>
                  <Box maxW="85%" bg="brand.500" color="white" px={4} py={2.5} borderRadius="14px" borderBottomRightRadius="4px" fontSize="sm" whiteSpace="pre-wrap">
                    {m.content}
                  </Box>
                </Flex>
              ) : (
                <Flex key={i} role="group" gap={3} align="flex-start">
                  <Center boxSize="28px" borderRadius="full" bg="accent.tint" color="brand.400" flexShrink={0} mt={0.5}>
                    <Icon as={VscSparkle} fontSize="15px" />
                  </Center>
                  <Box flex={1} minW={0} fontSize="sm" color="ink.base">
                    {verbose && m.steps && m.steps.length > 0 && (
                      <Box
                        mb={m.content || m.reasoning ? 3 : 1}
                        borderLeft="2px solid"
                        borderColor="surface.border"
                        pl={3}
                      >
                        <Text fontSize="xs" fontWeight={600} color="ink.subtle" mb={1}>
                          ⚙️ Activity
                        </Text>
                        {m.steps.map((s, si) => (
                          <Text key={si} fontSize="xs" color="ink.subtle" fontFamily="mono" whiteSpace="pre-wrap">
                            {s}
                          </Text>
                        ))}
                      </Box>
                    )}
                    {verbose && m.reasoning && (
                      <Box
                        mb={m.content ? 3 : 1}
                        borderLeft="2px solid"
                        borderColor="surface.border"
                        pl={3}
                      >
                        <Text fontSize="xs" fontWeight={600} color="ink.subtle" mb={1}>
                          💭 Reasoning
                        </Text>
                        <Text
                          fontSize="xs"
                          color="ink.subtle"
                          whiteSpace="pre-wrap"
                          maxH="220px"
                          overflowY="auto"
                        >
                          {m.reasoning}
                        </Text>
                      </Box>
                    )}
                    {m.content ? (
                      <Box sx={mdSx}>
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown>
                      </Box>
                    ) : (
                      !(verbose && m.reasoning) &&
                      !(verbose && m.steps && m.steps.length) && (
                        <Text color="ink.subtle" fontStyle="italic">
                          Thinking…
                        </Text>
                      )
                    )}
                    {m.content && (
                      <HStack mt={2} spacing={2} align="center">
                        {m.usage && (
                          <Text fontSize="xs" color="ink.subtle" sx={{ fontVariantNumeric: "tabular-nums" }}>
                            ↑ {m.usage.input.toLocaleString()} in
                            {m.usage.cached ? ` (+⚡${m.usage.cached.toLocaleString()})` : ""} · ↓{" "}
                            {m.usage.output.toLocaleString()} out · {fmtCost(m.usage.cost ?? 0)}
                            {m.ms != null && ` · ${(m.ms / 1000).toFixed(1)}s`}
                            {m.model && ` · ${m.model}`}
                          </Text>
                        )}
                        <Box opacity={0} _groupHover={{ opacity: 1 }} transition="opacity 0.12s">
                          <CopyButton text={m.content} label="Copy response" />
                        </Box>
                      </HStack>
                    )}
                  </Box>
                </Flex>
              ),
            )}
            <div ref={bottomRef} />
          </Flex>
        )}
      </Box>

      <Box as="form" position="relative" px={4} py={3} flexShrink={0} onSubmit={(e: FormEvent) => { e.preventDefault(); send(); }}>
        {(mentionList.length > 0 || slashList.length > 0) && (
          <Box
            position="absolute"
            bottom="calc(100% - 6px)"
            left="50%"
            transform="translateX(-50%)"
            w="min(820px, calc(100% - 32px))"
            maxH="240px"
            overflowY="auto"
            bg="surface.panel"
            border="1px solid"
            borderColor="surface.borderStrong"
            borderRadius="md"
            boxShadow="lg"
            zIndex={10}
          >
            {mentionList.length > 0
              ? mentionList.map((f, idx) => {
                  const spec = fileIcon(f.path);
                  const active = idx === Math.min(menuIndex, mentionList.length - 1);
                  return (
                    <Flex
                      key={f.id}
                      align="center"
                      gap={2}
                      px={3}
                      py={1.5}
                      cursor="pointer"
                      borderLeft="2px solid"
                      borderColor={active ? "brand.400" : "transparent"}
                      bg={active ? "accent.tint" : "transparent"}
                      _hover={{ bg: "accent.tint" }}
                      onMouseEnter={() => setMenuIndex(idx)}
                      onMouseDown={(e: ReactMouseEvent) => {
                        e.preventDefault();
                        insertMention(f.path);
                      }}
                    >
                      <Icon as={spec.icon} color={spec.color} fontSize="sm" flexShrink={0} />
                      <Text fontSize="sm" color={active ? "brand.300" : "ink.base"} isTruncated>
                        {f.path}
                      </Text>
                    </Flex>
                  );
                })
              : slashList.map((s, idx) => {
                  const active = idx === Math.min(menuIndex, slashList.length - 1);
                  return (
                    <Flex
                      key={s.cmd}
                      align="center"
                      gap={2}
                      px={3}
                      py={1.5}
                      cursor="pointer"
                      borderLeft="2px solid"
                      borderColor={active ? "brand.400" : "transparent"}
                      bg={active ? "accent.tint" : "transparent"}
                      _hover={{ bg: "accent.tint" }}
                      onMouseEnter={() => setMenuIndex(idx)}
                      onMouseDown={(e: ReactMouseEvent) => {
                        e.preventDefault();
                        setDraft("");
                        setMention(null);
                        runSlash(s.cmd);
                      }}
                    >
                      <Text fontSize="sm" color={active ? "brand.300" : "ink.base"} fontFamily="mono" fontWeight={600}>
                        {s.cmd}
                      </Text>
                      <Text fontSize="xs" color="ink.subtle" isTruncated>
                        {s.desc}
                      </Text>
                    </Flex>
                  );
                })}
          </Box>
        )}
        <Flex
          align="flex-end"
          maxW="820px"
          mx="auto"
          bg="surface.raised"
          border="1px solid"
          borderColor="surface.border"
          _focusWithin={{ borderColor: "brand.500" }}
          borderRadius="20px"
          pl={4}
          pr="6px"
          py="4px"
          transition="border-color 0.15s"
          opacity={workspaceId == null ? 0.6 : 1}
        >
          <Textarea
            ref={inputRef}
            value={draft}
            onChange={onDraftChange}
            onKeyDown={onKeyDown}
            isDisabled={workspaceId == null || busy}
            variant="unstyled"
            placeholder={
              workspaceId == null
                ? "Open a workspace to use the assistant…"
                : "Ask about this workspace…  (@ to attach a file, / for commands)"
            }
            resize="none"
            rows={1}
            minH="26px"
            maxH="160px"
            py={2}
            flex={1}
            fontSize="sm"
            sx={{ fieldSizing: "content" }}
          />
          <IconButton
            aria-label="Ask"
            icon={<Icon as={VscSend} />}
            type="submit"
            size="sm"
            borderRadius="full"
            colorScheme="brand"
            alignSelf="flex-end"
            mb="3px"
            isLoading={busy}
            isDisabled={!draft.trim() || workspaceId == null}
          />
        </Flex>
      </Box>
    </Flex>
  );
}

export default AiView;
