import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { posts, profiles, queue, settings, sseUrl } from "./api";

const API_BASE = "http://localhost:8000";

// Track all fetch calls
let fetchCalls: { url: string; init?: RequestInit }[] = [];
let mockResponse: { status: number; body: unknown; ok: boolean } = {
  status: 200,
  body: {},
  ok: true,
};

beforeEach(() => {
  fetchCalls = [];
  mockResponse = { status: 200, body: {}, ok: true };

  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      fetchCalls.push({ url, init });
      return {
        ok: mockResponse.ok,
        status: mockResponse.status,
        json: async () => mockResponse.body,
        text: async () =>
          typeof mockResponse.body === "string"
            ? mockResponse.body
            : JSON.stringify(mockResponse.body),
      };
    })
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("api client", () => {
  describe("request formatting", () => {
    it("sends GET requests with correct URL", async () => {
      mockResponse.body = [];
      await profiles.list();
      expect(fetchCalls[0].url).toBe(`${API_BASE}/api/profiles`);
      expect(fetchCalls[0].init?.method).toBeUndefined();
    });

    it("sends POST requests with JSON body", async () => {
      mockResponse.body = { id: "p1", name: "Test" };
      await profiles.create({ name: "Test", website_url: "https://test.com" });
      expect(fetchCalls[0].url).toBe(`${API_BASE}/api/profiles`);
      expect(fetchCalls[0].init?.method).toBe("POST");
      expect(JSON.parse(fetchCalls[0].init?.body as string)).toEqual({
        name: "Test",
        website_url: "https://test.com",
      });
    });

    it("sends PATCH requests with JSON body", async () => {
      mockResponse.body = { id: "p1" };
      await profiles.update("p1", { name: "Updated" });
      expect(fetchCalls[0].url).toBe(`${API_BASE}/api/profiles/p1`);
      expect(fetchCalls[0].init?.method).toBe("PATCH");
    });

    it("sends DELETE requests", async () => {
      mockResponse = { status: 204, body: undefined, ok: true };
      await profiles.delete("p1");
      expect(fetchCalls[0].url).toBe(`${API_BASE}/api/profiles/p1`);
      expect(fetchCalls[0].init?.method).toBe("DELETE");
    });

    it("includes Content-Type header", async () => {
      mockResponse.body = [];
      await posts.list();
      const headers = fetchCalls[0].init?.headers as Record<string, string>;
      expect(headers["Content-Type"]).toBe("application/json");
    });
  });

  describe("query parameters", () => {
    it("builds query string for posts.list filters", async () => {
      mockResponse.body = [];
      await posts.list({ status: "complete", q: "test", profile_id: "p1" });
      const url = fetchCalls[0].url;
      expect(url).toContain("status=complete");
      expect(url).toContain("q=test");
      expect(url).toContain("profile_id=p1");
    });

    it("omits empty parameters", async () => {
      mockResponse.body = [];
      await posts.list({});
      expect(fetchCalls[0].url).toBe(`${API_BASE}/api/posts`);
    });

    it("builds query string for profile links", async () => {
      mockResponse.body = [];
      await profiles.links("p1", { page: 2, per_page: 25, q: "search" });
      const url = fetchCalls[0].url;
      expect(url).toContain("page=2");
      expect(url).toContain("per_page=25");
      expect(url).toContain("q=search");
    });
  });

  describe("error handling", () => {
    it("throws ApiError on non-ok response", async () => {
      mockResponse = { status: 404, body: "Not found", ok: false };
      await expect(posts.get("bad-id")).rejects.toThrow("Not found");
    });

    it("includes status code in error", async () => {
      mockResponse = { status: 422, body: "Validation error", ok: false };
      try {
        await posts.get("bad-id");
      } catch (err) {
        expect((err as { status: number }).status).toBe(422);
      }
    });

    it("handles 204 No Content responses", async () => {
      mockResponse = { status: 204, body: undefined, ok: true };
      const result = await posts.delete("post-1");
      expect(result).toBeUndefined();
    });
  });

  describe("posts endpoints", () => {
    it("creates a post", async () => {
      mockResponse.body = { id: "new-1", topic: "Test" };
      await posts.create({ slug: "test", topic: "Test" });
      expect(fetchCalls[0].init?.method).toBe("POST");
      expect(fetchCalls[0].url).toBe(`${API_BASE}/api/posts`);
    });

    it("duplicates a post", async () => {
      mockResponse.body = { id: "dup-1" };
      await posts.duplicate("post-1");
      expect(fetchCalls[0].url).toBe(`${API_BASE}/api/posts/post-1/duplicate`);
      expect(fetchCalls[0].init?.method).toBe("POST");
    });

    it("runs next stage", async () => {
      mockResponse.body = { status: "running", stage: "research" };
      await posts.run("post-1");
      expect(fetchCalls[0].url).toBe(`${API_BASE}/api/posts/post-1/run`);
    });

    it("runs specific stage", async () => {
      mockResponse.body = { status: "running", stage: "outline" };
      await posts.run("post-1", "outline");
      expect(fetchCalls[0].url).toBe(
        `${API_BASE}/api/posts/post-1/run?stage=outline`
      );
    });

    it("runs all stages", async () => {
      mockResponse.body = { status: "running", mode: "all" };
      await posts.runAll("post-1");
      expect(fetchCalls[0].url).toBe(`${API_BASE}/api/posts/post-1/run-all`);
    });

    it("approves a post", async () => {
      mockResponse.body = { id: "post-1" };
      await posts.approve("post-1");
      expect(fetchCalls[0].url).toBe(`${API_BASE}/api/posts/post-1/approve`);
      expect(fetchCalls[0].init?.method).toBe("POST");
    });

    it("pauses a post", async () => {
      mockResponse.body = { status: "paused" };
      await posts.pause("post-1");
      expect(fetchCalls[0].url).toBe(`${API_BASE}/api/posts/post-1/pause`);
    });

    it("reruns a specific stage", async () => {
      mockResponse.body = { status: "running", stage: "research" };
      await posts.rerun("post-1", "research");
      expect(fetchCalls[0].url).toBe(
        `${API_BASE}/api/posts/post-1/rerun/research`
      );
    });

    it("batch creates posts", async () => {
      mockResponse.body = [{ id: "b1" }, { id: "b2" }];
      await posts.batchCreate([
        { slug: "a", topic: "A" },
        { slug: "b", topic: "B" },
      ]);
      expect(fetchCalls[0].url).toBe(`${API_BASE}/api/posts/batch`);
      expect(JSON.parse(fetchCalls[0].init?.body as string)).toHaveLength(2);
    });

    it("fetches analytics", async () => {
      mockResponse.body = { word_count: 2000 };
      await posts.analytics("post-1");
      expect(fetchCalls[0].url).toBe(`${API_BASE}/api/posts/post-1/analytics`);
    });
  });

  describe("export URL helpers", () => {
    it("generates markdown export URL", () => {
      expect(posts.exportMarkdown("post-1")).toBe(
        `${API_BASE}/api/posts/post-1/export/markdown`
      );
    });

    it("generates HTML export URL", () => {
      expect(posts.exportHtml("post-1")).toBe(
        `${API_BASE}/api/posts/post-1/export/html`
      );
    });

    it("generates ZIP export URL", () => {
      expect(posts.exportAll("post-1")).toBe(
        `${API_BASE}/api/posts/post-1/export/all`
      );
    });
  });

  describe("queue endpoints", () => {
    it("fetches queue status", async () => {
      mockResponse.body = { running: 1, pending: 3 };
      await queue.status();
      expect(fetchCalls[0].url).toBe(`${API_BASE}/api/queue`);
    });

    it("fetches review queue", async () => {
      mockResponse.body = [];
      await queue.review();
      expect(fetchCalls[0].url).toBe(`${API_BASE}/api/queue/review`);
    });

    it("pauses all", async () => {
      mockResponse.body = { status: "paused", count: 5 };
      await queue.pauseAll();
      expect(fetchCalls[0].url).toBe(`${API_BASE}/api/queue/pause-all`);
      expect(fetchCalls[0].init?.method).toBe("POST");
    });

    it("resumes all", async () => {
      mockResponse.body = { status: "resumed", count: 5 };
      await queue.resumeAll();
      expect(fetchCalls[0].url).toBe(`${API_BASE}/api/queue/resume-all`);
    });
  });

  describe("settings endpoints", () => {
    it("fetches settings", async () => {
      mockResponse.body = [];
      await settings.list();
      expect(fetchCalls[0].url).toBe(`${API_BASE}/api/settings`);
    });

    it("updates settings", async () => {
      mockResponse.body = [];
      await settings.update({ api_keys: { value: { claude: "sk-xxx" } } });
      expect(fetchCalls[0].init?.method).toBe("PATCH");
    });
  });

  describe("SSE URL helpers", () => {
    it("generates post-specific SSE URL", () => {
      expect(sseUrl.post("post-1")).toBe(`${API_BASE}/api/events/post-1`);
    });

    it("generates global SSE URL", () => {
      expect(sseUrl.global()).toBe(`${API_BASE}/api/events`);
    });
  });
});
