import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import SettingsPage from "./page";
import { renderWithProviders } from "@/test/render";

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    settings: {
      list: vi.fn(),
      update: vi.fn(),
    },
    rules: {
      list: vi.fn(),
      get: vi.fn(),
      update: vi.fn(),
    },
  };
});

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
}));

const { settings, rules } = await import("@/lib/api");
const { toast } = await import("sonner");
const mockSettingsList = vi.mocked(settings.list);
const mockSettingsUpdate = vi.mocked(settings.update);
const mockRulesList = vi.mocked(rules.list);
const mockRulesGet = vi.mocked(rules.get);
const mockRulesUpdate = vi.mocked(rules.update);

const testSettings = [
  { key: "worker_max_jobs", value: { max_jobs: 5 }, updated_at: "2025-01-01T00:00:00Z" },
];

const testRuleFiles = [
  { name: "blog-research", filename: "blog-research.md", exists: true, size: 1024 },
  { name: "blog-outline", filename: "blog-outline.md", exists: true, size: 2048 },
  { name: "blog-write", filename: "blog-write.md", exists: true, size: 3072 },
  { name: "blog-edit", filename: "blog-edit.md", exists: true, size: 4096 },
  { name: "blog-images", filename: "blog-images.md", exists: false, size: 0 },
  { name: "blog-ready", filename: "blog-ready.md", exists: true, size: 512 },
];

beforeEach(() => {
  vi.clearAllMocks();
  mockSettingsList.mockResolvedValue(testSettings);
  mockRulesList.mockResolvedValue(testRuleFiles);
  mockRulesGet.mockResolvedValue({ name: "blog-research", content: "# Research Rules\nContent here" });
});

describe("SettingsPage", () => {
  it("renders settings heading", async () => {
    renderWithProviders(<SettingsPage />);
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Settings" })).toBeInTheDocument();
      expect(screen.getByText("Worker configuration and rule file editor")).toBeInTheDocument();
    });
  });

  it("calls settings.list on mount", async () => {
    renderWithProviders(<SettingsPage />);
    await waitFor(() => {
      expect(mockSettingsList).toHaveBeenCalled();
    });
  });

  it("calls rules.list on mount", async () => {
    renderWithProviders(<SettingsPage />);
    await waitFor(() => {
      expect(mockRulesList).toHaveBeenCalled();
    });
  });

  it("loads worker max_jobs", async () => {
    renderWithProviders(<SettingsPage />);
    await waitFor(() => {
      expect(screen.getByLabelText("Worker Concurrency")).toHaveValue(5);
    });
  });

  it("renders rule file tabs", async () => {
    renderWithProviders(<SettingsPage />);
    await waitFor(() => {
      expect(screen.getByText(/Save blog-research/)).toBeInTheDocument();
    });
    for (const name of ["blog-research", "blog-outline", "blog-write", "blog-edit", "blog-images", "blog-ready"]) {
      expect(screen.getByRole("button", { name: new RegExp(`^${name}`) })).toBeInTheDocument();
    }
  });

  it("loads rule content", async () => {
    renderWithProviders(<SettingsPage />);
    await waitFor(() => {
      expect(mockRulesGet).toHaveBeenCalledWith("blog-research");
    });
  });

  it("save rule calls rules.update", async () => {
    const user = userEvent.setup();
    mockRulesUpdate.mockResolvedValue({ name: "blog-research", content: "" } as Awaited<ReturnType<typeof rules.update>>);
    renderWithProviders(<SettingsPage />);
    await waitFor(() => {
      expect(screen.getByText(/Save blog-research/)).toBeInTheDocument();
    });

    await user.click(screen.getByText(/Save blog-research/));

    await waitFor(() => {
      expect(mockRulesUpdate).toHaveBeenCalledWith("blog-research", expect.any(String));
      expect(toast.success).toHaveBeenCalledWith('Rule file "blog-research" saved');
    });
  });
});
