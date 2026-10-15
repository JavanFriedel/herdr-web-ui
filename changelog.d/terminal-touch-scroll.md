### Changed
- Scrolling a terminal's history with a finger follows it a line at a time and glides on after a
  flick, as a phone's lists do; a touch stops the glide. The scroll goes to herdr as one target at
  a time, at most every 100 ms, instead of a wheel report per step, so a fast swipe no longer
  queues a redraw per step. A program that has the screen to itself still gets the wheel.
- `scripts/scroll-perf-bench.ts` measures terminal scrolling on a slowed phone over a delayed link.
