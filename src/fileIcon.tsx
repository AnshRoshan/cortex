import { IconType } from "react-icons";
import {
  SiC,
  SiCplusplus,
  SiCss3,
  SiDocker,
  SiGnubash,
  SiGo,
  SiHtml5,
  SiJavascript,
  SiJson,
  SiMarkdown,
  SiPhp,
  SiPython,
  SiReact,
  SiRuby,
  SiRust,
  SiSass,
  SiSvelte,
  SiToml,
  SiTypescript,
  SiVuedotjs,
  SiYaml,
} from "react-icons/si";
import { VscFile, VscFolder } from "react-icons/vsc";

export type IconSpec = { icon: IconType; color: string };

const MAP: Record<string, IconSpec> = {
  ts: { icon: SiTypescript, color: "#3178c6" },
  tsx: { icon: SiReact, color: "#61dafb" },
  js: { icon: SiJavascript, color: "#f7df1e" },
  jsx: { icon: SiReact, color: "#61dafb" },
  mjs: { icon: SiJavascript, color: "#f7df1e" },
  cjs: { icon: SiJavascript, color: "#f7df1e" },
  py: { icon: SiPython, color: "#4b8bbe" },
  rs: { icon: SiRust, color: "#dea584" },
  go: { icon: SiGo, color: "#00add8" },
  rb: { icon: SiRuby, color: "#cc342d" },
  php: { icon: SiPhp, color: "#8892bf" },
  html: { icon: SiHtml5, color: "#e34f26" },
  htm: { icon: SiHtml5, color: "#e34f26" },
  css: { icon: SiCss3, color: "#2965f1" },
  scss: { icon: SiSass, color: "#cc6699" },
  sass: { icon: SiSass, color: "#cc6699" },
  md: { icon: SiMarkdown, color: "#9aa7b6" },
  markdown: { icon: SiMarkdown, color: "#9aa7b6" },
  yml: { icon: SiYaml, color: "#cb171e" },
  yaml: { icon: SiYaml, color: "#cb171e" },
  toml: { icon: SiToml, color: "#9c6b3f" },
  sh: { icon: SiGnubash, color: "#4eaa25" },
  bash: { icon: SiGnubash, color: "#4eaa25" },
  zsh: { icon: SiGnubash, color: "#4eaa25" },
  cpp: { icon: SiCplusplus, color: "#00599c" },
  cc: { icon: SiCplusplus, color: "#00599c" },
  cxx: { icon: SiCplusplus, color: "#00599c" },
  hpp: { icon: SiCplusplus, color: "#00599c" },
  c: { icon: SiC, color: "#a8b9cc" },
  h: { icon: SiC, color: "#a8b9cc" },
  json: { icon: SiJson, color: "#cbcb41" },
  vue: { icon: SiVuedotjs, color: "#42b883" },
  svelte: { icon: SiSvelte, color: "#ff3e00" },
};

/** Material-icon-theme style: a colored language logo per file type. */
export function fileIcon(path: string): IconSpec {
  const name = (path.split("/").pop() ?? "").toLowerCase();
  if (name === "dockerfile") return { icon: SiDocker, color: "#2496ed" };
  const ext = name.split(".").pop() ?? "";
  return MAP[ext] ?? { icon: VscFile, color: "#8b8b93" };
}

// Folders stay folder-shaped; well-known names just get a distinct tint.
const FOLDER_COLORS: Record<string, string> = {
  ".vscode": "#3a9fd8",
  ".github": "#8b949e",
  ".git": "#f05032",
  ".claude": "#8b7bff",
  node_modules: "#cb3837",
  src: "#6b93d6",
  lib: "#6b93d6",
  dist: "#8b93a7",
  build: "#8b93a7",
  out: "#8b93a7",
  target: "#8b93a7",
  public: "#dd8a3c",
  static: "#dd8a3c",
  assets: "#dd8a3c",
  images: "#dd8a3c",
  docs: "#4b8bbe",
  documentation: "#4b8bbe",
  test: "#cc8f3a",
  tests: "#cc8f3a",
  __tests__: "#cc8f3a",
  spec: "#cc8f3a",
  migrations: "#7aa2f7",
  db: "#7aa2f7",
  database: "#7aa2f7",
  api: "#8fbf7f",
  server: "#8fbf7f",
  backend: "#8fbf7f",
  config: "#8b93a7",
  ".config": "#8b93a7",
  deploy: "#ff7b72",
  scripts: "#4eaa25",
};

/** Folder-shaped icon, tinted by well-known name (else default amber). */
export function folderIcon(name: string): IconSpec {
  return { icon: VscFolder, color: FOLDER_COLORS[name.toLowerCase()] ?? "#c6923e" };
}
