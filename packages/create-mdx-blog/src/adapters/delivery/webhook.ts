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
  const { contentDir, imageStorage, localImageDir, localImagePublicPath } = options;

  const imageDownloadBlock =
    imageStorage === "local"
      ? `
  // Download images locally
  const imageDir = path.join(process.cwd(), "${localImageDir}", slug);
  await fs.mkdir(imageDir, { recursive: true });

  for (const img of images) {
    if (!img.download_url) continue;
    const resp = await fetch(img.download_url, { signal: AbortSignal.timeout(30_000) });
    if (!resp.ok) {
      // Clean up partial downloads on failure
      await fs.rm(imageDir, { recursive: true, force: true }).catch(() => {});
      return NextResponse.json(
        { error: \`Failed to download image: \${img.filename}\` },
        { status: 500 },
      );
    }
    const buffer = Buffer.from(await resp.arrayBuffer());
    await fs.writeFile(path.join(imageDir, img.filename), buffer);
  }

  // Rewrite image URLs from CDN to local paths
  for (const img of images) {
    if (img.url) {
      content = content.replaceAll(img.url, \`${localImagePublicPath}/\${slug}/\${img.filename}\`);
    }
  }`
      : "";

  return `import { NextResponse } from "next/server";
import { createHmac, timingSafeEqual } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const WEBHOOK_SECRET = process.env.JENA_WEBHOOK_SECRET!;
const CONTENT_DIR = path.resolve(process.cwd(), "${contentDir}");
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

export async function POST(request: Request) {
  // Method is guaranteed POST by Next.js route handler, but verify content length
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

  // Sanitize and validate slug
  const slug = sanitizeSlug(payload.slug || "");
  if (!slug) {
    return NextResponse.json({ error: "Invalid slug" }, { status: 400 });
  }

  // Directory confinement check
  const filePath = path.resolve(CONTENT_DIR, \`\${slug}.mdx\`);
  if (!filePath.startsWith(CONTENT_DIR)) {
    return NextResponse.json({ error: "Invalid path" }, { status: 400 });
  }

  let content: string = payload.content;
  const images: Array<{
    filename: string;
    url: string;${imageStorage === "local" ? "\n    download_url?: string;" : ""}
    alt: string;
    placement: string;
  }> = payload.images || [];
${imageDownloadBlock}

  // Write MDX file
  await fs.mkdir(CONTENT_DIR, { recursive: true });
  await fs.writeFile(filePath, content, "utf-8");

  return NextResponse.json({
    received: true,
    path: path.relative(process.cwd(), filePath),
  });
}
`;
}

export const webhookDeliveryAdapter: ContentDeliveryAdapter = {
  name: "webhook",

  async scaffold(ctx: ScaffoldContext): Promise<GeneratedFile[]> {
    const config = ctx.config;
    const imageStorage = config.images?.storage ?? "local";
    const handler = generateWebhookHandler({
      typescript: ctx.typescript,
      contentDir: config.blog?.contentDir ?? "content/blog",
      imageStorage,
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
