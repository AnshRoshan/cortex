import {
  Box,
  Center,
  Flex,
  Icon,
  IconButton,
  Text,
  Textarea,
  useToast,
} from "@chakra-ui/react";
import { FormEvent, KeyboardEvent, useEffect, useRef, useState } from "react";
import { VscSparkle, VscSend } from "react-icons/vsc";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import * as api from "./api";
import { AiMessage } from "./api";

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

function AiView({ workspaceId }: { workspaceId: number | null }) {
  const toast = useToast();
  const [messages, setMessages] = useState<AiMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, busy]);

  async function send() {
    const text = draft.trim();
    if (!text || busy || workspaceId == null) return;
    const next = [...messages, { role: "user" as const, content: text }];
    setMessages(next);
    setDraft("");
    setBusy(true);
    try {
      const { reply } = await api.aiChat(workspaceId, next);
      setMessages((m) => [...m, { role: "assistant", content: reply || "(no response)" }]);
    } catch (e) {
      toast({ title: e instanceof Error ? e.message : "AI request failed", status: "error", duration: 4000 });
      setMessages((m) => m.slice(0, -1)); // roll back the unanswered prompt
      setDraft(text);
    } finally {
      setBusy(false);
      requestAnimationFrame(() => inputRef.current?.focus());
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
      <Flex align="center" gap={2.5} px={5} h={14} borderBottom="1px solid" borderColor="surface.border" flexShrink={0}>
        <Icon as={VscSparkle} color="brand.400" fontSize="18px" />
        <Box minW={0}>
          <Text fontSize="md" fontWeight="semibold" color="ink.base">
            Assistant
          </Text>
          <Text fontSize="xs" color="ink.subtle" isTruncated>
            Answers grounded in this workspace's files
          </Text>
        </Box>
      </Flex>

      <Box flex={1} minH={0} overflowY="auto" px={{ base: 4, md: 8 }} py={6}>
        {messages.length === 0 ? (
          <Center flexDirection="column" gap={3} py={16} color="ink.muted" textAlign="center">
            <Icon as={VscSparkle} fontSize="3xl" color="ink.subtle" />
            <Text fontSize="sm" maxW="sm">
              Ask about the files in this workspace — summaries, explanations, where something is
              defined, or how two files relate.
            </Text>
          </Center>
        ) : (
          <Flex direction="column" gap={5} maxW="820px" mx="auto">
            {messages.map((m, i) =>
              m.role === "user" ? (
                <Box key={i} alignSelf="flex-end" maxW="85%" bg="brand.500" color="white" px={4} py={2.5} borderRadius="14px" borderBottomRightRadius="4px" fontSize="sm" whiteSpace="pre-wrap">
                  {m.content}
                </Box>
              ) : (
                <Flex key={i} gap={3} align="flex-start">
                  <Center boxSize="28px" borderRadius="full" bg="accent.tint" color="brand.400" flexShrink={0} mt={0.5}>
                    <Icon as={VscSparkle} fontSize="15px" />
                  </Center>
                  <Box flex={1} minW={0} fontSize="sm" color="ink.base" sx={mdSx}>
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown>
                  </Box>
                </Flex>
              ),
            )}
            {busy && (
              <Flex gap={3} align="center" color="ink.subtle" fontSize="sm" fontStyle="italic">
                <Center boxSize="28px" borderRadius="full" bg="accent.tint" color="brand.400">
                  <Icon as={VscSparkle} fontSize="15px" />
                </Center>
                Thinking…
              </Flex>
            )}
            <div ref={bottomRef} />
          </Flex>
        )}
      </Box>

      <Box as="form" px={4} py={3} flexShrink={0} onSubmit={(e: FormEvent) => { e.preventDefault(); send(); }}>
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
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            isDisabled={workspaceId == null || busy}
            variant="unstyled"
            placeholder={workspaceId == null ? "Open a workspace to use the assistant…" : "Ask about this workspace…"}
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
