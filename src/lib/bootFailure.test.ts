import { describe, expect, it } from "bun:test";

import { bootFailureText } from "./bootFailure.ts";

const t = (key: string, vars?: Record<string, string | number>): string => key.replace(/\{(\w+)\}/g, (_, name: string) => String(vars?.[name]));

describe("bootFailureText", () => {
  it("names a dropped read by its deadline", () => {
    expect(bootFailureText(new DOMException("signal timed out", "TimeoutError"), t)).toBe("No answer after 8 s");
  });

  it("keeps the browser's and the server's own words otherwise", () => {
    expect(bootFailureText(new TypeError("Failed to fetch"), t)).toBe("Failed to fetch");
    expect(bootFailureText("refused", t)).toBe("refused");
  });
});
