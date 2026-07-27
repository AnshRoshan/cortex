import {
  Avatar,
  Box,
  Button,
  Center,
  Flex,
  HStack,
  Icon,
  IconButton,
  Menu,
  MenuButton,
  MenuList,
  Text,
  Textarea,
  Tooltip,
  useToast,
} from "@chakra-ui/react";
import { ChangeEvent, ClipboardEvent, FormEvent, KeyboardEvent, MouseEvent as ReactMouseEvent, useCallback, useEffect, useRef, useState } from "react";
import { FiSmile } from "react-icons/fi";
import { VscCheck, VscClearAll, VscClose, VscComment, VscCopy, VscEdit, VscSend, VscTrash } from "react-icons/vsc";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import * as api from "./api";
import { ChatMessage, Me, Member, Presence } from "./api";

// Quick-reaction palette shown in the "add reaction" menu.
const PRESET_EMOJI = ["👍", "❤️", "😄", "🎉", "🙏", "👀"];

function relTime(unix: number) {
  if (!unix) return "a while ago";
  const s = Math.max(0, Math.floor(Date.now() / 1000) - unix);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

// Stable colour per author for their avatar.
function hueOf(s: string) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return h;
}

// Hover emoji picker. Box buttons (not MenuItem) render the emoji row reliably.
function ReactionPicker({ onPick }: { onPick: (emoji: string) => void }) {
  return (
    <Menu isLazy placement="top">
      <MenuButton
        as={IconButton}
        aria-label="Add reaction"
        icon={<Icon as={FiSmile} />}
        size="xs"
        variant="ghost"
        color="ink.subtle"
        _hover={{ color: "ink.base", bg: "surface.hover" }}
      />
      <MenuList minW="auto" p={1}>
        <HStack spacing={0}>
          {PRESET_EMOJI.map((e) => (
            <Box
              as="button"
              type="button"
              key={e}
              px={2}
              py={1}
              fontSize="lg"
              lineHeight={1}
              borderRadius="md"
              _hover={{ bg: "surface.hover" }}
              onClick={() => onPick(e)}
            >
              {e}
            </Box>
          ))}
        </HStack>
      </MenuList>
    </Menu>
  );
}
import { ChatTarget } from "./ChatChannels";
import { ConfirmModal } from "./Dialogs";

function timeOf(unix: number) {
  return new Date(unix * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

// Only replace state when the thread actually changed — avoids the 2.5s poll
// re-rendering (and flickering) an unchanged list. Also compares edited_at so
// an in-place edit from someone else shows up.
function sameThread(a: ChatMessage[], b: ChatMessage[]) {
  if (a.length !== b.length) return false;
  if (a.length === 0) return true;
  const la = a[a.length - 1];
  const lb = b[b.length - 1];
  return (
    a[0].id === b[0].id &&
    la.id === lb.id &&
    la.body === lb.body &&
    la.edited_at === lb.edited_at
  );
}

const mdSx = {
  "& > *:first-of-type": { mt: 0 },
  "& > *:last-child": { mb: 0 },
  "& p": { lineHeight: 1.5, mb: 1.5 },
  "& a": { textDecoration: "underline" },
  "& code": { fontFamily: "mono", fontSize: "0.85em", bg: "blackAlpha.200", px: 1, py: 0.5, borderRadius: "sm" },
  "& pre": { bg: "blackAlpha.300", p: 2.5, borderRadius: "md", overflowX: "auto", my: 1.5 },
  "& pre code": { bg: "transparent", p: 0 },
  "& ul, & ol": { pl: 5, mb: 1.5 },
  "& li": { mb: 0.5 },
  "& blockquote": { bg: "blackAlpha.200", borderRadius: "sm", px: 2, py: 1, my: 1.5, opacity: 0.9 },
  "& h1, & h2, & h3": { fontWeight: 700, mt: 2, mb: 1, lineHeight: 1.3 },
  "& table": { borderCollapse: "collapse", my: 1.5, fontSize: "sm" },
  "& th, & td": { border: "1px solid", borderColor: "whiteAlpha.300", px: 2, py: 1 },
  "& img": { maxW: "260px", maxH: "260px", borderRadius: "md", mt: 1 },
};

type Props = {
  me: Me;
  orgId?: number;
  workspaceId: number | null;
  members: Member[];
  isAdmin: boolean;
  target: ChatTarget;
};

function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <Tooltip label={done ? "Copied" : "Copy"} openDelay={300}>
      <IconButton
        aria-label="Copy message"
        icon={<Icon as={done ? VscCheck : VscCopy} />}
        size="xs"
        variant="ghost"
        color="ink.subtle"
        opacity={0}
        _groupHover={{ opacity: 1 }}
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

function ChatView({ me, orgId, workspaceId, members, isAdmin, target }: Props) {
  const toast = useToast();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [confirmDel, setConfirmDel] = useState<number | null>(null);
  const [editing, setEditing] = useState<number | null>(null);
  const [mention, setMention] = useState<{ query: string; start: number; end: number } | null>(null);
  const [typing, setTyping] = useState<number[]>([]);
  const [presence, setPresence] = useState<Record<number, Presence>>({});
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const prevCount = useRef(0);
  const lastTypingPing = useRef(0);

  const peer = target.kind === "dm" ? members.find((m) => m.id === target.userId) : undefined;
  const canSend = target.kind === "ws" ? workspaceId != null : !!peer;

  const load = useCallback(async () => {
    try {
      const r =
        target.kind === "ws"
          ? workspaceId == null
            ? null
            : await api.getWorkspaceChat(workspaceId)
          : await api.getDm(target.userId, orgId);
      if (r) {
        setMessages((prev) => (sameThread(prev, r.messages) ? prev : r.messages));
        setTyping(r.typing ?? []);
      }
    } catch {
      /* keep last messages on a transient error */
    }
  }, [target, workspaceId, orgId]);

  // Poll org presence (who's online / last seen) independently of the thread.
  useEffect(() => {
    let stop = false;
    const poll = async () => {
      try {
        const r = await api.getPresence(orgId);
        if (!stop) setPresence(Object.fromEntries(r.presence.map((p) => [p.id, p])));
      } catch {
        /* ignore */
      }
    };
    poll();
    const id = window.setInterval(poll, 15000);
    return () => {
      stop = true;
      window.clearInterval(id);
    };
  }, [orgId]);

  useEffect(() => {
    setMessages([]);
    prevCount.current = 0;
    setEditing(null);
    setDraft("");
    load();
    const id = window.setInterval(load, 2500);
    return () => window.clearInterval(id);
  }, [load]);

  // Only scroll when a new message actually arrives (not on every poll).
  useEffect(() => {
    if (messages.length > prevCount.current) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }
    prevCount.current = messages.length;
  }, [messages]);

  async function send() {
    const text = draft.trim();
    if (!text || sending || !canSend) return;
    setSending(true);
    try {
      if (editing != null) {
        if (target.kind === "ws") await api.editWorkspaceChat(editing, text);
        else await api.editDm(editing, text);
        setEditing(null);
      } else if (target.kind === "ws" && workspaceId != null) {
        await api.postWorkspaceChat(workspaceId, text);
      } else if (target.kind === "dm") {
        await api.postDm(target.userId, text, orgId);
      }
      setDraft("");
      setMention(null);
      await load();
    } catch (e) {
      toast({ title: e instanceof Error ? e.message : "Couldn't send", status: "error", duration: 3000 });
    } finally {
      setSending(false);
    }
  }

  function startEdit(m: ChatMessage) {
    setEditing(m.id);
    setDraft(m.body);
    setMention(null);
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  function cancelEdit() {
    setEditing(null);
    setDraft("");
  }

  async function doDelete(id: number) {
    try {
      if (target.kind === "ws") await api.deleteWorkspaceChatMsg(id);
      else await api.deleteDmMsg(id);
      setMessages((prev) => prev.filter((m) => m.id !== id));
      if (editing === id) cancelEdit();
    } catch (e) {
      toast({ title: e instanceof Error ? e.message : "Couldn't delete", status: "error", duration: 3000 });
    }
  }

  async function react(msgId: number, emoji: string) {
    try {
      await api.toggleReaction(target.kind, msgId, emoji);
      await load();
    } catch (e) {
      toast({ title: e instanceof Error ? e.message : "Couldn't react", status: "error", duration: 2500 });
    }
  }

  async function clearThread() {
    try {
      if (target.kind === "ws" && workspaceId != null) await api.clearWorkspaceChat(workspaceId);
      else if (target.kind === "dm") await api.clearDm(target.userId, orgId);
      setMessages([]);
      prevCount.current = 0;
      toast({ title: "Conversation cleared", status: "success", duration: 1800 });
    } catch (e) {
      toast({ title: e instanceof Error ? e.message : "Couldn't clear", status: "error", duration: 3000 });
    }
  }

  // Paste an image → upload to the current workspace and insert a markdown image.
  async function onPaste(e: ClipboardEvent<HTMLTextAreaElement>) {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const it of Array.from(items)) {
      if (it.type.startsWith("image/")) {
        const file = it.getAsFile();
        if (!file) continue;
        e.preventDefault();
        try {
          const ext = it.type.split("/")[1] || "png";
          const named = new File([file], `pasted-${Date.now()}.${ext}`, { type: it.type });
          const { url } = await api.uploadChatImage(named, orgId);
          setDraft((d) => (d ? `${d}\n` : "") + `![image](${url})`);
        } catch (err) {
          toast({ title: err instanceof Error ? err.message : "Upload failed", status: "error", duration: 3000 });
        }
        return;
      }
    }
  }

  // Detect an in-progress "@mention" ending at the caret so we can autocomplete.
  function onDraftChange(e: ChangeEvent<HTMLTextAreaElement>) {
    const v = e.target.value;
    setDraft(v);
    const caret = e.target.selectionStart ?? v.length;
    const m = /(?:^|\s)@([\w.\-]*)$/.exec(v.slice(0, caret));
    if (m) setMention({ query: m[1].toLowerCase(), start: caret - m[1].length - 1, end: caret });
    else setMention(null);
    // Throttled "typing" ping (skip while editing an existing message).
    if (editing == null && canSend) {
      const now = Date.now();
      if (now - lastTypingPing.current > 2000) {
        lastTypingPing.current = now;
        if (target.kind === "ws" && workspaceId != null) api.pingTypingWs(workspaceId);
        else if (target.kind === "dm") api.pingTypingDm(target.userId, orgId);
      }
    }
  }

  const mentionList =
    mention
      ? members
          .filter((m) => m.email !== me.email)
          .filter((m) => (m.name + " " + m.email).toLowerCase().includes(mention.query))
          .slice(0, 6)
      : [];

  function insertMention(name: string) {
    if (!mention) return;
    const next = draft.slice(0, mention.start) + `@${name} ` + draft.slice(mention.end);
    setDraft(next);
    setMention(null);
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Escape") {
      if (mention) setMention(null);
      else if (editing != null) cancelEdit();
      return;
    }
    if (mention && mentionList.length > 0 && (e.key === "Enter" || e.key === "Tab")) {
      e.preventDefault();
      insertMention(mentionList[0].name || mentionList[0].email);
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  // Does this message @-mention me? Highlights incoming messages that call me out.
  const emailLocal = me.email.split("@")[0];
  const mentionsMe = (body: string) =>
    (!!me.name && body.includes(`@${me.name}`)) || body.includes(`@${emailLocal}`);

  const title = target.kind === "ws" ? "Workspace" : peer ? peer.name || peer.email : "Direct message";
  const peerPresence = peer ? presence[peer.id] : undefined;
  const subtitle =
    target.kind === "ws"
      ? "Everyone in the workspace · Markdown supported"
      : peerPresence
        ? peerPresence.online
          ? "Active now"
          : `Last seen ${relTime(peerPresence.last_seen)}`
        : peer?.email ?? "";
  const canClear = target.kind === "ws" ? isAdmin : true;

  // Members currently typing (server already excludes me), for the footer line.
  const typingNames = typing
    .map((id) => members.find((m) => m.id === id))
    .filter((m): m is Member => !!m && m.email !== me.email)
    .map((m) => m.name || m.email);

  return (
    <Flex flex={1} minW={0} direction="column" bg="surface.bg" overflow="hidden">
      <Flex align="center" justify="space-between" px={5} h={14} borderBottom="1px solid" borderColor="surface.border" flexShrink={0}>
        <Box minW={0}>
          <Text fontSize="md" fontWeight="semibold" color="ink.base" isTruncated>
            {title}
          </Text>
          <Text fontSize="xs" color="ink.subtle" isTruncated>
            {subtitle}
          </Text>
        </Box>
        {/* Always reserve the slot so showing/hiding it never reflows the header. */}
        <Tooltip label={target.kind === "ws" ? "Clear workspace chat (admin)" : "Clear conversation for both"}>
          <IconButton
            aria-label="Clear conversation"
            icon={<VscClearAll />}
            size="sm"
            variant="ghost"
            color="ink.muted"
            flexShrink={0}
            _hover={{ bg: "surface.hover", color: "red.400" }}
            visibility={canClear && messages.length > 0 ? "visible" : "hidden"}
            isDisabled={!canClear || messages.length === 0}
            onClick={() => setConfirmClear(true)}
          />
        </Tooltip>
      </Flex>

      <Box flex={1} minH={0} overflowY="auto" px={4} py={4}>
        {messages.length === 0 ? (
          <Center flexDirection="column" gap={3} py={20} color="ink.muted">
            <Icon as={VscComment} fontSize="3xl" color="ink.subtle" />
            <Text fontSize="sm">{canSend ? "No messages yet. Say hello 👋" : "Pick a conversation to start."}</Text>
          </Center>
        ) : (
          <Flex direction="column" gap={3}>
            {messages.map((m) => {
              const mine = m.email === me.email;
              const label = m.author || m.email;
              const callsMe = !mine && mentionsMe(m.body);

              const actions = (
                <HStack
                  spacing={0.5}
                  opacity={0}
                  _groupHover={{ opacity: 1 }}
                  transition="opacity 0.12s"
                  flexShrink={0}
                  alignSelf="center"
                >
                  <ReactionPicker onPick={(e) => react(m.id, e)} />
                  <CopyButton text={m.body} />
                  {mine && (
                    <>
                      <IconButton
                        aria-label="Edit message"
                        icon={<Icon as={VscEdit} />}
                        size="xs"
                        variant="ghost"
                        color="ink.subtle"
                        _hover={{ color: "ink.base", bg: "surface.hover" }}
                        onClick={() => startEdit(m)}
                      />
                      <IconButton
                        aria-label="Delete message"
                        icon={<Icon as={VscTrash} />}
                        size="xs"
                        variant="ghost"
                        color="ink.subtle"
                        _hover={{ color: "red.400", bg: "surface.hover" }}
                        onClick={() => setConfirmDel(m.id)}
                      />
                    </>
                  )}
                </HStack>
              );

              const bubble = (
                <Box maxW={{ base: "78%", md: "64%" }} minW={0}>
                  {!mine && (
                    <Text fontSize="xs" fontWeight={600} color="ink.muted" mb={1} ml={1}>
                      {label}
                    </Text>
                  )}
                  <Box
                    bg={mine ? "brand.500" : "surface.raised"}
                    color={mine ? "white" : "ink.base"}
                    border={mine ? undefined : "1px solid"}
                    borderColor={callsMe ? "brand.400" : "surface.border"}
                    boxShadow={callsMe ? "0 0 0 1px var(--chakra-colors-brand-400)" : undefined}
                    borderRadius="16px"
                    borderBottomRightRadius={mine ? "5px" : "16px"}
                    borderBottomLeftRadius={mine ? "16px" : "5px"}
                    px={3.5}
                    py={2}
                    fontSize="sm"
                    sx={mdSx}
                  >
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.body}</ReactMarkdown>
                  </Box>
                  {m.reactions && m.reactions.length > 0 && (
                    <HStack spacing={1} mt={1.5} flexWrap="wrap" justify={mine ? "flex-end" : "flex-start"}>
                      {m.reactions.map((r) => (
                        <Button
                          key={r.emoji}
                          size="xs"
                          h="22px"
                          minW="auto"
                          px={2}
                          borderRadius="full"
                          variant="outline"
                          borderColor={r.mine ? "brand.400" : "surface.border"}
                          bg={r.mine ? "surface.hover" : "surface.panel"}
                          color="ink.base"
                          fontWeight={500}
                          onClick={() => react(m.id, r.emoji)}
                        >
                          {r.emoji} {r.count}
                        </Button>
                      ))}
                    </HStack>
                  )}
                  <Text fontSize="10px" color="ink.subtle" mt={1} textAlign={mine ? "right" : "left"} px={1}>
                    {timeOf(m.created_at)}
                    {m.edited_at ? " · edited" : ""}
                  </Text>
                </Box>
              );

              return (
                <Flex key={m.id} role="group" gap={2} align="flex-end" justify={mine ? "flex-end" : "flex-start"}>
                  {mine ? (
                    <>
                      {actions}
                      {bubble}
                    </>
                  ) : (
                    <>
                      <Avatar
                        size="xs"
                        name={label}
                        bg={`hsl(${hueOf(m.email)}, 45%, 45%)`}
                        color="white"
                        flexShrink={0}
                      />
                      {bubble}
                      {actions}
                    </>
                  )}
                </Flex>
              );
            })}
            {typingNames.length > 0 && (
              <Text fontSize="xs" color="ink.subtle" fontStyle="italic" ml={1}>
                {typingNames.join(", ")} {typingNames.length === 1 ? "is" : "are"} typing…
              </Text>
            )}
            <div ref={bottomRef} />
          </Flex>
        )}
      </Box>

      {editing != null && (
        <Flex align="center" gap={2} px={4} py={1.5} bg="surface.raised" borderTop="1px solid" borderColor="surface.border" flexShrink={0}>
          <Icon as={VscEdit} color="ink.muted" fontSize="xs" />
          <Text fontSize="xs" color="ink.muted" flex={1}>
            Editing message · press Esc to cancel
          </Text>
          <IconButton aria-label="Cancel edit" icon={<VscClose />} size="xs" variant="ghost" color="ink.muted" onClick={cancelEdit} />
        </Flex>
      )}

      <Box
        as="form"
        position="relative"
        px={4}
        py={3}
        flexShrink={0}
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          send();
        }}
      >
        {mention && mentionList.length > 0 && (
          <Box
            position="absolute"
            bottom="calc(100% - 4px)"
            left={4}
            maxW="320px"
            bg="surface.panel"
            border="1px solid"
            borderColor="surface.borderStrong"
            borderRadius="md"
            boxShadow="lg"
            overflow="hidden"
            zIndex={10}
          >
            {mentionList.map((mm, i) => (
              <Flex
                key={mm.id}
                align="center"
                gap={2}
                px={3}
                py={1.5}
                cursor="pointer"
                bg={i === 0 ? "surface.hover" : "transparent"}
                _hover={{ bg: "surface.hover" }}
                onMouseDown={(e: ReactMouseEvent) => {
                  e.preventDefault();
                  insertMention(mm.name || mm.email);
                }}
              >
                <Text fontSize="sm" color="ink.base">
                  {mm.name || mm.email}
                </Text>
                {mm.name && (
                  <Text fontSize="xs" color="ink.subtle" isTruncated>
                    {mm.email}
                  </Text>
                )}
              </Flex>
            ))}
          </Box>
        )}
        <Flex
          align="flex-end"
          bg="surface.raised"
          border="1px solid"
          borderColor="surface.border"
          _focusWithin={{ borderColor: "brand.500" }}
          borderRadius="20px"
          pl={4}
          pr="6px"
          py="4px"
          transition="border-color 0.15s"
          opacity={canSend ? 1 : 0.6}
        >
          <Textarea
            ref={inputRef}
            value={draft}
            onChange={onDraftChange}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            isDisabled={!canSend}
            variant="unstyled"
            placeholder={
              editing != null
                ? "Edit your message…"
                : target.kind === "ws"
                  ? "Message the workspace…  (@ to mention, Markdown ok)"
                  : `Message ${title}…`
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
            aria-label={editing != null ? "Save edit" : "Send message"}
            icon={<Icon as={editing != null ? VscCheck : VscSend} />}
            type="submit"
            size="sm"
            borderRadius="full"
            colorScheme="brand"
            alignSelf="flex-end"
            mb="3px"
            isLoading={sending}
            isDisabled={!draft.trim() || !canSend}
          />
        </Flex>
      </Box>

      <ConfirmModal
        isOpen={confirmClear}
        title={target.kind === "ws" ? "Clear workspace chat" : "Clear conversation"}
        body={
          target.kind === "ws"
            ? "Delete every message in this workspace's chat? This can't be undone."
            : "Delete this whole conversation? It clears for both of you and can't be undone."
        }
        cta="Clear"
        onConfirm={clearThread}
        onClose={() => setConfirmClear(false)}
      />
      <ConfirmModal
        isOpen={confirmDel != null}
        title="Delete message"
        body="Delete this message? This can't be undone."
        cta="Delete"
        onConfirm={() => confirmDel != null && doDelete(confirmDel)}
        onClose={() => setConfirmDel(null)}
      />
    </Flex>
  );
}

export default ChatView;
