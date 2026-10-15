import { LOCAL_MACHINE } from "../../shared/machines.ts";
import { t } from "./i18n.ts";

/** A remote PC's read crosses the machine proxy as well, so it gets twice the local deadline. */
export function chatReadDeadlineMs(machineId: string): number {
  return machineId === LOCAL_MACHINE ? 15_000 : 30_000;
}

export class ChatReadTimeoutError extends Error {
  constructor() { super(t("Chat read timed out.")); this.name = "ChatReadTimeoutError"; }
}

/** Covers headers and body; even an implementation ignoring abort cannot hold the reader. */
export async function withChatReadDeadline<T>(read: (signal: AbortSignal) => Promise<T>, timeoutMs = 15_000, cancelled?: AbortSignal): Promise<T> {
  cancelled?.throwIfAborted();
  const controller = new AbortController();
  const cancellation = Promise.withResolvers<never>();
  const onCancel = () => { const reason = cancelled?.reason ?? new DOMException("Read cancelled", "AbortError"); controller.abort(reason); cancellation.reject(reason); };
  cancelled?.addEventListener("abort", onCancel, { once: true });
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { const error = new ChatReadTimeoutError(); reject(error); controller.abort(error); }, timeoutMs);
  });
  try {
    const result = await Promise.race([read(controller.signal), deadline, cancellation.promise]);
    cancelled?.throwIfAborted();
    return result;
  } finally { clearTimeout(timer!); cancelled?.removeEventListener("abort", onCancel); }
}
