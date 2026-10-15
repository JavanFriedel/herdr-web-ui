### Fixed
- A phone unlocked after a while reconnects as soon as its network carries traffic again, instead
  of spinning until a deadline. A socket back from a long hide is probed at 1.5 s per ping; a
  connect attempt made while the page was hidden or on the previous network is replaced at once;
  and the app asks its server about once a second after a wake, so the moment one answer gets
  through, a socket attempt or chat read still stuck on the dead path is replaced with a fresh one.
