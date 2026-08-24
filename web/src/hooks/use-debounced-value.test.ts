import { describe, it, expect, vi, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useDebouncedValue } from "./use-debounced-value";

afterEach(() => {
  vi.useRealTimers();
});

describe("useDebouncedValue", () => {
  it("returns the first value without waiting", () => {
    const { result } = renderHook(() => useDebouncedValue("bread", 300));
    expect(result.current).toBe("bread");
  });

  it("holds a change back until the delay has passed", () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(
      ({ value }) => useDebouncedValue(value, 300),
      { initialProps: { value: "" } }
    );

    rerender({ value: "b" });
    expect(result.current).toBe("");

    act(() => {
      vi.advanceTimersByTime(299);
    });
    expect(result.current).toBe("");

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current).toBe("b");
  });

  it("settles once on the last of a run of changes", () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(
      ({ value }) => useDebouncedValue(value, 300),
      { initialProps: { value: "" } }
    );

    for (const value of ["b", "br", "bre", "brea", "bread"]) {
      rerender({ value });
      act(() => {
        vi.advanceTimersByTime(50);
      });
    }

    // Past the delay the first keystroke asked for, and still nothing: each
    // change cancels the one before it rather than queueing behind it.
    act(() => {
      vi.advanceTimersByTime(60);
    });
    expect(result.current).toBe("");

    act(() => {
      vi.advanceTimersByTime(240);
    });
    expect(result.current).toBe("bread");
  });

  it("settles on a value that returns to the one already shown", () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(
      ({ value }) => useDebouncedValue(value, 300),
      { initialProps: { value: "bread" } }
    );

    rerender({ value: "brea" });
    act(() => {
      vi.advanceTimersByTime(50);
    });
    rerender({ value: "bread" });
    act(() => {
      vi.advanceTimersByTime(300);
    });

    expect(result.current).toBe("bread");
  });

  it("drops a pending change when the hook unmounts", () => {
    vi.useFakeTimers();
    const { result, rerender, unmount } = renderHook(
      ({ value }) => useDebouncedValue(value, 300),
      { initialProps: { value: "" } }
    );

    rerender({ value: "b" });
    unmount();

    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(result.current).toBe("");
  });
});
