### Added
- Failed and slow requests are written to `logs/requests.log` in the state directory: one JSON line
  with the time, status, path, pane, duration and error, so a `502` the chat showed can be traced to
  the herdr call that timed out. It is rotated at 1 MiB with three older copies kept, and
  `HERDR_WEB_SLOW_REQUEST_MS` sets what counts as slow (3 s by default).

### Changed
- The plugin sets `server.log` aside as `server.log.1` when a start finds it over 1 MiB, so it no
  longer grows without end.
