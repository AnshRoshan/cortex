import { Avatar, Badge, Box, Center, Flex, HStack, Icon, Text } from "@chakra-ui/react";
import { useMemo } from "react";
import { VscComment } from "react-icons/vsc";

import { Me, Member } from "./api";

export type ChatTarget = { kind: "ws" } | { kind: "dm"; userId: number };

type Props = {
  me: Me;
  workspaceId: number | null;
  members: Member[];
  target: ChatTarget;
  onSelect: (t: ChatTarget) => void;
};

function Row({
  active,
  label,
  sub,
  icon,
  avatarName,
  badge,
  onClick,
}: {
  active: boolean;
  label: string;
  sub?: string;
  icon?: typeof VscComment;
  avatarName?: string;
  badge?: string;
  onClick: () => void;
}) {
  return (
    <HStack
      px={2.5}
      py={1.5}
      mx={2}
      spacing={2.5}
      borderRadius="md"
      cursor="pointer"
      bg={active ? "accent.tint" : "transparent"}
      _hover={{ bg: active ? "accent.tint" : "surface.hover" }}
      onClick={onClick}
    >
      {icon ? (
        <Center boxSize="26px" borderRadius="6px" bg="surface.hover" color="ink.muted" flexShrink={0}>
          <Icon as={icon} fontSize="14px" />
        </Center>
      ) : (
        <Avatar size="xs" name={avatarName} bg="brand.600" color="white" />
      )}
      <Box minW={0} flex={1}>
        <HStack spacing={1.5}>
          <Text fontSize="sm" color={active ? "ink.base" : "ink.muted"} fontWeight={active ? 600 : 400} isTruncated>
            {label}
          </Text>
          {badge && (
            <Badge colorScheme="brand" variant="subtle" fontSize="0.55rem">
              {badge}
            </Badge>
          )}
        </HStack>
        {sub && (
          <Text fontSize="xs" color="ink.subtle" isTruncated>
            {sub}
          </Text>
        )}
      </Box>
    </HStack>
  );
}

function Label({ children }: { children: string }) {
  return (
    <Text px={4} py={1} fontSize="11px" fontWeight={700} textTransform="uppercase" letterSpacing="0.05em" color="ink.subtle">
      {children}
    </Text>
  );
}

function ChatChannels({ me, workspaceId, members, target, onSelect }: Props) {
  const peers = useMemo(() => members.filter((m) => m.email !== me.email), [members, me.email]);

  return (
    <Flex direction="column" flex={1} minH={0} overflowY="auto" py={2}>
      {workspaceId != null && (
        <>
          <Label>Channels</Label>
          <Row
            active={target.kind === "ws"}
            icon={VscComment}
            label="Workspace"
            sub="Group chat"
            onClick={() => onSelect({ kind: "ws" })}
          />
        </>
      )}

      <Box mt={2}>
        <Label>Direct Messages</Label>
        {peers.map((p) => (
          <Row
            key={p.id}
            active={target.kind === "dm" && target.userId === p.id}
            avatarName={p.name || p.email}
            label={p.name || p.email}
            sub={p.name ? p.email : undefined}
            badge={p.role === "admin" ? "admin" : undefined}
            onClick={() => onSelect({ kind: "dm", userId: p.id })}
          />
        ))}
        {peers.length === 0 && (
          <Text px={4} py={2} fontSize="xs" color="ink.subtle">
            No one else in your org yet.
          </Text>
        )}
      </Box>
    </Flex>
  );
}

export default ChatChannels;
