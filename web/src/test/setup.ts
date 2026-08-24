import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach, vi } from "vitest";
import { assertFetchNotLeaked } from "./swapped-fetch";

afterEach(() => {
  cleanup();
});

// A test that leaves `globalThis.fetch` swapped changes what every later test
// in the file talks to without failing anything, so the suite stops being a
// function of its own source. `beforeEach` is where this is checkable: it runs
// after the previous test's `afterEach` hooks and after the enclosing suites'
// `beforeAll` hooks, so a swap still standing here has outlived its scope.
beforeEach(() => {
  assertFetchNotLeaked();
});

// jsdom implements neither the Pointer Events capture API nor scrollIntoView,
// and Radix's Select calls all three while opening. Without these a `<Select>`
// throws "target.hasPointerCapture is not a function" the moment a test clicks
// its trigger, which reads like a component bug rather than a missing DOM API.
// This file is also the setup for the `node`-environment route suites, where
// there is no DOM at all, hence the guard.
if (typeof Element !== "undefined") {
  for (const method of [
    "hasPointerCapture",
    "setPointerCapture",
    "releasePointerCapture",
    "scrollIntoView",
  ] as const) {
    if (!(method in Element.prototype)) {
      Object.defineProperty(Element.prototype, method, {
        value: () => undefined,
        writable: true,
      });
    }
  }
}

// Mock next/navigation
vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    prefetch: vi.fn(),
    refresh: vi.fn(),
  }),
  usePathname: () => "/",
  useParams: () => ({}),
  useSearchParams: () => new URLSearchParams(),
}));

// Mock EventSource
class MockEventSource {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;
  readyState = MockEventSource.CONNECTING;
  url: string;
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  private listeners: Map<string, ((ev: Event) => void)[]> = new Map();

  constructor(url: string) {
    this.url = url;
    setTimeout(() => {
      this.readyState = MockEventSource.OPEN;
      this.onopen?.(new Event("open"));
    }, 0);
  }

  addEventListener(type: string, listener: (ev: Event) => void) {
    const list = this.listeners.get(type) || [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  removeEventListener(type: string, listener: (ev: Event) => void) {
    const list = this.listeners.get(type) || [];
    this.listeners.set(
      type,
      list.filter((l) => l !== listener)
    );
  }

  close() {
    this.readyState = MockEventSource.CLOSED;
  }

  // Test helpers
  _emit(type: string, data: unknown) {
    const event = new MessageEvent(type, {
      data: typeof data === "string" ? data : JSON.stringify(data),
    });
    if (type === "message") {
      this.onmessage?.(event);
    } else {
      const listeners = this.listeners.get(type) || [];
      for (const listener of listeners) {
        listener(event);
      }
    }
  }

  _triggerError() {
    this.readyState = MockEventSource.CLOSED;
    this.onerror?.(new Event("error"));
  }
}

Object.assign(globalThis, { EventSource: MockEventSource });
