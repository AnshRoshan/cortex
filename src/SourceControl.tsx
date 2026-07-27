import { Box, Flex, HStack, Icon, Text, Tooltip } from "@chakra-ui/react";
import { VscClearAll, VscSourceControl } from "react-icons/vsc";

import { fileIcon } from "./fileIcon";
import { PanelHeader, PanelIconButton } from "./ui";

export type ChangeType = "added" | "renamed";
export type SessionChange = { id: number; path: string; type: ChangeType };

// Badge letter + color per change type, mirroring VS Code's SCM gutter letters.
const BADGE: Record<ChangeType, { letter: string; color: string; title: string }> = {
  added: { letter: "A", color: "green.400", title: "Added this session" },
  renamed: { letter: "R", color: "brand.400", title: "Renamed this session" },
};

type Props = {
  changes: SessionChange[];
  onOpen: (id: number) => void;
  onClear: () => void;
};

function SourceControl({ changes, onOpen, onClear }: Props) {
  return (
    <Flex direction="column" h="full">
      <PanelHeader
        title="Source Control"
        actions={
          <Tooltip label="Clear change list" openDelay={400}>
            <PanelIconButton
              aria-label="Clear change list"
              icon={<VscClearAll />}
              isDisabled={changes.length === 0}
              onClick={onClear}
            />
          </Tooltip>
        }
      />

      {changes.length === 0 ? (
        <Flex direction="column" align="center" justify="center" flex={1} gap={3} px={6} textAlign="center">
          <Icon as={VscSourceControl} fontSize="3xl" color="ink.subtle" opacity={0.6} />
          <Text fontSize="xs" color="ink.subtle">
            No changes yet. Files you create or move this session show up here.
          </Text>
        </Flex>
      ) : (
        <Box overflowY="auto" px={1}>
          <HStack px={2} py={1} spacing={2}>
            <Text fontSize="xs" fontWeight="bold" textTransform="uppercase" color="ink.subtle">
              Changes
            </Text>
            <Box bg="surface.hover" color="ink.muted" fontSize="10px" fontWeight={700} px={1.5} borderRadius="full">
              {changes.length}
            </Box>
          </HStack>
          {changes.map((c) => {
            const fi = fileIcon(c.path);
            const name = c.path.split("/").pop() ?? c.path;
            const dir = c.path.slice(0, c.path.length - name.length).replace(/\/$/, "");
            const b = BADGE[c.type];
            return (
              <HStack
                key={c.id}
                px={2}
                py={1.5}
                spacing={2}
                borderRadius="md"
                cursor="pointer"
                role="group"
                _hover={{ bg: "surface.hover" }}
                onClick={() => onOpen(c.id)}
              >
                <Icon as={fi.icon} color={fi.color} fontSize="sm" flexShrink={0} />
                <Text fontSize="sm" color="ink.base" isTruncated>
                  {name}
                </Text>
                {dir && (
                  <Text fontSize="xs" color="ink.subtle" isTruncated flex={1} minW={0}>
                    {dir}
                  </Text>
                )}
                <Tooltip label={b.title} openDelay={400}>
                  <Text
                    ml="auto"
                    flexShrink={0}
                    fontFamily="mono"
                    fontSize="xs"
                    fontWeight={700}
                    color={b.color}
                  >
                    {b.letter}
                  </Text>
                </Tooltip>
              </HStack>
            );
          })}
        </Box>
      )}
    </Flex>
  );
}

export default SourceControl;
