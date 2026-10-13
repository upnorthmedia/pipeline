import { describe, it, expect } from "vitest";
import { renderHook } from "@testing-library/react";
import { useLatestRequest } from "./use-latest-request";

describe("useLatestRequest", () => {
  it("calls the only request in flight the newest one", () => {
    const { result } = renderHook(() => useLatestRequest());
    const isCurrent = result.current();
    expect(isCurrent()).toBe(true);
  });

  it("invalidates a request once a later one starts", () => {
    const { result } = renderHook(() => useLatestRequest());
    const first = result.current();
    const second = result.current();

    expect(first()).toBe(false);
    expect(second()).toBe(true);
  });

  it("keeps the sequence across renders", () => {
    const { result, rerender } = renderHook(() => useLatestRequest());
    const first = result.current();
    rerender();
    const second = result.current();

    expect(first()).toBe(false);
    expect(second()).toBe(true);
  });

  it("sequences each hook instance on its own", () => {
    const a = renderHook(() => useLatestRequest());
    const b = renderHook(() => useLatestRequest());

    const aRequest = a.result.current();
    b.result.current();

    expect(aRequest()).toBe(true);
  });
});
