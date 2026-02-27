import { describe, it, expect, vi } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithProviders } from "@/test/render";
import { ContentPreview } from "../content-preview";

vi.mock("react-markdown", () => ({
  __esModule: true,
  default: ({ children }: { children: string }) => (
    <div data-testid="react-markdown">{children}</div>
  ),
}));

vi.mock("remark-gfm", () => ({
  __esModule: true,
  default: () => {},
}));

describe("ContentPreview", () => {
  it("renders markdown content", () => {
    renderWithProviders(<ContentPreview content="# Hello World" />);
    expect(screen.getByTestId("content-preview")).toBeInTheDocument();
    expect(screen.getByText("# Hello World")).toBeInTheDocument();
  });

  it("shows empty state when content is empty", () => {
    renderWithProviders(<ContentPreview content="" />);
    expect(screen.getByText("No content to preview")).toBeInTheDocument();
  });

  it("updates when content prop changes", () => {
    const { rerender } = renderWithProviders(
      <ContentPreview content="First content" />
    );
    expect(screen.getByText("First content")).toBeInTheDocument();

    rerender(<ContentPreview content="Updated content" />);
    expect(screen.getByText("Updated content")).toBeInTheDocument();
  });

  it("renders with custom height", () => {
    renderWithProviders(
      <ContentPreview content="Content" height="300px" />
    );
    expect(screen.getByTestId("content-preview")).toBeInTheDocument();
  });

  it("applies custom className", () => {
    renderWithProviders(
      <ContentPreview content="Content" className="custom-class" />
    );
    expect(screen.getByTestId("content-preview")).toHaveClass("custom-class");
  });
});
