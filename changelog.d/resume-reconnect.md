### Fixed
- A phone unlocked after a while reconnects in seconds instead of spinning until a deadline: a
  socket back from a long hide is probed at 1.5 s per ping, a connect attempt made while the page
  was hidden or on the previous network is replaced at once, and the network coming back replaces
  an attempt still connecting.
