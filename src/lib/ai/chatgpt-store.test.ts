import { mkdtemp, readFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { readVault, writeVault } from "./chatgpt-store";
let dir: string;
afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });
it("persists encrypted credentials atomically with owner-only permissions outside DB", async () => {
  dir = await mkdtemp(join(tmpdir(), "dossier-vault-"));
  const vault = await readVault(dir);
  vault.accounts.push({ clientId: "issued", subject: "sub", email: "test@example.com", accessToken: "secret-access", refreshToken: "secret-refresh", idToken: "id", expiresAt: Date.now() + 3600000, scopes: ["chatgpt.tokens.use.direct"], agentAllowed: false });
  vault.active = "issued";
  await writeVault(vault, dir);
  expect(await readVault(dir)).toEqual(vault);
  expect(await readFile(join(dir, "credentials.enc"), "utf8")).not.toContain("secret-access");
  expect((await stat(join(dir, "credentials.enc"))).mode & 0o777).toBe(0o600);
  expect((await stat(join(dir, "key"))).mode & 0o777).toBe(0o600);
});
it("keeps a stable host identifier across restarts", async () => {
  dir = await mkdtemp(join(tmpdir(), "dossier-vault-"));
  expect((await readVault(dir)).hostId).toBe((await readVault(dir)).hostId);
});
