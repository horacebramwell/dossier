import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createTestClient } from "@/test/db";
const db = vi.hoisted(() => ({ client: undefined as ReturnType<typeof createTestClient> | undefined }));
vi.mock("@/lib/prisma", async () => { const { createTestClient } = await import("@/test/db"); db.client = createTestClient(); return { prisma: db.client }; });
import { withVault } from "./chatgpt-store";
let directory: string;
beforeAll(async () => { directory = await mkdtemp(join(tmpdir(), "chatgpt-db-vault-")); process.env.DOSSIER_CHATGPT_DIR = directory; });
afterAll(async () => { delete process.env.DOSSIER_CHATGPT_DIR; await db.client?.$disconnect(); if (directory) await rm(directory, { recursive: true, force: true }); });
it("serializes concurrent credential updates with a real Postgres advisory lock", async () => {
  const host = await withVault(async vault => vault.hostId);
  await Promise.all(Array.from({ length: 4 }, (_, i) => withVault(async vault => {
    await new Promise(resolve => setTimeout(resolve, 10));
    vault.accounts.push({ clientId: `client-${i}`, subject: "sub", email: null, accessToken: null, refreshToken: null, idToken: null, expiresAt: 0, scopes: [], agentAllowed: false });
  })));
  const result = await withVault(async vault => ({ count: vault.accounts.length, host: vault.hostId }));
  expect(result).toEqual({ count: 4, host });
});
it("releases its advisory lock after an operation fails", async () => {
  await expect(withVault(async () => { throw new Error("test failure"); })).rejects.toThrow("test failure");
  await expect(withVault(async vault => vault.accounts.length)).resolves.toBe(4);
});
