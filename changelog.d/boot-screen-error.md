### Fixed
- When the app cannot reach its server on start, it no longer says "Connecting to herdr web ui…"
  for good: the first health read is dropped after 8 seconds, and a failed one shows "Can't reach
  herdr web ui" with the reason and a Retry button. The app keeps trying every few seconds.
