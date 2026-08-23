/**
 * TypeScript port of `api/src/services/hmac_signing.py`.
 *
 * The signature is the contract between this app and the webhook receiver in
 * `packages/create-mdx-blog/src/adapters/delivery/webhook.ts`, which recomputes
 * `createHmac("sha256", secret).update(rawBody)` over the exact bytes it was
 * sent and compares the lowercase hex digest, so the digest encoding and the
 * payload bytes both have to stay as Python produced them.
 *
 * Python's `verify_signature` is not ported: nothing under `api/src` calls it,
 * because verification is the receiver's half of the contract and
 * `create-mdx-blog` already implements it.
 */
import { createHmac } from "node:crypto"

/** HMAC-SHA256 of `payload` under `secret`, lowercase hex. */
export function signPayload(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload, "utf8").digest("hex")
}
