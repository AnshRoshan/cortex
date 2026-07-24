import { ChakraProvider, ColorModeScript } from "@chakra-ui/react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "rustpad-wasm";

import AuthGate from "./AuthGate";
import theme from "./theme";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ColorModeScript initialColorMode={theme.config.initialColorMode} />
    <ChakraProvider theme={theme}>
      <AuthGate />
    </ChakraProvider>
  </StrictMode>,
);
