import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";

import { renderWithProviders } from "@/test/render";
import { DebugLogPanel } from "../debug-log-panel";

describe("DebugLogPanel", () => {
  it("keeps diagnostic lines collapsed by default", () => {
    renderWithProviders(
      <DebugLogPanel
        isRunning={false}
        logs={[
          {
            event: "stage_error",
            stage: "research",
            level: "error",
            message: "Rule file not found",
          },
        ]}
      />
    );

    expect(screen.getByRole("button", { name: /debug logs/i })).toHaveAttribute(
      "aria-expanded",
      "false"
    );
    expect(screen.queryByText("Rule file not found")).not.toBeInTheDocument();
  });
});
