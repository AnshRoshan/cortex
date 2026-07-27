import { Box } from "@chakra-ui/react";

// Renders live HTML in a sandboxed iframe: scripts run but the frame is walled
// off from our origin (no same-origin, no top navigation), so a previewed page
// can't touch cookies/session or break out of the pane.
// ponytail: srcDoc re-parses the whole doc on every keystroke; fine for a
// single editor, add debouncing if large docs feel janky.
function HtmlPreview({ text }: { text: string }) {
  return (
    <Box flex={1} minH={0} bg="white">
      <iframe
        title="HTML preview"
        srcDoc={text}
        sandbox="allow-scripts allow-forms allow-popups allow-modals"
        style={{ width: "100%", height: "100%", border: "none", background: "white" }}
      />
    </Box>
  );
}

export default HtmlPreview;
