import { describe, it, expect } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithProviders } from "@/test/render";
import { makeAnalytics } from "@/test/fixtures";
import { AnalyticsBar, SeoChecklist, KeywordDensity } from "../analytics-bar";

describe("AnalyticsBar", () => {
  it("displays word count", () => {
    const analytics = makeAnalytics({ word_count: 2150 });
    renderWithProviders(<AnalyticsBar analytics={analytics} />);
    expect(screen.getByText("2,150")).toBeInTheDocument();
    expect(screen.getByText("Words")).toBeInTheDocument();
  });

  it("displays Flesch reading ease score", () => {
    const analytics = makeAnalytics({ flesch_reading_ease: 64.2 });
    renderWithProviders(<AnalyticsBar analytics={analytics} />);
    expect(screen.getByText("64.2")).toBeInTheDocument();
    expect(screen.getByText("Flesch Score")).toBeInTheDocument();
  });

  it("displays sentence count", () => {
    const analytics = makeAnalytics({ sentence_count: 108 });
    renderWithProviders(<AnalyticsBar analytics={analytics} />);
    expect(screen.getByText("108")).toBeInTheDocument();
  });

  it("displays average sentence length", () => {
    const analytics = makeAnalytics({ avg_sentence_length: 19.9 });
    renderWithProviders(<AnalyticsBar analytics={analytics} />);
    expect(screen.getByText("19.9 words")).toBeInTheDocument();
  });

  it("shows word count target from prop", () => {
    const analytics = makeAnalytics({ word_count: 500 });
    renderWithProviders(
      <AnalyticsBar analytics={analytics} targetWordCount={2000} />
    );
    expect(screen.getByText("target: 2,000")).toBeInTheDocument();
  });

  it("color-codes word count as pass when within 10% of target", () => {
    const analytics = makeAnalytics({ word_count: 2000 });
    renderWithProviders(
      <AnalyticsBar analytics={analytics} targetWordCount={2000} />
    );
    const wordCountValue = screen.getByText("2,000");
    expect(wordCountValue.className).toContain("emerald");
  });

  it("color-codes word count as warn when outside 10% of target", () => {
    const analytics = makeAnalytics({ word_count: 500 });
    renderWithProviders(
      <AnalyticsBar analytics={analytics} targetWordCount={2000} />
    );
    const wordCountValue = screen.getByText("500");
    expect(wordCountValue.className).toContain("amber");
  });

  it("color-codes Flesch score as pass when 60-70", () => {
    const analytics = makeAnalytics({ flesch_reading_ease: 65.0 });
    renderWithProviders(<AnalyticsBar analytics={analytics} />);
    const score = screen.getByText("65.0");
    expect(score.className).toContain("emerald");
  });

  it("color-codes Flesch score as warn when outside 60-70", () => {
    const analytics = makeAnalytics({ flesch_reading_ease: 45.0 });
    renderWithProviders(<AnalyticsBar analytics={analytics} />);
    const score = screen.getByText("45.0");
    expect(score.className).toContain("amber");
  });

  it("color-codes avg sentence length as pass when < 20", () => {
    const analytics = makeAnalytics({ avg_sentence_length: 15.0 });
    renderWithProviders(<AnalyticsBar analytics={analytics} />);
    const value = screen.getByText("15.0 words");
    expect(value.className).toContain("emerald");
  });

  it("color-codes avg sentence length as warn when >= 20", () => {
    const analytics = makeAnalytics({ avg_sentence_length: 22.0 });
    renderWithProviders(<AnalyticsBar analytics={analytics} />);
    const value = screen.getByText("22.0 words");
    expect(value.className).toContain("amber");
  });
});

describe("SeoChecklist", () => {
  it("renders checklist items with pass/fail indicators", () => {
    renderWithProviders(
      <SeoChecklist
        checklist={{
          title_contains_keyword: true,
          meta_description: false,
          h1_keyword: true,
        }}
      />
    );
    expect(screen.getByText("SEO Checklist")).toBeInTheDocument();
    expect(screen.getByText("Title Contains Keyword")).toBeInTheDocument();
    expect(screen.getByText("Meta Description")).toBeInTheDocument();
    expect(screen.getByText("H1 Keyword")).toBeInTheDocument();
  });

  it("shows pass/fail count", () => {
    renderWithProviders(
      <SeoChecklist
        checklist={{
          title_contains_keyword: true,
          meta_description: false,
          h1_keyword: true,
        }}
      />
    );
    expect(screen.getByText("2/3")).toBeInTheDocument();
  });

  it("renders green dot for passing checks", () => {
    const { container } = renderWithProviders(
      <SeoChecklist checklist={{ title_contains_keyword: true }} />
    );
    const dots = container.querySelectorAll(".bg-emerald-500");
    expect(dots).toHaveLength(1);
  });

  it("renders red dot for failing checks", () => {
    const { container } = renderWithProviders(
      <SeoChecklist checklist={{ meta_description: false }} />
    );
    const dots = container.querySelectorAll(".bg-red-500");
    expect(dots).toHaveLength(1);
  });

  it("returns null for empty checklist", () => {
    const { container } = renderWithProviders(<SeoChecklist checklist={{}} />);
    expect(container.querySelector("[data-testid='seo-checklist']")).toBeNull();
  });
});

describe("KeywordDensity", () => {
  it("renders keyword density badges", () => {
    renderWithProviders(
      <KeywordDensity density={{ "primary keyword": 1.5, "secondary": 0.8 }} />
    );
    expect(screen.getByText("Keyword Density")).toBeInTheDocument();
    expect(screen.getByText("primary keyword: 1.5%")).toBeInTheDocument();
    expect(screen.getByText("secondary: 0.8%")).toBeInTheDocument();
  });

  it("color-codes density in range (1-2%) as green", () => {
    const { container } = renderWithProviders(
      <KeywordDensity density={{ test: 1.5 }} />
    );
    const badge = container.querySelector("[data-testid='keyword-density'] span");
    expect(badge?.className).toContain("emerald");
  });

  it("color-codes density below range as amber", () => {
    const { container } = renderWithProviders(
      <KeywordDensity density={{ test: 0.5 }} />
    );
    const badge = container.querySelector("[data-testid='keyword-density'] span");
    expect(badge?.className).toContain("amber");
  });

  it("color-codes density above range as red", () => {
    const { container } = renderWithProviders(
      <KeywordDensity density={{ test: 3.0 }} />
    );
    const badge = container.querySelector("[data-testid='keyword-density'] span");
    expect(badge?.className).toContain("red");
  });

  it("returns null for empty density", () => {
    const { container } = renderWithProviders(<KeywordDensity density={{}} />);
    expect(container.querySelector("[data-testid='keyword-density']")).toBeNull();
  });
});
