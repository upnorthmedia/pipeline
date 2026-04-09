import type { ContentDeliveryAdapter, ScaffoldContext } from "../types.js";
import type { GeneratedFile } from "../../types.js";

interface WebhookOptions {
  typescript: boolean;
  contentDir: string;
  imageStorage: "local" | "jena-cdn";
  localImageDir: string;
  localImagePublicPath: string;
}

export function generateWebhookHandler(options: WebhookOptions): string {
  const { contentDir } = options;

  return `import { NextResponse } from "next/server";
import { createHmac, timingSafeEqual } from "node:crypto";

const WEBHOOK_SECRET = process.env.JENA_WEBHOOK_SECRET!;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN!;
const GITHUB_REPO = process.env.GITHUB_REPO!;
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || "main";
const CONTENT_PATH = process.env.JENA_CONTENT_PATH || "${contentDir}";
const MAX_BODY_SIZE = 10 * 1024 * 1024; // 10MB

function verifySignature(body: string, signature: string): boolean {
  const expected = createHmac("sha256", WEBHOOK_SECRET)
    .update(body)
    .digest("hex");
  try {
    return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}

function sanitizeSlug(slug: string): string {
  return slug.replace(/[^a-z0-9-]/g, "").slice(0, 200);
}

async function commitToGitHub(
  filePath: string,
  content: string,
  commitMessage: string,
): Promise<{ sha: string; url: string }> {
  const apiUrl = \`https://api.github.com/repos/\${GITHUB_REPO}/contents/\${filePath}\`;

  // Check if file already exists (need SHA for updates)
  let existingSha: string | undefined;
  const checkRes = await fetch(\`\${apiUrl}?ref=\${GITHUB_BRANCH}\`, {
    headers: {
      Authorization: \`Bearer \${GITHUB_TOKEN}\`,
      Accept: "application/vnd.github.v3+json",
    },
  });
  if (checkRes.ok) {
    const existing = await checkRes.json();
    existingSha = existing.sha;
  }

  // Create or update the file
  const body: Record<string, string> = {
    message: commitMessage,
    content: Buffer.from(content).toString("base64"),
    branch: GITHUB_BRANCH,
  };
  if (existingSha) {
    body.sha = existingSha;
  }

  const res = await fetch(apiUrl, {
    method: "PUT",
    headers: {
      Authorization: \`Bearer \${GITHUB_TOKEN}\`,
      Accept: "application/vnd.github.v3+json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const error = await res.text();
    throw new Error(\`GitHub API error \${res.status}: \${error}\`);
  }

  const result = await res.json();
  return {
    sha: result.commit.sha,
    url: result.content.html_url,
  };
}

export async function POST(request: Request) {
  const contentLength = parseInt(request.headers.get("content-length") || "0", 10);
  if (contentLength > MAX_BODY_SIZE) {
    return NextResponse.json({ error: "Payload too large" }, { status: 413 });
  }

  // Validate HMAC signature
  const signature = request.headers.get("X-Jena-Signature");
  if (!signature) {
    return NextResponse.json({ error: "Missing signature" }, { status: 401 });
  }

  const rawBody = await request.text();

  if (!verifySignature(rawBody, signature)) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  const payload = JSON.parse(rawBody);

  // Validate timestamp (reject replays older than 5 minutes)
  const timestamp = new Date(payload.timestamp).getTime();
  if (Date.now() - timestamp > 5 * 60 * 1000) {
    return NextResponse.json({ error: "Request expired" }, { status: 401 });
  }

  // Handle test events
  if (payload.event === "test") {
    if (!GITHUB_TOKEN) {
      return NextResponse.json({ received: true, test: true, warning: "GITHUB_TOKEN not set" });
    }
    const check = await fetch(\`https://api.github.com/repos/\${GITHUB_REPO}\`, {
      headers: { Authorization: \`Bearer \${GITHUB_TOKEN}\` },
    });
    return NextResponse.json({
      received: true,
      test: true,
      github: check.ok ? "connected" : "token invalid or no repo access",
    });
  }

  // Sanitize slug
  const slug = sanitizeSlug(payload.slug || "");
  if (!slug) {
    return NextResponse.json({ error: "Invalid slug" }, { status: 400 });
  }

  const filePath = \`\${CONTENT_PATH}/\${slug}.mdx\`;
  if (filePath.includes("..")) {
    return NextResponse.json({ error: "Invalid path" }, { status: 400 });
  }

  if (!GITHUB_TOKEN) {
    return NextResponse.json({ error: "GITHUB_TOKEN not configured" }, { status: 500 });
  }

  const content: string = payload.content;

  try {
    const result = await commitToGitHub(
      filePath,
      content,
      \`feat(blog): add "\${slug}"\`,
    );

    return NextResponse.json({
      received: true,
      path: filePath,
      sha: result.sha,
      url: result.url,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: \`GitHub commit failed: \${message}\` }, { status: 500 });
  }
}
`;
}

export const webhookDeliveryAdapter: ContentDeliveryAdapter = {
  name: "webhook",

  async scaffold(ctx: ScaffoldContext): Promise<GeneratedFile[]> {
    const config = ctx.config;
    const handler = generateWebhookHandler({
      typescript: ctx.typescript,
      contentDir: config.blog?.contentDir ?? "content/blog",
      imageStorage: config.images?.storage ?? "jena-cdn",
      localImageDir: config.images?.localDir ?? "public/blog/images",
      localImagePublicPath: config.images?.publicPath ?? "/blog/images",
    });

    return [
      {
        path: "app/api/jena-webhook/route.ts",
        content: handler,
      },
    ];
  },
};
