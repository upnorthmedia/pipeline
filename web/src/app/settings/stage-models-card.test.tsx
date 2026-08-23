import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { StageModelsCard } from "./stage-models-card";
import { renderWithProviders } from "@/test/render";
import type { PipelineStage, StageModelRow, StageModels } from "@/lib/api";

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    stageModels: {
      get: vi.fn(),
      update: vi.fn(),
    },
  };
});

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

const { stageModels } = await import("@/lib/api");
const { toast } = await import("sonner");
const mockGet = vi.mocked(stageModels.get);
const mockUpdate = vi.mocked(stageModels.update);

const CLAUDE_MODELS = ["claude-opus-5", "claude-fable-5", "claude-opus-4-6"];
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];

/** The response for a stage nobody has configured. */
function claudeStage(
  stage: PipelineStage,
  overrides: Partial<StageModelRow> = {}
): StageModelRow {
  return {
    stage,
    provider: "anthropic",
    model: "claude-opus-5",
    effort: "high",
    model_source: "default",
    effort_source: "default",
    models: CLAUDE_MODELS,
    efforts: EFFORTS,
    fallback_model: "claude-opus-5",
    fallback_effort: "high",
    ...overrides,
  };
}

function payload(overrides: Partial<StageModels> = {}): StageModels {
  return {
    stages: [
      {
        stage: "research",
        provider: "perplexity",
        model: "sonar-pro",
        effort: null,
        model_source: "default",
        effort_source: "default",
        models: ["sonar-pro"],
        efforts: [],
        fallback_model: "sonar-pro",
        fallback_effort: null,
      },
      claudeStage("write"),
    ],
    overrides: {},
    ...overrides,
  } as StageModels;
}

/** The card that holds one stage's controls, found through its heading. */
function stageCard(stage: string) {
  return screen.getByLabelText(`${stage} model`).closest("div.rounded-md") as HTMLElement;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGet.mockResolvedValue(payload());
});

describe("StageModelsCard loading and error states", () => {
  it("shows a skeleton while loading, not an empty card", async () => {
    let resolve: (value: StageModels) => void = () => {};
    mockGet.mockReturnValue(new Promise((r) => (resolve = r)));

    renderWithProviders(<StageModelsCard />);

    expect(screen.getByTestId("stage-models-loading")).toBeInTheDocument();
    resolve(payload());
    await waitFor(() =>
      expect(screen.queryByTestId("stage-models-loading")).not.toBeInTheDocument()
    );
  });

  it("surfaces the server's own message on a failed load, with a retry", async () => {
    mockGet.mockRejectedValueOnce(new Error(JSON.stringify({ detail: "Not authenticated" })));

    renderWithProviders(<StageModelsCard />);

    await screen.findByText("Not authenticated");

    mockGet.mockResolvedValueOnce(payload());
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() => expect(screen.getByLabelText("write model")).toBeInTheDocument());
  });
});

describe("StageModelsCard table", () => {
  it("lists every stage with its effective model and provider", async () => {
    renderWithProviders(<StageModelsCard />);

    await waitFor(() => expect(screen.getByText("research")).toBeInTheDocument());
    expect(within(stageCard("research")).getByText("perplexity")).toBeInTheDocument();
    expect(screen.getByLabelText("research model")).toHaveTextContent("sonar-pro");
    expect(screen.getByLabelText("write model")).toHaveTextContent("claude-opus-5");
    expect(screen.getByLabelText("write effort")).toHaveTextContent("high");
  });

  it("offers no effort control for a provider that has none", async () => {
    renderWithProviders(<StageModelsCard />);

    await waitFor(() => expect(screen.getByLabelText("write effort")).toBeInTheDocument());
    expect(screen.queryByLabelText("research effort")).not.toBeInTheDocument();
    expect(within(stageCard("research")).getByText("no effort setting")).toBeInTheDocument();
  });

  it("badges a stage by where its effective value came from", async () => {
    mockGet.mockResolvedValue(
      payload({
        stages: [
          claudeStage("write", { model_source: "user", model: "claude-fable-5" }),
          claudeStage("edit", { effort_source: "global", effort: "low" }),
          claudeStage("ready"),
        ],
      } as Partial<StageModels>)
    );

    renderWithProviders(<StageModelsCard />);

    await waitFor(() => expect(screen.getByLabelText("write model")).toBeInTheDocument());
    expect(within(stageCard("write")).getByText("Override")).toBeInTheDocument();
    expect(within(stageCard("edit")).getByText("Global")).toBeInTheDocument();
    expect(within(stageCard("ready")).getByText("Default")).toBeInTheDocument();
  });
});

describe("StageModelsCard saving", () => {
  it("keeps Save disabled until a selection changes, then writes the whole map", async () => {
    mockGet.mockResolvedValue(
      payload({ overrides: { edit: { effort: "max" } } } as Partial<StageModels>)
    );
    mockUpdate.mockResolvedValue(
      payload({ stages: [claudeStage("write", { model_source: "user", model: "claude-fable-5" })] })
    );

    renderWithProviders(<StageModelsCard />);
    await waitFor(() => expect(screen.getByLabelText("write model")).toBeInTheDocument());

    const save = within(stageCard("write")).getByRole("button", { name: /Save/ });
    expect(save).toBeDisabled();

    await userEvent.click(screen.getByLabelText("write model"));
    await userEvent.click(await screen.findByRole("option", { name: "claude-fable-5" }));

    expect(save).toBeEnabled();
    await userEvent.click(save);

    // The setting is one row value, so another stage's override has to survive
    // a write that only touches `write`.
    await waitFor(() =>
      expect(mockUpdate).toHaveBeenCalledWith({
        edit: { effort: "max" },
        write: { model: "claude-fable-5", effort: "high" },
      })
    );
    expect(toast.success).toHaveBeenCalledWith("write model saved");
  });

  it("omits effort from the write for a provider that has none", async () => {
    mockGet.mockResolvedValue(
      payload({
        stages: [
          {
            stage: "images",
            provider: "gemini",
            model: "gemini-3-pro-image",
            effort: null,
            model_source: "default",
            effort_source: "default",
            models: ["gemini-3-pro-image", "gemini-3.1-flash-image-preview"],
            efforts: [],
            fallback_model: "gemini-3-pro-image",
            fallback_effort: null,
          },
        ],
      } as Partial<StageModels>)
    );
    mockUpdate.mockResolvedValue(payload());

    renderWithProviders(<StageModelsCard />);
    await waitFor(() => expect(screen.getByLabelText("images model")).toBeInTheDocument());

    await userEvent.click(screen.getByLabelText("images model"));
    await userEvent.click(
      await screen.findByRole("option", { name: "gemini-3.1-flash-image-preview" })
    );
    await userEvent.click(within(stageCard("images")).getByRole("button", { name: /Save/ }));

    // An `effort` on a provider with no such parameter is a 422 from the
    // route, so the client must not send a null placeholder either.
    await waitFor(() =>
      expect(mockUpdate).toHaveBeenCalledWith({
        images: { model: "gemini-3.1-flash-image-preview" },
      })
    );
  });

  it("shows the server's rejection against the row it belongs to", async () => {
    mockUpdate.mockRejectedValue(
      new Error(
        JSON.stringify({
          detail: "Invalid model 'claude-fable-5' for stage 'write'. Verified values are claude-opus-5",
        })
      )
    );

    renderWithProviders(<StageModelsCard />);
    await waitFor(() => expect(screen.getByLabelText("write model")).toBeInTheDocument());

    await userEvent.click(screen.getByLabelText("write model"));
    await userEvent.click(await screen.findByRole("option", { name: "claude-fable-5" }));
    await userEvent.click(within(stageCard("write")).getByRole("button", { name: /Save/ }));

    const message =
      "Invalid model 'claude-fable-5' for stage 'write'. Verified values are claude-opus-5";
    await waitFor(() =>
      expect(within(stageCard("write")).getByText(message)).toBeInTheDocument()
    );
    expect(toast.error).toHaveBeenCalledWith(message);
  });
});

describe("StageModelsCard reverting", () => {
  it("disables Revert on a stage with no override of its own", async () => {
    renderWithProviders(<StageModelsCard />);

    await waitFor(() => expect(screen.getByLabelText("write model")).toBeInTheDocument());
    expect(screen.getByLabelText("Revert write to default")).toBeDisabled();
  });

  it("drops the stage from the map rather than writing the fallback back", async () => {
    mockGet.mockResolvedValue(
      payload({
        stages: [
          claudeStage("write", {
            model: "claude-fable-5",
            model_source: "user",
            fallback_model: "claude-opus-4-6",
            fallback_effort: "low",
          }),
        ],
        overrides: { write: { model: "claude-fable-5" }, edit: { effort: "max" } },
      } as Partial<StageModels>)
    );
    mockUpdate.mockResolvedValue(payload({ stages: [claudeStage("write")] }));

    renderWithProviders(<StageModelsCard />);
    await waitFor(() => expect(screen.getByLabelText("write model")).toBeInTheDocument());

    expect(screen.getByText("Reverts to claude-opus-4-6 / low")).toBeInTheDocument();
    await userEvent.click(screen.getByLabelText("Revert write to default"));

    await waitFor(() => expect(mockUpdate).toHaveBeenCalledWith({ edit: { effort: "max" } }));
    expect(toast.success).toHaveBeenCalledWith("write reverted to default");
  });
});
