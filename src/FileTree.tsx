import { Box, Collapse, HStack, Icon, IconButton, Text, Tooltip } from "@chakra-ui/react";
import { DragEvent, useState } from "react";
import {
  VscChevronDown,
  VscChevronRight,
  VscDesktopDownload,
  VscTrash,
} from "react-icons/vsc";

import { FileRow } from "./api";
import { fileIcon, folderIcon } from "./fileIcon";

type TreeNode = { name: string; children: Map<string, TreeNode>; file?: FileRow };

function buildTree(files: FileRow[]): TreeNode {
  const root: TreeNode = { name: "", children: new Map() };
  for (const f of files) {
    const parts = f.path.split("/").filter(Boolean);
    let node = root;
    parts.forEach((part, i) => {
      let child = node.children.get(part);
      if (!child) {
        child = { name: part, children: new Map() };
        node.children.set(part, child);
      }
      if (i === parts.length - 1) child.file = f;
      node = child;
    });
  }
  return root;
}

function sorted(node: TreeNode): TreeNode[] {
  return Array.from(node.children.values()).sort((a, b) => {
    const af = a.file ? 1 : 0;
    const bf = b.file ? 1 : 0;
    if (af !== bf) return af - bf;
    return a.name.localeCompare(b.name);
  });
}

/** Every folder path in the tree (for Collapse All). */
export function allFolderPaths(files: FileRow[]): string[] {
  const out: string[] = [];
  const walk = (node: TreeNode, parent: string) => {
    for (const c of Array.from(node.children.values())) {
      if (!c.file) {
        const p = parent ? `${parent}/${c.name}` : c.name;
        out.push(p);
        walk(c, p);
      }
    }
  };
  walk(buildTree(files), "");
  return out;
}

type Props = {
  files: FileRow[];
  activeFileId: number | null;
  collapsed: Set<string>;
  onToggle: (path: string) => void;
  onOpen: (f: FileRow) => void;
  onDownload: (f: FileRow) => void;
  onDelete: (f: FileRow) => void;
  onMove: (fileId: number, newPath: string) => void;
};

function FileTree(props: Props) {
  const { files, onMove } = props;
  const root = buildTree(files);

  function drop(targetPath: string, raw: string) {
    let p: { kind: string; id?: number; path: string };
    try {
      p = JSON.parse(raw);
    } catch {
      return;
    }
    if (!p?.path) return;
    if (p.kind === "file") {
      const base = p.path.split("/").pop() ?? p.path;
      const np = targetPath ? `${targetPath}/${base}` : base;
      if (np !== p.path && p.id != null) onMove(p.id, np);
    } else if (p.kind === "folder") {
      const F = p.path;
      if (targetPath === F || targetPath.startsWith(F + "/")) return;
      const name = F.split("/").pop() ?? F;
      const newFolder = targetPath ? `${targetPath}/${name}` : name;
      if (newFolder === F) return;
      for (const f of files) {
        if (f.path === F || f.path.startsWith(F + "/")) {
          onMove(f.id, newFolder + f.path.slice(F.length));
        }
      }
    }
  }

  return (
    <Box
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        drop("", e.dataTransfer.getData("text/plain"));
      }}
      minH="8px"
    >
      {sorted(root).map((n) => (
        <TreeItem key={n.name} node={n} parentPath="" drop={drop} {...props} />
      ))}
    </Box>
  );
}

function TreeItem({
  node,
  parentPath,
  activeFileId,
  collapsed,
  onToggle,
  onOpen,
  onDownload,
  onDelete,
  drop,
}: {
  node: TreeNode;
  parentPath: string;
  drop: (targetPath: string, raw: string) => void;
} & Omit<Props, "files" | "onMove">) {
  const [over, setOver] = useState(false);
  const pad = 8 + parentPath.split("/").filter(Boolean).length * 12;

  if (node.file) {
    const f = node.file;
    const fi = fileIcon(f.path);
    const active = f.id === activeFileId;
    return (
      <HStack
        draggable
        onDragStart={(e: DragEvent) =>
          e.dataTransfer.setData(
            "text/plain",
            JSON.stringify({ kind: "file", id: f.id, path: f.path }),
          )
        }
        pl={`${pad}px`}
        pr={1.5}
        py={1.5}
        borderRadius="md"
        cursor="pointer"
        role="group"
        spacing={2}
        bg={active ? "accent.tint" : "transparent"}
        color={active ? "ink.base" : "ink.muted"}
        _hover={{ bg: active ? "accent.tint" : "surface.hover" }}
        onClick={() => onOpen(f)}
      >
        <Icon as={fi.icon} color={fi.color} fontSize="sm" flexShrink={0} />
        <Text fontSize="sm" flex={1} isTruncated>
          {node.name}
        </Text>
        <HStack spacing={0} opacity={0} _groupHover={{ opacity: 1 }}>
          <Tooltip label="Download" openDelay={400}>
            <IconButton
              aria-label="Download"
              icon={<VscDesktopDownload />}
              size="xs"
              variant="ghost"
              color="green.400"
              onClick={(e) => {
                e.stopPropagation();
                onDownload(f);
              }}
            />
          </Tooltip>
          <Tooltip label="Delete" openDelay={400}>
            <IconButton
              aria-label="Delete"
              icon={<VscTrash />}
              size="xs"
              variant="ghost"
              color="red.400"
              onClick={(e) => {
                e.stopPropagation();
                onDelete(f);
              }}
            />
          </Tooltip>
        </HStack>
      </HStack>
    );
  }

  const folderPath = parentPath ? `${parentPath}/${node.name}` : node.name;
  const open = !collapsed.has(folderPath);
  const fic = folderIcon(node.name);

  return (
    <Box>
      <HStack
        draggable
        onDragStart={(e: DragEvent) => {
          e.stopPropagation();
          e.dataTransfer.setData("text/plain", JSON.stringify({ kind: "folder", path: folderPath }));
        }}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOver(false);
          drop(folderPath, e.dataTransfer.getData("text/plain"));
        }}
        pl={`${pad}px`}
        pr={2}
        py={1.5}
        spacing={1.5}
        borderRadius="md"
        cursor="pointer"
        color="ink.muted"
        bg={over ? "accent.tint" : "transparent"}
        _hover={{ bg: over ? "accent.tint" : "surface.hover", color: "ink.base" }}
        onClick={() => onToggle(folderPath)}
      >
        <Icon as={open ? VscChevronDown : VscChevronRight} fontSize="sm" color="ink.subtle" />
        <Icon as={fic.icon} fontSize="sm" color={fic.color} />
        <Text fontSize="sm" flex={1} fontWeight={500} isTruncated>
          {node.name}
        </Text>
      </HStack>
      <Collapse in={open} animateOpacity>
        {sorted(node).map((c) => (
          <TreeItem
            key={c.name}
            node={c}
            parentPath={folderPath}
            drop={drop}
            activeFileId={activeFileId}
            collapsed={collapsed}
            onToggle={onToggle}
            onOpen={onOpen}
            onDownload={onDownload}
            onDelete={onDelete}
          />
        ))}
      </Collapse>
    </Box>
  );
}

export default FileTree;
