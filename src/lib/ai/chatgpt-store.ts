import "server-only";
import { prisma } from "@/lib/prisma";
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile, chmod } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

const accountSchema = z.object({ clientId: z.string(), subject: z.string(), email: z.string().nullable(), accessToken: z.string().nullable(), refreshToken: z.string().nullable(), idToken: z.string().nullable(), expiresAt: z.number(), scopes: z.array(z.string()), agentAllowed: z.boolean() });
export type ChatGPTAccount = z.infer<typeof accountSchema>;
const vaultSchema = z.object({ hostId: z.string(), active: z.string().nullable(), accounts: z.array(accountSchema), pairing: z.object({ digest: z.string(), expiresAt: z.number(), nonce: z.string(), clientId: z.string().optional(), subject: z.string().optional() }).nullable() });
export type Vault = z.infer<typeof vaultSchema>;
// Deliberately outside DOSSIER_DATA_DIR and Postgres: neither exports nor ordinary backups contain it.
const directory = () => process.env.DOSSIER_CHATGPT_DIR || "/var/lib/dossier-chatgpt";
const missing = (e: unknown) => (e as NodeJS.ErrnoException).code === "ENOENT";
async function prepare(dir: string) {
  await mkdir(dir, { recursive: true, mode: 0o700 }); await chmod(dir, 0o700);
  const path = join(dir, "key");
  try { await writeFile(path, randomBytes(32), { flag: "wx", mode: 0o600 }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
  const key = await readFile(path); if (key.length !== 32) throw new Error("ChatGPT credential key is invalid");
  return key;
}
export async function writeVault(vault: Vault, dir = directory()) {
  const key = await prepare(dir); const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(vault)), cipher.final()]);
  const temporary = join(dir, `.credentials-${randomUUID()}`);
  await writeFile(temporary, Buffer.concat([iv, cipher.getAuthTag(), ciphertext]), { mode: 0o600, flag: "wx" });
  await rename(temporary, join(dir, "credentials.enc"));
}
export async function readVault(dir = directory()): Promise<Vault> {
  const key = await prepare(dir);
  let data: Buffer;
  try { data = await readFile(join(dir, "credentials.enc")); } catch (e) {
    if (!missing(e)) throw e;
    const initial: Vault = { hostId: `urn:uuid:${randomUUID()}`, active: null, accounts: [], pairing: null };
    await writeVault(initial, dir); return initial;
  }
  const decipher = createDecipheriv("aes-256-gcm", key, data.subarray(0, 12));
  decipher.setAuthTag(data.subarray(12, 28));
  return vaultSchema.parse(JSON.parse(Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString("utf8")));
}
// All production readers/writers, including refresh and disconnect, use this cross-process lock.
// A transaction-scoped Postgres advisory lock has automatic crash cleanup; no tokens enter Postgres.
export async function withVault<T>(fn: (vault: Vault) => Promise<T>): Promise<T> {
  return prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(742019310)::text`;
    const vault = await readVault();
    const result = await fn(vault);
    await writeVault(vault);
    return result;
  }, { timeout: 60_000, maxWait: 60_000 });
}
