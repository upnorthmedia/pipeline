import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { renderWithProviders } from "@/test/render";
import { OutputFormatSelect } from "@/components/output-format-select";

const ALL_AVAILABLE = {};

describe("OutputFormatSelect", () => {
  it("offers every format when every destination is configured", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <OutputFormatSelect value="markdown" onValueChange={vi.fn()} availability={ALL_AVAILABLE} />
    );

    await user.click(screen.getByRole("combobox", { name: "Output Format" }));

    for (const label of ["Markdown", "WordPress (Direct Publish)", "Next.js (Webhook)"]) {
      expect(await screen.findByRole("option", { name: label })).not.toHaveAttribute(
        "aria-disabled",
        "true"
      );
    }
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("disables a format whose destination is not configured", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <OutputFormatSelect
        value="markdown"
        onValueChange={vi.fn()}
        availability={{ wordpress: { available: false, reason: "No WordPress connection yet." } }}
      />
    );

    await user.click(screen.getByRole("combobox", { name: "Output Format" }));

    expect(await screen.findByRole("option", { name: /WordPress/ })).toHaveAttribute(
      "aria-disabled",
      "true"
    );
    expect(await screen.findByRole("option", { name: "Markdown" })).not.toHaveAttribute(
      "aria-disabled",
      "true"
    );
  });

  // A greyed row in a closed dropdown explains nothing, so the reason is on
  // the page whether or not the list is open.
  it("says why an unavailable format is unavailable without opening the list", () => {
    renderWithProviders(
      <OutputFormatSelect
        value="markdown"
        onValueChange={vi.fn()}
        availability={{ nextjs: { available: false, reason: "No webhook URL yet." } }}
      />
    );

    expect(
      screen.getByText("Next.js (Webhook): No webhook URL yet.")
    ).toBeInTheDocument();
  });

  // The stored value is not silently rewritten: a post created now would run
  // six stages and then fail to publish, so that is what it says.
  it("raises the selected format's own reason to an alert", () => {
    renderWithProviders(
      <OutputFormatSelect
        value="wordpress"
        onValueChange={vi.fn()}
        availability={{ wordpress: { available: false, reason: "No WordPress connection yet." } }}
      />
    );

    expect(screen.getByRole("alert")).toHaveTextContent(
      "WordPress (Direct Publish): No WordPress connection yet."
    );
  });

  it("keeps the trigger free of the explanation", async () => {
    renderWithProviders(
      <OutputFormatSelect
        value="wordpress"
        onValueChange={vi.fn()}
        availability={{ wordpress: { available: false, reason: "No WordPress connection yet." } }}
      />
    );

    expect(screen.getByRole("combobox", { name: "Output Format" })).toHaveTextContent(
      "WordPress (Direct Publish)"
    );
    expect(screen.getByRole("combobox", { name: "Output Format" })).not.toHaveTextContent(
      "No WordPress connection yet."
    );
  });
});

// `output_format` is a bare `varchar(20)` and the two route validators take it
// as `z.string()`, so a stored value the picker does not offer is reachable
// through the API, not only through hand-written SQL. Radix renders no trigger
// text at all for a value that matches no item, which is a picker that looks
// empty on a row that has a value.
describe("OutputFormatSelect with a stored value it does not offer", () => {
  it("names the trigger rather than leaving it blank", () => {
    renderWithProviders(
      <OutputFormatSelect value="both" onValueChange={vi.fn()} availability={ALL_AVAILABLE} />
    );

    expect(screen.getByRole("combobox", { name: "Output Format" })).toHaveTextContent(
      "Unrecognised format"
    );
  });

  it("says what is stored and what to do about it", () => {
    renderWithProviders(
      <OutputFormatSelect value="both" onValueChange={vi.fn()} availability={ALL_AVAILABLE} />
    );

    expect(screen.getByRole("alert")).toHaveTextContent(
      '"both" is not a format this app can produce. Pick one below and save.'
    );
  });

  it("leaves a format it does offer reading as itself", () => {
    renderWithProviders(
      <OutputFormatSelect value="nextjs" onValueChange={vi.fn()} availability={ALL_AVAILABLE} />
    );

    expect(screen.getByRole("combobox", { name: "Output Format" })).toHaveTextContent(
      "Next.js (Webhook)"
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
