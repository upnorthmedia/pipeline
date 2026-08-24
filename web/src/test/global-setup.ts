import { mkdir, rm } from "node:fs/promises"

import { testMediaRoot } from "./test-media-root"

export async function setup(): Promise<void> {
  await rm(testMediaRoot(), { recursive: true, force: true })
  await mkdir(testMediaRoot(), { recursive: true })
}

export async function teardown(): Promise<void> {
  await rm(testMediaRoot(), { recursive: true, force: true })
}
