### Fixed
- When the app cannot reach its server on start, it no longer says "Connecting to herdr web ui…"
  forever. After a few seconds it shows how long it has waited. When the server does not answer
  within 8 seconds, or the request fails, it says "Can't reach herdr web ui" with the browser's
  reason, the address it tried and a hint to check the device's network or VPN, counts down to
  the next try and offers Retry.
