/**
 * Whether the person is at this PC, answered by a command they name in
 * `HERDR_WEB_PRESENCE_CMD`. herdr knows nothing of a keyboard: a person working in another pane,
 * another app or the herdr TUI still gets every alert their phone is subscribed to. The command
 * fills that gap with whatever the PC can tell (its idle time, a screen lock, a desktop session),
 * and push.ts asks it only when an alert is about to go out.
 *
 * The command runs through the platform's shell (`sh -c`, or `cmd /d /s /c` on Windows), as the
 * line the owner wrote in the server's environment. Its exit status is the answer:
 * - 0: at the PC. The alert is held, as one is while a window of the app is in use.
 * - 1: away. The alert goes out.
 * - anything else, a command that will not start, or one still running at the deadline: logged,
 *   and taken as away. A broken check that held alerts would lose them; one that lets them
 *   through costs at most an alert the person did not need.
 *
 * One answer serves every alert for `reuseMs`, and alerts that ask while the command runs share
 * that run: a burst of finishing panes runs it once.
 */

export const PRESENCE_TIMEOUT_MS = 3_000;
export const PRESENCE_REUSE_MS = 10_000;

export interface PresenceOptions {
  command: string;
  timeoutMs?: number;
  reuseMs?: number;
  now?: () => number;
  platform?: NodeJS.Platform;
  log?: (message: string) => void;
}

/** Answers true while the person is at this PC. */
export type PresenceCheck = () => Promise<boolean>;

export function shellArgv(command: string, platform: NodeJS.Platform = process.platform): string[] {
  return platform === "win32" ? ["cmd.exe", "/d", "/s", "/c", command] : ["sh", "-c", command];
}

export function createPresenceCheck(options: PresenceOptions): PresenceCheck {
  const timeoutMs = options.timeoutMs ?? PRESENCE_TIMEOUT_MS;
  const reuseMs = options.reuseMs ?? PRESENCE_REUSE_MS;
  const now = options.now ?? Date.now;
  const log = options.log ?? ((message: string) => console.error(message));
  const argv = shellArgv(options.command, options.platform);
  let last: { at: number; present: boolean } | null = null;
  let running: Promise<boolean> | null = null;

  async function run(): Promise<boolean> {
    let proc: Bun.Subprocess<"ignore", "ignore", "ignore">;
    try {
      proc = Bun.spawn(argv, { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    } catch (error) {
      log(`presence command could not start: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGKILL");
    }, timeoutMs);
    try {
      const code = await proc.exited;
      if (timedOut) {
        log(`presence command still ran after ${timeoutMs} ms; alerts go out`);
        return false;
      }
      if (code === 0) return true;
      if (code !== 1) log(`presence command exited ${code}; alerts go out`);
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  return () => {
    if (last !== null && now() - last.at < reuseMs) return Promise.resolve(last.present);
    if (running === null) {
      running = run().then((present) => {
        last = { at: now(), present };
        return present;
      }).finally(() => { running = null; });
    }
    return running;
  };
}

/** The check `HERDR_WEB_PRESENCE_CMD` names, or none when it is unset or blank. */
export function presenceFromEnv(env: Record<string, string | undefined> = process.env): PresenceCheck | undefined {
  const command = env["HERDR_WEB_PRESENCE_CMD"]?.trim();
  return command ? createPresenceCheck({ command }) : undefined;
}
