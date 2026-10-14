import { renameSync, statSync } from "node:fs";

/** server.log past this many bytes is set aside before the next start opens it */
export const SERVER_LOG_MAX_BYTES = 1024 * 1024;

/**
 * server.log is the server's own stdout and stderr, opened for appending when it starts and held
 * for as long as it runs, so it can only be rotated here: before a start opens it. One that has
 * grown past `maxBytes` becomes `server.log.1`, replacing the copy before it. Failed requests go
 * to their own size-rotated log (server/request-log.ts); this one holds starts, stops and crashes.
 */
export function rotateServerLog(file: string, maxBytes = SERVER_LOG_MAX_BYTES): boolean {
  try {
    if (statSync(file).size <= maxBytes) return false;
    renameSync(file, `${file}.1`);
    return true;
  } catch {
    // no log yet, or one that cannot be moved: the start appends to it as before
    return false;
  }
}
