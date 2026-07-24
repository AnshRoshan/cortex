import {
  Avatar,
  Box,
  Center,
  Flex,
  HStack,
  Icon,
  IconButton,
  Text,
  Textarea,
  useToast,
} from "@chakra-ui/react";
import { KeyboardEvent, useEffect, useRef, useState } from "react";
import { VscComment, VscSend } from "react-icons/vsc";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import * as api from "./api";
import { ChatMessage, Me } from "./api";

function timeOf(unix: number) {
  const d = new Date(unix * 1000);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

// Shared markdown styling for message bodies (no raw HTML — react-markdown is
// safe by default; remark-gfm adds tables, task lists, strikethrough).
const mdSx = {
  "& > *:first-of-type": { mt: 0 },
  "& > *:last-child": { mb: 0 },
  "& p": { lineHeight: 1.55, mb: 2 },
  "& a": { color: "brand.400", textDecoration: "underline" },
  "& code": {
    fontFamily: "mono",
    fontSize: "0.85em",
    bg: "surface.hover",
    px: 1.5,
    py: 0.5,
    borderRadius: "sm",
  },
  "& pre": {
    bg: "surface.raised",
    border: "1px solid",
    borderColor: "surface.border",
    p: 3,
    borderRadius: "md",
    overflowX: "auto",
    my: 2,
  },
  "& pre code": { bg: "transparent", p: 0 },
  "& ul, & ol": { pl: 5, mb: 2 },
  "& li": { mb: 1 },
  "& blockquote": {
    bg: "surface.hover",
    borderRadius: "md",
    px: 3,
    py: 2,
    color: "ink.muted",
    my: 2,
  },
  "& h1, & h2, & h3": { fontWeight: 700, mt: 3, mb: 1, lineHeight: 1.3 },
  "& table": { borderCollapse: "collapse", my: 2, fontSize: "sm" },
  "& th, & td": { border: "1px solid", borderColor: "surface.border", px: 2, py: 1 },
  "& img": { maxW: "100%", borderRadius: "md" },
  "& hr": { borderColor: "surface.border", my: 3 },
};

function ChatView({ me, orgId }: { me: Me | null; orgId?: number }) {
  const toast = useToast();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Poll for new messages (simple + reliable; a small team doesn't need a WS).
  // ponytail: 2.5s poll; swap for a WebSocket if message volume grows.
  useEffect(() => {
    let alive = true;
    const load = () =>
      api
        .getChat(orgId)
        .then((r) => alive && setMessages(r.messages))
        .catch(() => {});
    load();
    const id = window.setInterval(load, 2500);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [orgId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function send() {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    try {
      await api.postChat(text, orgId);
      setDraft("");
      const r = await api.getChat(orgId);
      setMessages(r.messages);
    } catch (e) {
      toast({
        title: e instanceof Error ? e.message : "Couldn't send",
        status: "error",
        duration: 3000,
      });
    } finally {
      setSending(false);
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  return (
    <Flex flex={1} minW={0} direction="column" bg="surface.bg" overflow="hidden">
      <Flex
        align="center"
        px={6}
        h={14}
        borderBottom="1px solid"
        borderColor="surface.border"
        flexShrink={0}
      >
        <Box>
          <Text fontSize="md" fontWeight="semibold" color="ink.base">
            Chat
          </Text>
          <Text fontSize="xs" color="ink.subtle">
            Everyone in the workspace · Markdown supported
          </Text>
        </Box>
      </Flex>

      <Box flex={1} minH={0} overflowY="auto" px={6} py={5}>
        {messages.length === 0 ? (
          <Center flexDirection="column" gap={3} py={20} color="ink.muted">
            <Icon as={VscComment} fontSize="3xl" color="ink.subtle" />
            <Text fontSize="sm">No messages yet. Say hello 👋</Text>
          </Center>
        ) : (
          <Flex direction="column" gap={5} maxW="768px">
            {messages.map((m) => {
              const mine = m.email === me?.email;
              const label = m.author || m.email;
              return (
                <HStack key={m.id} align="flex-start" spacing={3}>
                  <Avatar
                    size="sm"
                    name={label}
                    bg={mine ? "brand.600" : "surface.hover"}
                    color={mine ? "white" : "ink.base"}
                    mt={0.5}
                  />
                  <Box minW={0} flex={1}>
                    <HStack spacing={2} mb={0.5}>
                      <Text fontSize="sm" fontWeight="semibold" color="ink.base">
                        {mine ? "You" : label}
                      </Text>
                      <Text fontSize="xs" color="ink.subtle">
                        {timeOf(m.created_at)}
                      </Text>
                    </HStack>
                    <Box fontSize="sm" color="ink.base" sx={mdSx}>
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.body}</ReactMarkdown>
                    </Box>
                  </Box>
                </HStack>
              );
            })}
            <div ref={bottomRef} />
          </Flex>
        )}
      </Box>

      <Flex
        as="form"
        p={4}
        gap={3}
        align="flex-end"
        borderTop="1px solid"
        borderColor="surface.border"
        bg="surface.panel"
        flexShrink={0}
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <Textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Message the workspace…  (Markdown ok · Enter to send, Shift+Enter for a new line)"
          resize="none"
          rows={1}
          maxH="160px"
          bg="surface.raised"
          borderColor="surface.border"
          _hover={{ borderColor: "surface.borderStrong" }}
          focusBorderColor="brand.500"
          sx={{ fieldSizing: "content" }}
        />
        <IconButton
          aria-label="Send message"
          icon={<VscSend />}
          type="submit"
          isLoading={sending}
          isDisabled={!draft.trim()}
        />
      </Flex>
    </Flex>
  );
}

export default ChatView;
