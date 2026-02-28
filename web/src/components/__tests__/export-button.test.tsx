import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, fireEvent } from "@testing-library/react";
import { renderWithProviders } from "@/test/render";
import { ExportButton } from "../export-button";

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    posts: {
      ...actual.posts,
      exportMarkdown: (id: string) => `http://localhost:8000/api/posts/${id}/export/markdown`,
      exportHtml: (id: string) => `http://localhost:8000/api/posts/${id}/export/html`,
      exportAll: (id: string) => `http://localhost:8000/api/posts/${id}/export/all`,
    },
  };
});

// Mock shadcn dropdown so onClick fires reliably in jsdom
// (Radix pointer-event handling doesn't work in jsdom)
vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DropdownMenuItem: ({
    children,
    onClick,
    asChild,
  }: {
    children: React.ReactNode;
    onClick?: () => void;
    asChild?: boolean;
  }) => {
    if (asChild) return <>{children}</>;
    return <div onClick={onClick}>{children}</div>;
  },
}));

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

const { toast } = await import("sonner");

const mockWriteText = vi.fn().mockResolvedValue(undefined);

// Set up clipboard mock before tests
Object.defineProperty(globalThis.navigator, "clipboard", {
  value: { writeText: mockWriteText },
  writable: true,
  configurable: true,
});

describe("ExportButton", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWriteText.mockResolvedValue(undefined);
  });

  it("renders nothing when no content available", () => {
    const { container } = renderWithProviders(
      <ExportButton postId="1" hasMd={false} hasHtml={false} />
    );
    expect(container.innerHTML).toBe("");
  });

  it("renders export button when markdown is available", () => {
    renderWithProviders(
      <ExportButton postId="1" hasMd={true} hasHtml={false} />
    );
    expect(screen.getByTestId("export-button")).toBeInTheDocument();
  });

  it("shows markdown options in dropdown", () => {
    renderWithProviders(
      <ExportButton
        postId="1"
        hasMd={true}
        hasHtml={false}
        mdContent="# Hello"
      />
    );

    expect(screen.getByText("Copy Markdown")).toBeInTheDocument();
    expect(screen.getByText("Download .mdx")).toBeInTheDocument();
  });

  it("shows HTML options when HTML is available", () => {
    renderWithProviders(
      <ExportButton
        postId="1"
        hasMd={true}
        hasHtml={true}
        mdContent="# Hello"
        htmlContent="<p>Hello</p>"
      />
    );

    expect(screen.getByText("Copy HTML")).toBeInTheDocument();
    expect(screen.getByText("Download .html")).toBeInTheDocument();
  });

  it("always shows Download ZIP option", () => {
    renderWithProviders(
      <ExportButton postId="1" hasMd={true} hasHtml={false} />
    );

    expect(screen.getByText("Download ZIP")).toBeInTheDocument();
  });

  it("copies markdown to clipboard", () => {
    renderWithProviders(
      <ExportButton
        postId="1"
        hasMd={true}
        hasHtml={false}
        mdContent="# Hello World"
      />
    );

    fireEvent.click(screen.getByText("Copy Markdown"));

    expect(mockWriteText).toHaveBeenCalledWith("# Hello World");
    expect(toast.success).toHaveBeenCalledWith("Markdown copied to clipboard");
  });

  it("copies HTML to clipboard", () => {
    renderWithProviders(
      <ExportButton
        postId="1"
        hasMd={false}
        hasHtml={true}
        htmlContent="<p>Hello</p>"
      />
    );

    fireEvent.click(screen.getByText("Copy HTML"));

    expect(mockWriteText).toHaveBeenCalledWith("<p>Hello</p>");
    expect(toast.success).toHaveBeenCalledWith("HTML copied to clipboard");
  });

  it("has correct download link for markdown", () => {
    renderWithProviders(
      <ExportButton postId="test-123" hasMd={true} hasHtml={false} />
    );

    const link = screen.getByText("Download .mdx").closest("a");
    expect(link).toHaveAttribute(
      "href",
      "http://localhost:8000/api/posts/test-123/export/markdown"
    );
  });
});
