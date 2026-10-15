# Slow reconnect diagnostics

The browser automatically reports a connection or chat-history wait lasting **5 seconds**, a
connection/history timeout, and its recovery. Fast reconnects are not written. There is no Settings
panel, recording switch, or external telemetry service.

Read the recent reports from an authenticated app connection at
`GET /api/diagnostics/reconnect`. The response contains `slow_ms` and `records`. The same server keeps
them in `<stateDir>/logs/reconnect.json`: at most 32 reports / 256 KiB, written atomically with private
permissions. `POST` requires same-origin access, the existing write permission, and
`x-herdr-machine: 1`; it accepts only allowlisted timing fields, at most 32 KiB / 64 events, and limits
writes to 30 per minute. Reports are best effort, never queued or retried offline.

Each load/resume/online episode has a random ID linking its `slow`, `timeout`, and `recovered`
records. Events contain a start offset, duration in milliseconds, outcome and optional anonymized
target, fixed route name or numeric status. They never contain chat text, keystrokes, URLs, file
paths, credentials, error messages, or persistent device/pane identifiers.

Browser events separate socket opening/snapshot/probing/input readiness, waiting behind a history
read, HTTP headers/body/JSON, history preparation, React commit, and the next animation frame.
Allowlisted reads carry `x-herdr-timing: 1`; authenticated same-origin responses add bounded
`Server-Timing` spans for access checks, herdr socket connect/wait/decode, transcript resolution and
store reads, serialization/compression, and remote proxy headers/body. Browser, connection-server,
and remote-server offsets have **independent clocks**: compare durations, not absolute offsets
between them. Overlapping spans must not be summed. The next frame is a paint opportunity, not a
measurement of physical screen presentation.

An older remote bridge supplies no internal spans (`http.no-remote-timing`) and may lack WebSocket
ping support (`ws.no-ping`). The connection server still times the upstream request. Diagnostics do
not change socket probe/retry deadlines or send input. A hidden or superseded chat cancels its
obsolete history read so the next visible refresh can start without waiting for the old 15-second
local / 30-second remote deadline.
