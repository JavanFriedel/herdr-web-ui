### Fixed
- After a phone is unlocked or the network comes back, the app reconnects as soon as the network
  carries traffic instead of about 15 s later: while the network is in doubt a connect attempt
  that has not answered in 2 s is replaced by a fresh one, and the first that opens restarts every
  other stuck attempt and history read.

### Added
- The Reconnecting… line under the header has a Reconnect now button, and its Retry also restarts
  the pane connections.
