### Fixed
- A pane dragged from the sidebar onto the pane area opens in a half even when the terminal or
  chat under the pointer redraws just before the drop; Chrome refused that drop before.

### Maintenance
- The sticky-modifiers check keeps herdr's stream from turning bracketed paste back on after the
  check turned it off, and the Windows install test no longer hides its first failure behind a
  failing cleanup stop.
