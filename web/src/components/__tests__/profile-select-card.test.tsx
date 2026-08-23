import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ProfileSelectCard } from "@/components/profile-select-card";
import { renderWithProviders } from "@/test/render";
import { makeProfile } from "@/test/fixtures";

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    profiles: { list: vi.fn() },
  };
});

const { profiles } = await import("@/lib/api");
const mockList = vi.mocked(profiles.list);

const firearms = makeProfile({ id: "prof-1", name: "Firearms Blog" });

function renderCard(onSelect = vi.fn()) {
  renderWithProviders(
    <ProfileSelectCard
      description="Select a profile to auto-fill default settings"
      selected={null}
      onSelect={onSelect}
    />
  );
  return onSelect;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockList.mockResolvedValue([firearms]);
});

describe("ProfileSelectCard", () => {
  it("shows a skeleton while the profiles are in flight", () => {
    mockList.mockReturnValue(new Promise(() => {}));
    renderCard();

    expect(screen.getByTestId("profile-select-loading")).toBeInTheDocument();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  });

  it("shows the select once the profiles arrive", async () => {
    renderCard();

    expect(await screen.findByRole("combobox")).toHaveTextContent("No profile");
    expect(
      screen.queryByTestId("profile-select-loading")
    ).not.toBeInTheDocument();
  });

  it("hands the picked profile back to the page", async () => {
    const user = userEvent.setup();
    const onSelect = renderCard();

    await user.click(await screen.findByRole("combobox"));
    await user.click(await screen.findByRole("option", { name: "Firearms Blog" }));

    expect(onSelect).toHaveBeenCalledWith(firearms);
  });

  it("points at profile creation when the account has none", async () => {
    mockList.mockResolvedValue([]);
    renderCard();

    expect(await screen.findByText("No profiles yet")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Create a profile" })).toHaveAttribute(
      "href",
      "/profiles"
    );
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  });

  it("shows the server's own message and retries on demand", async () => {
    const user = userEvent.setup();
    mockList.mockRejectedValueOnce(
      new Error(JSON.stringify({ detail: "Profiles table is missing" }))
    );
    renderCard();

    expect(await screen.findByText("Profiles table is missing")).toBeInTheDocument();
    expect(screen.getByText("Could not load profiles")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Retry/ }));

    await waitFor(() => expect(mockList).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole("combobox")).toBeInTheDocument();
    expect(screen.queryByText("Could not load profiles")).not.toBeInTheDocument();
  });

  it("falls back to its own wording when the failure carries no message", async () => {
    mockList.mockRejectedValue(new Error(""));
    renderCard();

    expect(
      await screen.findByText("The request failed and the server gave no reason.")
    ).toBeInTheDocument();
  });
});
