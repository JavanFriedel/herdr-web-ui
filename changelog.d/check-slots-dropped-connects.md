### Maintenance
- `bun run check` starts its herdr-backed runs where a connection to an unused loopback port is
  dropped instead of refused (a firewall rule, some WSL 2 setups): a free slot is now proved by
  binding its port, so it no longer reads as taken by something else. A silent listener still holds
  its slot.
