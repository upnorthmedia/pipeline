/**
 * TypeScript port of api/src/services/crypto.py.
 *
 * The Python side uses `cryptography.fernet.Fernet`, so this implements the
 * Fernet spec directly against node:crypto: values already stored encrypted in
 * the database (website_profiles.wp_app_password,
 * website_profiles.nextjs_webhook_secret, settings API keys) must keep
 * decrypting after the port.
 *
 * Fernet token layout, base64url encoded as a whole:
 *   version (1 byte, 0x80) | timestamp (8 bytes, big endian seconds)
 *   | IV (16 bytes) | AES-128-CBC ciphertext (PKCS7 padded) | HMAC-SHA256 (32 bytes)
 * The HMAC covers everything before it and is keyed with the first half of the
 * 32-byte key; the second half is the AES key.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto'

const VERSION = 0x80
const IV_LENGTH = 16
const HMAC_LENGTH = 32
const HEADER_LENGTH = 1 + 8 + IV_LENGTH

/** Raised for any token that is malformed, truncated, or fails HMAC verification. */
export class InvalidTokenError extends Error {
  constructor(message = 'Invalid Fernet token') {
    super(message)
    this.name = 'InvalidTokenError'
  }
}

/**
 * Node's 'base64url' encoding strips the '=' padding, but Python decodes Fernet
 * tokens with base64.urlsafe_b64decode, which rejects unpadded input. Tokens
 * this module writes must stay readable by api/src/services/crypto.py, so keep
 * the padding.
 */
function toPaddedBase64Url(buf: Buffer): string {
  return buf.toString('base64').replaceAll('+', '-').replaceAll('/', '_')
}

interface FernetKey {
  signingKey: Buffer
  encryptionKey: Buffer
}

function parseKey(key: string): FernetKey {
  const raw = Buffer.from(key, 'base64url')
  if (raw.length !== 32) {
    throw new Error('Fernet key must be 32 url-safe base64-encoded bytes')
  }
  return { signingKey: raw.subarray(0, 16), encryptionKey: raw.subarray(16, 32) }
}

function configuredKey(): string {
  const key = process.env.WP_ENCRYPTION_KEY
  if (!key) {
    throw new Error(
      'WP_ENCRYPTION_KEY not set. Generate one with: ' +
        "node -e \"console.log(require('node:crypto').randomBytes(32).toString('base64url'))\"",
    )
  }
  return key
}

/** Encrypt with an explicit key. Timestamp defaults to now, overridable for tests. */
export function encryptWithKey(
  plaintext: string,
  key: string,
  timestampSeconds: number = Math.floor(Date.now() / 1000),
  iv: Buffer = randomBytes(IV_LENGTH),
): string {
  const { signingKey, encryptionKey } = parseKey(key)

  const header = Buffer.alloc(HEADER_LENGTH)
  header.writeUInt8(VERSION, 0)
  header.writeBigUInt64BE(BigInt(timestampSeconds), 1)
  iv.copy(header, 9)

  // Node applies PKCS7 padding by default, which is what Fernet specifies.
  const cipher = createCipheriv('aes-128-cbc', encryptionKey, iv)
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(plaintext, 'utf8')),
    cipher.final(),
  ])

  const signed = Buffer.concat([header, ciphertext])
  const mac = createHmac('sha256', signingKey).update(signed).digest()
  return toPaddedBase64Url(Buffer.concat([signed, mac]))
}

/** Decrypt with an explicit key. Mirrors Fernet.decrypt with no TTL. */
export function decryptWithKey(ciphertext: string, key: string): string {
  const { signingKey, encryptionKey } = parseKey(key)

  // Buffer's base64url decoder is lenient (it drops unexpected characters rather
  // than throwing), so garbage input falls through to the HMAC check below.
  const token = Buffer.from(ciphertext, 'base64url')
  if (token.length < HEADER_LENGTH + HMAC_LENGTH || token[0] !== VERSION) {
    throw new InvalidTokenError()
  }

  const signed = token.subarray(0, token.length - HMAC_LENGTH)
  const mac = token.subarray(token.length - HMAC_LENGTH)
  const expected = createHmac('sha256', signingKey).update(signed).digest()
  if (!timingSafeEqual(mac, expected)) {
    throw new InvalidTokenError()
  }

  const iv = signed.subarray(9, HEADER_LENGTH)
  const body = signed.subarray(HEADER_LENGTH)
  if (body.length === 0 || body.length % IV_LENGTH !== 0) {
    throw new InvalidTokenError()
  }

  try {
    const decipher = createDecipheriv('aes-128-cbc', encryptionKey, iv)
    return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8')
  } catch {
    throw new InvalidTokenError()
  }
}

export function encrypt(plaintext: string): string {
  return encryptWithKey(plaintext, configuredKey())
}

export function decrypt(ciphertext: string): string {
  return decryptWithKey(ciphertext, configuredKey())
}
