### Changed
- Settings → Terminal → Renderer: Auto (the default) draws the terminal with the GPU (WebGL) on a
  touch screen, GPU always does, Compatible keeps the DOM renderer. A lost GPU context falls back.
- The server sends a redraw as one frame instead of a frame per read, and compresses its
  WebSocket messages: fewer frames to parse and acknowledge, and about a quarter of the bytes.
