import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import SettingsPage from "./page";
import { renderWithProviders } from "@/test/render";

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    apiKeys: {
      get: vi.fn(),
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

const { apiKeys, rules } = await import("@/lib/api");
const { toast } = await import("sonner");
const mockApiKeysGet = vi.mocked(apiKeys.get);
const mockApiKeysUpdate = vi.mocked(apiKeys.update);
const mockRulesList = vi.mocked(rules.list);
const mockRulesGet = vi.mocked(rules.get);
const mockRulesUpdate = vi.mocked(rules.update);

const testKeyStatuses = {
  anthropic: { provider: "anthropic", configured: true, source: "db" as const, hint: "...ab12", valid: null },
  perplexity: { provider: "perplexity", configured: false, source: "none" as const, hint: "", valid: null },
  gemini: { provider: "gemini", configured: true, source: "db" as const, hint: "...xyz9", valid: true },
};

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
  mockApiKeysGet.mockResolvedValue(testKeyStatuses);
  mockRulesList.mockResolvedValue(testRuleFiles);
  mockRulesGet.mockResolvedValue({ name: "blog-research", content: "# Research Rules\nContent here" });
});

describe("SettingsPage", () => {
  it("renders settings heading", async () => {
    renderWithProviders(<SettingsPage />);
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Settings" })).toBeInTheDocument();
      expect(screen.getByText("API keys and rule file editor")).toBeInTheDocument();
    });
  });

  it("calls apiKeys.get on mount", async () => {
    renderWithProviders(<SettingsPage />);
    await waitFor(() => {
      expect(mockApiKeysGet).toHaveBeenCalled();
    });
  });

  it("shows configured status for anthropic", async () => {
    renderWithProviders(<SettingsPage />);
    await waitFor(() => {
      expect(screen.getByText("Configured")).toBeInTheDocument();
    });
  });

  it("shows not configured for perplexity", async () => {
    renderWithProviders(<SettingsPage />);
    await waitFor(() => {
      expect(screen.getByText("Not configured")).toBeInTheDocument();
    });
  });

  it("shows valid badge for gemini", async () => {
    renderWithProviders(<SettingsPage />);
    await waitFor(() => {
      expect(screen.getByText("Valid")).toBeInTheDocument();
    });
  });

  it("validates format on blur", async () => {
    const user = userEvent.setup();
    renderWithProviders(<SettingsPage />);
    await waitFor(() => {
      expect(screen.getByLabelText("Anthropic")).toBeInTheDocument();
    });

    const input = screen.getByLabelText("Anthropic");
    await user.type(input, "bad-key");
    await user.tab();

    await waitFor(() => {
      expect(screen.getByText("Expected prefix: sk-ant-")).toBeInTheDocument();
    });
  });

  it("save calls apiKeys.update", async () => {
    const user = userEvent.setup();
    mockApiKeysUpdate.mockResolvedValue({
      anthropic: { provider: "anthropic", configured: true, source: "db" as const, hint: "...newk", valid: true },
      perplexity: { provider: "perplexity", configured: false, source: "none" as const, hint: "", valid: null },
      gemini: { provider: "gemini", configured: true, source: "db" as const, hint: "...xyz9", valid: true },
    });

    renderWithProviders(<SettingsPage />);
    await waitFor(() => {
      expect(screen.getByLabelText("Anthropic")).toBeInTheDocument();
    });

    await user.type(screen.getByLabelText("Anthropic"), "sk-ant-test1234");
    await user.click(screen.getByText("Save & Validate"));

    await waitFor(() => {
      expect(mockApiKeysUpdate).toHaveBeenCalledWith({ anthropic: "sk-ant-test1234" });
      expect(toast.success).toHaveBeenCalledWith("API keys saved and validated");
    });
  });

  it("shows validation failure toast", async () => {
    const user = userEvent.setup();
    mockApiKeysUpdate.mockResolvedValue({
      anthropic: { provider: "anthropic", configured: true, source: "db" as const, hint: "...newk", valid: false },
      perplexity: { provider: "perplexity", configured: false, source: "none" as const, hint: "", valid: null },
      gemini: { provider: "gemini", configured: true, source: "db" as const, hint: "...xyz9", valid: true },
    });

    renderWithProviders(<SettingsPage />);
    await waitFor(() => {
      expect(screen.getByLabelText("Anthropic")).toBeInTheDocument();
    });

    await user.type(screen.getByLabelText("Anthropic"), "sk-ant-badkey123");
    await user.click(screen.getByText("Save & Validate"));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith("Some keys failed validation — check status badges");
    });
  });

  it("calls rules.list on mount", async () => {
    renderWithProviders(<SettingsPage />);
    await waitFor(() => {
      expect(mockRulesList).toHaveBeenCalled();
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
