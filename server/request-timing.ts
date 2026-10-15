import { TIMING_HEADER, formatServerTiming, timingRoute } from "../shared/timing.ts";
import { sameOrigin } from "./machine-security.ts";
import { collectTimings } from "./timing.ts";

export async function withRequestTiming(request: Request, answer: () => Promise<Response | undefined>): Promise<Response | undefined> {
  if (request.method !== "GET" || request.headers.get(TIMING_HEADER) !== "1" || !timingRoute(new URL(request.url).pathname) || !sameOrigin(request)) return answer();
  return collectTimings(async (context) => {
    const response = await answer();
    // The normal route gate enables collection; a diagnostic header never authorizes a read.
    if (response && context.enabled && response.status !== 401 && response.status !== 403) {
      context.entries.unshift({ stage: "server.total", start_ms: 0, duration_ms: performance.now() - context.start });
      response.headers.set("server-timing", formatServerTiming(context.entries));
    }
    return response;
  });
}
