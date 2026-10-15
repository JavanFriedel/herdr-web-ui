import type { Translate } from "./i18n.ts";

/** How long the first health read may take before it is dropped: on a dead path a request waits
 *  out the browser's own deadline, minutes, while the screen says only "Connecting…". */
export const HEALTH_TRY_MS = 8000;

/** Why the first health read failed, for the boot screen: a timeout by its length, else the error's own words. */
export function bootFailureText(error: unknown, t: Translate): string {
  if (error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError")) {
    return t("No answer after {seconds} s", { seconds: HEALTH_TRY_MS / 1000 });
  }
  return error instanceof Error && error.message ? error.message : String(error);
}
