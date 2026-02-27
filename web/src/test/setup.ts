import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

afterEach(() => {
  cleanup();
});

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
