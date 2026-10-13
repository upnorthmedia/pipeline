/**
 * The two profile columns that are stored encrypted.
 *
 * `create_profile()` and `update_profile()` in `api/src/api/profiles.py` both
 * encrypt exactly these two, and both guard on truthiness rather than on the
 * key being present, so a `null` or an empty string is written through as-is
 * and never becomes a Fernet token over nothing.
 */
import { encrypt } from "@/lib/crypto"

import type { websiteProfiles } from "@/db"

type ProfileInsert = typeof websiteProfiles.$inferInsert

const ENCRYPTED_COLUMNS = ["wpAppPassword", "nextjsWebhookSecret"] as const

/** Encrypts in place and returns the same object, for use at the call site. */
export function encryptCredentials(columns: ProfileInsert): ProfileInsert {
  for (const column of ENCRYPTED_COLUMNS) {
    const value = columns[column]
    if (value) columns[column] = encrypt(value)
  }
  return columns
}
