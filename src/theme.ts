import { extendTheme, type ThemeConfig } from "@chakra-ui/react";

// Cortex design system — a cool graphite neutral base with a thin violet/indigo
// accent. Light + dark are both first-class via semantic tokens; components
// reference the token names (surface.*, ink.*) and adapt automatically.
const config: ThemeConfig = {
  initialColorMode: "dark",
  useSystemColorMode: false,
};

const fontStack = `"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif`;

const theme = extendTheme({
  config,
  fonts: {
    heading: fontStack,
    body: fontStack,
    mono: `"JetBrains Mono", "SF Mono", ui-monospace, Menlo, Consolas, monospace`,
  },
  colors: {
    // Indigo accent ramp for the Mono direction (works on both grounds).
    brand: {
      50: "#eeecff",
      100: "#ddd9ff",
      200: "#c0b8ff",
      300: "#a294ff",
      400: "#8b7bff",
      500: "#6b5bff",
      600: "#5b4bd6",
      700: "#4a3cae",
      800: "#392e88",
      900: "#2a2266",
    },
  },
  semanticTokens: {
    colors: {
      // Mono: near-black / paper, hairline borders.
      "surface.bg": { default: "#fbfbfa", _dark: "#0c0c0d" },
      "surface.panel": { default: "#ffffff", _dark: "#111112" },
      "surface.raised": { default: "#ffffff", _dark: "#161617" },
      "surface.hover": { default: "#f0f0ee", _dark: "#1d1d1f" },
      "surface.border": { default: "#e7e7e3", _dark: "#242427" },
      "surface.borderStrong": { default: "#d6d6d0", _dark: "#34343a" },
      "ink.base": { default: "#141414", _dark: "#ededed" },
      "ink.muted": { default: "#55555a", _dark: "#9a9a9f" },
      "ink.subtle": { default: "#8a8a86", _dark: "#5f5f66" },
      "accent.tint": {
        default: "rgba(91,75,214,0.09)",
        _dark: "rgba(139,123,255,0.14)",
      },
    },
  },
  shadows: {
    outline: "0 0 0 2px rgba(107, 91, 255, 0.55)",
    card: "0 1px 2px rgba(0,0,0,0.05), 0 6px 20px -14px rgba(0,0,0,0.25)",
    pop: "0 10px 34px -14px rgba(0,0,0,0.3)",
  },
  radii: {
    md: "4px",
    lg: "6px",
    xl: "8px",
  },
  styles: {
    global: {
      "html, body, #root": { height: "100%" },
      body: {
        bg: "surface.bg",
        color: "ink.base",
        WebkitFontSmoothing: "antialiased",
      },
      "::selection": { background: "rgba(109,94,252,0.35)" },
      "*::-webkit-scrollbar": { width: "10px", height: "10px" },
      "*::-webkit-scrollbar-thumb": {
        background: "var(--chakra-colors-surface-borderStrong)",
        borderRadius: "8px",
        border: "2px solid transparent",
        backgroundClip: "content-box",
      },
      "*::-webkit-scrollbar-track": { background: "transparent" },
    },
  },
  components: {
    Button: {
      defaultProps: { colorScheme: "brand" },
      baseStyle: {
        fontWeight: 600,
        borderRadius: "lg",
        letterSpacing: "-0.01em",
        _focusVisible: { boxShadow: "outline" },
      },
    },
    Input: {
      defaultProps: { focusBorderColor: "brand.500" },
      variants: {
        outline: {
          field: {
            bg: "surface.raised",
            borderColor: "surface.border",
            _hover: { borderColor: "surface.borderStrong" },
            _placeholder: { color: "ink.subtle" },
          },
        },
      },
    },
    Tooltip: {
      baseStyle: {
        bg: "surface.raised",
        color: "ink.base",
        border: "1px solid",
        borderColor: "surface.border",
        borderRadius: "md",
        fontSize: "xs",
        px: 2,
        py: 1,
        boxShadow: "pop",
      },
    },
    Tabs: { defaultProps: { colorScheme: "brand" } },
    Badge: {
      baseStyle: { borderRadius: "full", textTransform: "none", fontWeight: 600 },
    },
  },
});

export default theme;
