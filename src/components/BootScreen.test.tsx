import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ApiError } from "../lib/api.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { BootScreen, type BootFailure } from "./BootScreen.tsx";

function render(props: { networkOnline?: boolean; startedAt?: number; failure?: BootFailure | null; nextTryAt?: number }): string {
  const languages = Object.getOwnPropertyDescriptor(navigator, "languages");
  const onLine = Object.getOwnPropertyDescriptor(navigator, "onLine");
  Object.defineProperty(navigator, "languages", { configurable: true, value: ["en"] });
  Object.defineProperty(navigator, "onLine", { configurable: true, value: props.networkOnline ?? true });
  try {
    const now = Date.now();
    return renderToStaticMarkup(createElement(SettingsProvider, {
      children: createElement(BootScreen, {
        host: "desktop.example.ts.net:7317", startedAt: props.startedAt ?? now, failure: props.failure ?? null,
        nextTryAt: props.nextTryAt ?? now + 3000, onRetry: () => undefined,
      }),
    }));
  } finally {
    if (languages) Object.defineProperty(navigator, "languages", languages);
    else Reflect.deleteProperty(navigator, "languages");
    if (onLine) Object.defineProperty(navigator, "onLine", onLine);
    else Reflect.deleteProperty(navigator, "onLine");
  }
}

describe("the boot screen", () => {
  it("waits quietly, then says how long it has waited", () => {
    expect(render({})).toContain("Connecting to herdr web ui…");
    expect(render({})).not.toContain("Retry");
    expect(render({ startedAt: Date.now() - 12_000 })).toContain("No answer yet · 12 s");
  });

  it("says a failure in the browser's own words, with the address asked and a retry", () => {
    const html = render({ failure: { error: new TypeError("Failed to fetch"), timeoutMs: 8000 } });
    expect(html).toContain("Can&#x27;t reach herdr web ui");
    expect(html).toContain("Failed to fetch");
    expect(html).toContain("desktop.example.ts.net:7317");
    expect(html).toContain("Trying again in 3 s");
    expect(html).toContain("Retry");
  });

  it("names a dropped question by its deadline and a refusal by its status", () => {
    expect(render({ failure: { error: new DOMException("signal timed out", "TimeoutError"), timeoutMs: 8000 } })).toContain("No answer after 8 s");
    expect(render({ failure: { error: new ApiError("/api/health", 502, "Bad Gateway", null), timeoutMs: 8000 } })).toContain("The server answered 502: Bad Gateway");
  });

  it("puts no network first", () => {
    const html = render({ networkOnline: false, failure: { error: new TypeError("Failed to fetch"), timeoutMs: 8000 } });
    expect(html).toContain("No network");
    expect(html).toContain("This device has no network connection.");
  });
});
