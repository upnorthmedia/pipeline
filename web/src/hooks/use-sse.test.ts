import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useSSE } from "./use-sse";

interface MockES {
  url: string;
  readyState: number;
  onopen: ((ev: Event) => void) | null;
  onmessage: ((ev: MessageEvent) => void) | null;
  onerror: ((ev: Event) => void) | null;
  listeners: Map<string, ((ev: Event) => void)[]>;
  close: () => void;
  addEventListener: (type: string, listener: (ev: Event) => void) => void;
}

let instances: MockES[] = [];

function createMockEventSource() {
  class MockEventSource {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSED = 2;
    readyState = 0;
    url: string;
    onopen: ((ev: Event) => void) | null = null;
    onmessage: ((ev: MessageEvent) => void) | null = null;
    onerror: ((ev: Event) => void) | null = null;
    listeners: Map<string, ((ev: Event) => void)[]> = new Map();

    constructor(url: string) {
      this.url = url;
      instances.push(this as unknown as MockES);
      // Auto-open after microtask
      Promise.resolve().then(() => {
        if (this.readyState === 0) {
          this.readyState = 1;
          this.onopen?.(new Event("open"));
        }
      });
    }

    addEventListener(type: string, listener: (ev: Event) => void) {
      const list = this.listeners.get(type) || [];
      list.push(listener);
      this.listeners.set(type, list);
    }

    removeEventListener() {}

    close() {
      this.readyState = 2;
    }
  }
  return MockEventSource;
}

function emitMessage(source: MockES, data: unknown, lastEventId = "") {
  const event = new MessageEvent("message", {
    data: typeof data === "string" ? data : JSON.stringify(data),
    lastEventId,
  });
  source.onmessage?.(event);
}

function emitNamedEvent(
  source: MockES,
  type: string,
  data: unknown,
  lastEventId = ""
) {
  const event = new MessageEvent(type, {
    data: typeof data === "string" ? data : JSON.stringify(data),
    lastEventId,
  });
  const listeners = source.listeners.get(type) || [];
  for (const listener of listeners) {
    listener(event);
  }
}

function triggerError(source: MockES) {
  source.readyState = 2;
  source.onerror?.(new Event("error"));
}

beforeEach(() => {
  instances = [];
  vi.stubGlobal("EventSource", createMockEventSource());
});

afterEach(() => {
  vi.restoreAllMocks();
  instances = [];
});

describe("useSSE", () => {
  it("connects to global SSE endpoint when no postId", async () => {
    renderHook(() => useSSE());
    await waitFor(() => expect(instances).toHaveLength(1));
    expect(instances[0].url).toBe("http://localhost:8055/api/events");
  });

  it("connects to post-specific SSE endpoint", async () => {
    renderHook(() => useSSE("post-123"));
    await waitFor(() => expect(instances).toHaveLength(1));
    expect(instances[0].url).toBe("http://localhost:8055/api/events/post-123");
  });

  it("sets connected to true on open", async () => {
    const { result } = renderHook(() => useSSE());
    await waitFor(() => expect(result.current.connected).toBe(true));
  });

  it("receives message events and updates lastEvent", async () => {
    const { result } = renderHook(() => useSSE());
    await waitFor(() => expect(result.current.connected).toBe(true));

    act(() => {
      emitMessage(instances[0], {
        event: "stage_complete",
        post_id: "p1",
        stage: "research",
      });
    });

    expect(result.current.lastEvent).toEqual({
      event: "stage_complete",
      post_id: "p1",
      stage: "research",
    });
  });

  it("receives named events and sets event type", async () => {
    const callback = vi.fn();
    renderHook(() => useSSE(undefined, callback));
    await waitFor(() => expect(instances).toHaveLength(1));
    // Wait for connection
    await waitFor(() => expect(instances[0].readyState).toBe(1));

    act(() => {
      emitNamedEvent(instances[0], "stage_complete", {
        post_id: "p1",
        stage: "outline",
      });
    });

    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "stage_complete",
        post_id: "p1",
        stage: "outline",
      })
    );
  });

  it("calls onEvent callback for message events", async () => {
    const callback = vi.fn();
    const { result } = renderHook(() => useSSE(undefined, callback));
    await waitFor(() => expect(result.current.connected).toBe(true));

    act(() => {
      emitMessage(instances[0], {
        event: "pipeline_complete",
        post_id: "p2",
      });
    });

    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({ event: "pipeline_complete", post_id: "p2" })
    );
  });

  it("reconnects after error", async () => {
    vi.useFakeTimers();

    renderHook(() => useSSE());

    // Let the constructor's Promise.resolve() fire
    await vi.advanceTimersByTimeAsync(1);
    expect(instances).toHaveLength(1);

    // Trigger error on first connection
    act(() => {
      triggerError(instances[0]);
    });

    // Advance past reconnect delay (3000ms)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3100);
    });

    expect(instances.length).toBeGreaterThanOrEqual(2);

    vi.useRealTimers();
  });

  it("cleans up EventSource on unmount", async () => {
    const { unmount } = renderHook(() => useSSE());
    await waitFor(() => expect(instances).toHaveLength(1));

    const source = instances[0];
    unmount();

    expect(source.readyState).toBe(2); // CLOSED
  });

  it("reconnects with new EventSource when postId changes", async () => {
    const { rerender } = renderHook(({ id }) => useSSE(id), {
      initialProps: { id: "post-1" as string | undefined },
    });
    await waitFor(() => expect(instances).toHaveLength(1));
    expect(instances[0].url).toContain("post-1");

    rerender({ id: "post-2" });
    await waitFor(() => expect(instances.length).toBeGreaterThanOrEqual(2));
    expect(instances[instances.length - 1].url).toContain("post-2");
  });

  it("ignores malformed JSON in messages", async () => {
    const { result } = renderHook(() => useSSE());
    await waitFor(() => expect(result.current.connected).toBe(true));

    act(() => {
      emitMessage(instances[0], "not-valid-json{{{");
    });

    // Should not crash, lastEvent stays null
    expect(result.current.lastEvent).toBeNull();
  });
});

/**
 * Ledger 5.5e-iii: the anchor has to survive the reconnect `useSSE()` performs
 * itself.
 *
 * `EventSource` sends `Last-Event-ID` only when it reconnects the object it
 * already owns. `useSSE()` never lets that happen: `onerror` closes the source
 * and a timer constructs a brand new one, whose own id buffer starts empty. So
 * the hook has to carry the id across the gap, and the only place a new
 * `EventSource` can carry anything is its URL.
 */
describe("useSSE replay anchor", () => {
  const ANCHOR_A = "1755859200000-11111111-2222-3333-4444-555555555555";
  const ANCHOR_B = "1755859200500-66666666-7777-8888-9999-aaaaaaaaaaaa";
  const ANCHOR_C = "1755859201000-bbbbbbbb-cccc-dddd-eeee-ffffffffffff";
  const GLOBAL_URL = "http://localhost:8055/api/events";

  /**
   * Lets the mock's open-on-next-microtask fire inside `act()`, so the
   * `setConnected(true)` it triggers does not warn.
   */
  async function settle() {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
  }

  /** Errors the live source, then lets the 3000ms reconnect timer fire. */
  async function reconnect() {
    act(() => {
      triggerError(instances[instances.length - 1]);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3100);
    });
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("opens the first connection with no anchor, because it has missed nothing", async () => {
    renderHook(() => useSSE());
    await settle();

    expect(instances[0].url).toBe(GLOBAL_URL);
  });

  it("puts the last delivered event's id on the URL of the next EventSource", async () => {
    renderHook(() => useSSE());
    await settle();

    act(() => {
      emitMessage(instances[0], { event: "log", post_id: "p1" }, ANCHOR_A);
    });
    await reconnect();

    expect(instances[1].url).toBe(
      `${GLOBAL_URL}?last_event_id=${encodeURIComponent(ANCHOR_A)}`
    );
  });

  it("takes the anchor from a named event too, not only from an unnamed one", async () => {
    renderHook(() => useSSE("post-123"));
    await settle();

    act(() => {
      emitNamedEvent(
        instances[0],
        "stage_complete",
        { post_id: "post-123", stage: "outline" },
        ANCHOR_B
      );
    });
    await reconnect();

    expect(instances[1].url).toBe(
      `http://localhost:8055/api/events/post-123?last_event_id=${encodeURIComponent(ANCHOR_B)}`
    );
  });

  it("advances the anchor rather than accumulating parameters across two reconnects", async () => {
    renderHook(() => useSSE());
    await settle();

    act(() => {
      emitMessage(instances[0], { event: "log" }, ANCHOR_A);
    });
    await reconnect();
    act(() => {
      emitMessage(instances[1], { event: "log" }, ANCHOR_C);
    });
    await reconnect();

    expect(instances[2].url).toBe(
      `${GLOBAL_URL}?last_event_id=${encodeURIComponent(ANCHOR_C)}`
    );
  });

  it("keeps the previous anchor when a frame arrives without an id", async () => {
    renderHook(() => useSSE());
    await settle();

    act(() => {
      emitMessage(instances[0], { event: "log" }, ANCHOR_A);
      emitMessage(instances[0], { event: "log" }, "");
    });
    await reconnect();

    expect(instances[1].url).toBe(
      `${GLOBAL_URL}?last_event_id=${encodeURIComponent(ANCHOR_A)}`
    );
  });

  it("advances the anchor on a frame whose data does not parse, as the browser's own buffer does", async () => {
    renderHook(() => useSSE());
    await settle();

    act(() => {
      emitMessage(instances[0], { event: "log" }, ANCHOR_A);
      emitMessage(instances[0], "not-valid-json{{{", ANCHOR_C);
    });
    await reconnect();

    expect(instances[1].url).toBe(
      `${GLOBAL_URL}?last_event_id=${encodeURIComponent(ANCHOR_C)}`
    );
  });

  it("does not carry an anchor across a postId change, which is a different feed", async () => {
    const { rerender } = renderHook(({ id }) => useSSE(id), {
      initialProps: { id: "post-1" as string | undefined },
    });
    await settle();

    act(() => {
      emitMessage(instances[0], { event: "log", post_id: "post-1" }, ANCHOR_A);
    });
    rerender({ id: "post-2" });
    await settle();

    expect(instances[instances.length - 1].url).toBe(
      "http://localhost:8055/api/events/post-2"
    );
  });
});
