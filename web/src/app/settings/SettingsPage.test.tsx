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
    stageModels: {
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

const { apiKeys, rules, stageModels } = await import("@/lib/api");
const { toast } = await import("sonner");
const mockApiKeysGet = vi.mocked(apiKeys.get);
const mockApiKeysUpdate = vi.mocked(apiKeys.update);
const mockRulesList = vi.mocked(rules.list);
const mockRulesGet = vi.mocked(rules.get);
const mockRulesUpdate = vi.mocked(rules.update);
const mockStageModelsGet = vi.mocked(stageModels.get);

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
  mockStageModelsGet.mockResolvedValue({ stages: [], overrides: {} });
});

describe("SettingsPage", () => {
  it("renders settings heading", async () => {
    renderWithProviders(<SettingsPage />);
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Settings" })).toBeInTheDocument();
      expect(
        screen.getByText("API keys, stage models, and rule file editor")
      ).toBeInTheDocument();
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

  // Was `shows validation failure toast`. The reason a save was rejected now
  // stays inline next to the keys that were pasted rather than expiring in a
  // toast, so the assertion moved with it.
  it("keeps a validation failure inline", async () => {
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
      expect(
        screen.getByText("Some keys failed validation, see the status badges")
      ).toBeInTheDocument();
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

describe("SettingsPage async states", () => {
  it("holds the server's message with a Retry when the key status load fails", async () => {
    mockApiKeysGet.mockRejectedValueOnce(
      new Error('{"detail":"connection to server at \\"db\\" failed"}')
    );
    renderWithProviders(<SettingsPage />);

    await waitFor(() => {
      expect(screen.getByText("Could not load API key status")).toBeInTheDocument();
    });
    expect(
      screen.getByText('connection to server at "db" failed')
    ).toBeInTheDocument();
    // The three inputs are what made a failed load look like an unconfigured
    // account, so they must not be on screen while the load is failing.
    expect(screen.queryByLabelText("Anthropic")).not.toBeInTheDocument();
  });

  it("falls back to its own wording when the key failure body carries no detail", async () => {
    mockApiKeysGet.mockRejectedValueOnce(new Error("Failed to fetch"));
    renderWithProviders(<SettingsPage />);

    await waitFor(() => {
      expect(
        screen.getByText("The request failed and the server gave no reason.")
      ).toBeInTheDocument();
    });
  });

  it("recovers the key statuses when Retry succeeds", async () => {
    const user = userEvent.setup();
    mockApiKeysGet.mockRejectedValueOnce(new Error('{"detail":"nope"}'));
    renderWithProviders(<SettingsPage />);

    await waitFor(() => {
      expect(screen.getByText("Could not load API key status")).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "Retry API keys" }));

    await waitFor(() => {
      expect(screen.getByLabelText("Anthropic")).toBeInTheDocument();
    });
    expect(screen.queryByText("Could not load API key status")).not.toBeInTheDocument();
  });

  it("names the providers a run needs when nothing is configured", async () => {
    mockApiKeysGet.mockResolvedValue({
      anthropic: { provider: "anthropic", configured: false, source: "none" as const, hint: "", valid: null },
      perplexity: { provider: "perplexity", configured: false, source: "none" as const, hint: "", valid: null },
      gemini: { provider: "gemini", configured: false, source: "none" as const, hint: "", valid: null },
    });
    renderWithProviders(<SettingsPage />);

    await waitFor(() => {
      expect(screen.getByText(/No provider keys are configured yet/)).toBeInTheDocument();
    });
    // The inputs are the action that fills the empty state, so they stay.
    expect(screen.getByLabelText("Anthropic")).toBeInTheDocument();
  });

  it("does not claim an empty account when at least one key is set", async () => {
    renderWithProviders(<SettingsPage />);
    await waitFor(() => {
      expect(screen.getByLabelText("Anthropic")).toBeInTheDocument();
    });
    expect(screen.queryByText(/No provider keys are configured yet/)).not.toBeInTheDocument();
  });

  it("keeps a rejected key save inline with the server's message", async () => {
    const user = userEvent.setup();
    mockApiKeysUpdate.mockRejectedValueOnce(
      new Error('{"detail":"anthropic: invalid key format"}')
    );
    renderWithProviders(<SettingsPage />);
    await waitFor(() => {
      expect(screen.getByLabelText("Anthropic")).toBeInTheDocument();
    });

    await user.type(screen.getByLabelText("Anthropic"), "sk-ant-test1234");
    await user.click(screen.getByText("Save & Validate"));

    await waitFor(() => {
      expect(screen.getByText("anthropic: invalid key format")).toBeInTheDocument();
    });
  });

  it("surfaces a failed reveal next to the key it belongs to", async () => {
    const user = userEvent.setup();
    vi.mocked(apiKeys).reveal = vi.fn().mockRejectedValue(
      new Error('{"detail":"decryption failed"}')
    );
    renderWithProviders(<SettingsPage />);
    await waitFor(() => {
      expect(screen.getByLabelText("Anthropic")).toBeInTheDocument();
    });

    await user.click(
      screen.getByRole("button", { name: "Toggle Anthropic key visibility" })
    );

    await waitFor(() => {
      expect(screen.getByText("decryption failed")).toBeInTheDocument();
    });
  });

  it("shows an error with a Retry when the rule content fails to load", async () => {
    mockRulesGet.mockRejectedValueOnce(new Error('{"detail":"rules directory missing"}'));
    renderWithProviders(<SettingsPage />);

    await waitFor(() => {
      expect(screen.getByText("Could not load blog-research")).toBeInTheDocument();
    });
    expect(screen.getByText("rules directory missing")).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: /blog-research/ })).not.toBeInTheDocument();
  });

  it("does not offer to save an empty editor over a rule file that failed to load", async () => {
    mockRulesGet.mockRejectedValueOnce(new Error('{"detail":"rules directory missing"}'));
    renderWithProviders(<SettingsPage />);

    await waitFor(() => {
      expect(screen.getByText("Could not load blog-research")).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: /Save blog-research/ })).toBeDisabled();
  });

  it("restores the editor when the rule Retry succeeds", async () => {
    const user = userEvent.setup();
    mockRulesGet.mockRejectedValueOnce(new Error('{"detail":"rules directory missing"}'));
    renderWithProviders(<SettingsPage />);

    await waitFor(() => {
      expect(screen.getByText("Could not load blog-research")).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "Retry blog-research" }));

    await waitFor(() => {
      expect(screen.getByDisplayValue(/# Research Rules/)).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: /Save blog-research/ })).toBeEnabled();
  });

  it("says a rule file does not exist yet rather than showing a blank editor", async () => {
    const user = userEvent.setup();
    mockRulesGet.mockResolvedValue({ name: "blog-images", content: "" });
    renderWithProviders(<SettingsPage />);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /^blog-images/ })).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: /^blog-images/ }));

    await waitFor(() => {
      expect(
        screen.getByText(/blog-images\.md does not exist yet/)
      ).toBeInTheDocument();
    });
  });

  it("keeps a rejected rule save inline with the server's message", async () => {
    const user = userEvent.setup();
    mockRulesUpdate.mockRejectedValueOnce(new Error('{"detail":"rules directory is read only"}'));
    renderWithProviders(<SettingsPage />);
    await waitFor(() => {
      expect(screen.getByText(/Save blog-research/)).toBeInTheDocument();
    });

    await user.click(screen.getByText(/Save blog-research/));

    await waitFor(() => {
      expect(screen.getByText("rules directory is read only")).toBeInTheDocument();
    });
  });

  it("says so when the rule file list cannot be checked, and offers a retry", async () => {
    const user = userEvent.setup();
    mockRulesList.mockRejectedValueOnce(new Error('{"detail":"rules directory missing"}'));
    renderWithProviders(<SettingsPage />);

    await waitFor(() => {
      expect(
        screen.getByText(/Could not check which rule files exist/)
      ).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: "Retry rule file list" }));

    await waitFor(() => {
      expect(
        screen.queryByText(/Could not check which rule files exist/)
      ).not.toBeInTheDocument();
    });
  });

  it("labels the rule editor rather than relying on its placeholder", async () => {
    renderWithProviders(<SettingsPage />);
    await waitFor(() => {
      expect(screen.getByLabelText("blog-research.md")).toBeInTheDocument();
    });
    expect(screen.getByLabelText("blog-research.md")).toHaveAttribute("name", "rule-content");
  });
});

describe("settings loading.tsx", () => {
  it("mirrors all three cards the page renders", async () => {
    const Loading = (await import("./loading")).default;
    const { container } = renderWithProviders(<Loading />);

    // One bordered block per card. It had two while the page had three, so the
    // route-transition skeleton stopped short of the stage models table.
    expect(container.querySelectorAll(".rounded-md.border")).toHaveLength(3);
    expect(
      container.querySelectorAll('[data-slot="skeleton"]').length
    ).toBeGreaterThan(20);
  });
});
