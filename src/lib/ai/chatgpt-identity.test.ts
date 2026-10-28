import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { verifyIdentity } from "./chatgpt-contract";
let key: Awaited<ReturnType<typeof generateKeyPair>>;
beforeAll(async () => {
  key = await generateKeyPair("RS256"); const publicKey = await exportJWK(key.publicKey);
  vi.spyOn(globalThis, "fetch").mockImplementation(async input => {
    const url = String(input);
    if (url.includes("openid-configuration")) return Response.json({ issuer: "https://auth.openai.com", jwks_uri: "https://auth.openai.com/jwks", revocation_endpoint: "https://auth.openai.com/revoke" });
    return Response.json({ keys: [{ ...publicKey, kid: "test", alg: "RS256", use: "sig" }] });
  });
});
afterAll(() => vi.restoreAllMocks());
const token = (claims: Record<string, unknown> = {}) => new SignJWT({ nonce: "nonce", ...claims }).setProtectedHeader({ alg: "RS256", kid: "test" }).setIssuer("https://auth.openai.com").setAudience("issued").setSubject("sub").setIssuedAt().setExpirationTime("1h").sign(key.privateKey);
it("verifies the OpenAI-signed identity against the issued client ID", async () => { expect(await verifyIdentity(await token(), "issued", "nonce", "sub")).toEqual({ subject: "sub", email: null }); });
it("rejects nonce, subject, audience and authorized-party mismatches", async () => {
  for (const [client, nonce, sub] of [["other", "nonce", "sub"], ["issued", "wrong", "sub"], ["issued", "nonce", "other"]]) await expect(verifyIdentity(await token(), client, nonce, sub)).rejects.toThrow("verified");
  await expect(verifyIdentity(await token({ azp: "other" }), "issued", "nonce")).rejects.toThrow("verified");
});
it("rejects forged signatures and expired identity tokens", async () => {
  const other = await generateKeyPair("RS256");
  const forged = await new SignJWT({ nonce: "nonce" }).setProtectedHeader({ alg: "RS256", kid: "test" }).setIssuer("https://auth.openai.com").setAudience("issued").setSubject("sub").setIssuedAt().setExpirationTime("1h").sign(other.privateKey);
  await expect(verifyIdentity(forged, "issued", "nonce")).rejects.toThrow("verified");
  const expired = await new SignJWT({ nonce: "nonce" }).setProtectedHeader({ alg: "RS256", kid: "test" }).setIssuer("https://auth.openai.com").setAudience("issued").setSubject("sub").setIssuedAt().setExpirationTime(1).sign(key.privateKey);
  await expect(verifyIdentity(expired, "issued", "nonce")).rejects.toThrow("verified");
});
