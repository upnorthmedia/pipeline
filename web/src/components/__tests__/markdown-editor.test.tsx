import { describe, it, expect, vi, afterEach } from "vitest";
import { screen, act } from "@testing-library/react";
import { renderWithProviders } from "@/test/render";
import { MarkdownEditor } from "../markdown-editor";

let mockOnChange: ((value: string) => void) | undefined;

vi.mock("@uiw/react-codemirror", () => ({
  __esModule: true,
  default: ({
    value,
    onChange,
    readOnly,
  }: {
    value: string;
    onChange?: (v: string) => void;
    readOnly?: boolean;
  }) => {
    mockOnChange = onChange;
    return (
      <textarea
        data-testid="codemirror-mock"
        defaultValue={value}
        readOnly={readOnly}
      />
    );
  },
}));

describe("MarkdownEditor", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    mockOnChange = undefined;
  });

  it("renders with content", () => {
    renderWithProviders(<MarkdownEditor content="# Hello" />);
    expect(screen.getByTestId("markdown-editor")).toBeInTheDocument();
    expect(screen.getByTestId("codemirror-mock")).toHaveValue("# Hello");
  });

  it("calls onChange when content changes", () => {
    const onChange = vi.fn();
    renderWithProviders(<MarkdownEditor content="" onChange={onChange} />);

    act(() => {
      mockOnChange?.("new text");
    });

    expect(onChange).toHaveBeenCalledWith("new text");
  });

  it("triggers auto-save after debounce delay", () => {
    vi.useFakeTimers();
    const onSave = vi.fn();
    const onChange = vi.fn();

    renderWithProviders(
      <MarkdownEditor
        content=""
        onChange={onChange}
        onSave={onSave}
        autoSaveMs={1500}
      />
    );

    act(() => {
      mockOnChange?.("updated content");
    });

    // Before debounce completes
    expect(onSave).not.toHaveBeenCalled();

    // Advance past debounce
    act(() => {
      vi.advanceTimersByTime(1600);
    });

    expect(onSave).toHaveBeenCalledWith("updated content");
    vi.useRealTimers();
  });

  it("resets debounce timer on rapid changes", () => {
    vi.useFakeTimers();
    const onSave = vi.fn();

    renderWithProviders(
      <MarkdownEditor
        content=""
        onChange={vi.fn()}
        onSave={onSave}
        autoSaveMs={1500}
      />
    );

    act(() => {
      mockOnChange?.("first");
    });
    act(() => {
      vi.advanceTimersByTime(1000);
    });

    // Type again before debounce fires
    act(() => {
      mockOnChange?.("second");
    });
    act(() => {
      vi.advanceTimersByTime(1000);
    });

    // Still hasn't fired (reset by second change)
    expect(onSave).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(600);
    });

    // Now it fires with the latest value
    expect(onSave).toHaveBeenCalledWith("second");
    expect(onSave).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("does not auto-save when autoSaveMs is 0", () => {
    vi.useFakeTimers();
    const onSave = vi.fn();

    renderWithProviders(
      <MarkdownEditor
        content=""
        onChange={vi.fn()}
        onSave={onSave}
        autoSaveMs={0}
      />
    );

    act(() => {
      mockOnChange?.("test");
    });

    act(() => {
      vi.advanceTimersByTime(5000);
    });

    expect(onSave).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("renders in read-only mode", () => {
    renderWithProviders(<MarkdownEditor content="# Read Only" readOnly />);
    expect(screen.getByTestId("codemirror-mock")).toHaveAttribute("readonly");
  });
});
