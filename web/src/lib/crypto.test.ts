import { afterEach, describe, expect, it } from 'vitest'

import {
  InvalidTokenError,
  decrypt,
  decryptWithKey,
  encrypt,
  encryptWithKey,
} from './crypto'
import pythonFernet from './__fixtures__/python-fernet.json'

/**
 * The fixture was produced by the same library api/src/services/crypto.py uses
 * (cryptography.fernet.Fernet). Decrypting it here is the interop proof: these
 * tokens were never produced by this TypeScript code.
 */
const { key: pythonKey, cases: pythonCases } = pythonFernet

const originalKey = process.env.WP_ENCRYPTION_KEY

afterEach(() => {
  if (originalKey === undefined) {
    delete process.env.WP_ENCRYPTION_KEY
  } else {
    process.env.WP_ENCRYPTION_KEY = originalKey
  }
})

describe('decryptWithKey against Python-generated Fernet tokens', () => {
  for (const { name, plaintext, token } of pythonCases) {
    it(`decrypts a Python token: ${name}`, () => {
      expect(decryptWithKey(token, pythonKey)).toBe(plaintext)
    })
  }
})

describe('encryptWithKey', () => {
  it('round-trips through decryptWithKey', () => {
    const cipher = encryptWithKey('round-trip-value', pythonKey)
    expect(decryptWithKey(cipher, pythonKey)).toBe('round-trip-value')
  })

  it('produces a different token each call, like Fernet with a random IV', () => {
    const a = encryptWithKey('same-password', pythonKey)
    const b = encryptWithKey('same-password', pythonKey)
    expect(a).not.toBe(b)
    expect(decryptWithKey(a, pythonKey)).toBe(decryptWithKey(b, pythonKey))
  })

  it('reproduces a Python token byte for byte given that token timestamp and IV', () => {
    // Pin the two random inputs Fernet takes so the output is deterministic; if
    // any other framing detail differed, the tokens would not match.
    const original = pythonCases[0]
    const raw = Buffer.from(original.token, 'base64url')
    const timestamp = Number(raw.readBigUInt64BE(1))
    const iv = raw.subarray(9, 25)

    expect(encryptWithKey(original.plaintext, pythonKey, timestamp, iv)).toBe(
      original.token,
    )
  })
})

describe('token validation', () => {
  const validToken = pythonCases[0].token

  it('rejects a token signed with a different key', () => {
    const otherKey = Buffer.alloc(32, 7).toString('base64url')
    expect(() => decryptWithKey(validToken, otherKey)).toThrow(InvalidTokenError)
  })

  it('rejects a tampered ciphertext', () => {
    const raw = Buffer.from(validToken, 'base64url')
    raw[30] ^= 0xff
    expect(() => decryptWithKey(raw.toString('base64url'), pythonKey)).toThrow(
      InvalidTokenError,
    )
  })

  it('rejects a truncated token', () => {
    const raw = Buffer.from(validToken, 'base64url')
    expect(() =>
      decryptWithKey(raw.subarray(0, 20).toString('base64url'), pythonKey),
    ).toThrow(InvalidTokenError)
  })

  it('rejects a token with an unknown version byte', () => {
    const raw = Buffer.from(validToken, 'base64url')
    raw[0] = 0x79
    expect(() => decryptWithKey(raw.toString('base64url'), pythonKey)).toThrow(
      InvalidTokenError,
    )
  })

  it('rejects a key that is not 32 bytes', () => {
    expect(() => decryptWithKey(validToken, 'c2hvcnQ=')).toThrow(
      /32 url-safe base64-encoded bytes/,
    )
  })
})

describe('environment-backed encrypt/decrypt', () => {
  it('uses WP_ENCRYPTION_KEY, matching the Python settings field', () => {
    process.env.WP_ENCRYPTION_KEY = pythonKey
    expect(decrypt(pythonCases[0].token)).toBe(pythonCases[0].plaintext)
    expect(decrypt(encrypt('via-env'))).toBe('via-env')
  })

  it('throws a descriptive error when WP_ENCRYPTION_KEY is unset', () => {
    delete process.env.WP_ENCRYPTION_KEY
    expect(() => encrypt('anything')).toThrow(/WP_ENCRYPTION_KEY not set/)
    expect(() => decrypt(pythonCases[0].token)).toThrow(/WP_ENCRYPTION_KEY not set/)
  })
})
