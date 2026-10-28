import { beforeEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
const fake = vi.hoisted(() => ({ config: vi.fn(), accept: vi.fn() }));
vi.mock("@/lib/ai/chatgpt-account", async original => ({ ...await original<typeof import("@/lib/ai/chatgpt-account")>(), pairingConfiguration: fake.config, importCredentials: fake.accept }));
import { GET, POST } from "./route";
beforeEach(() => { vi.clearAllMocks(); fake.config.mockResolvedValue({ hostId: "vm", nonce: "n" }); fake.accept.mockResolvedValue({ planAllowed: true }); });
it("refuses unauthenticated and browser-origin pairing requests", async () => {
  expect((await GET(new NextRequest("https://dossier.test/api/chatgpt/pair"))).status).toBe(401);
  expect((await GET(new NextRequest("https://dossier.test/api/chatgpt/pair", { headers: { authorization: "Bearer pairing", origin: "https://evil.test" } }))).status).toBe(403);
  expect(fake.config).not.toHaveBeenCalled();
});
it("returns native-helper configuration without caching", async () => {
  const r = await GET(new NextRequest("https://dossier.test/api/chatgpt/pair", { headers: { authorization: "Bearer pairing" } }));
  expect(r.status).toBe(200); expect(r.headers.get("cache-control")).toBe("no-store"); expect(fake.config).toHaveBeenCalledWith("pairing");
});
it("validates imported credentials and rejects oversized bodies", async () => {
  const headers = { authorization: "Bearer pairing", "content-type": "application/json" };
  expect((await POST(new NextRequest("https://dossier.test/api/chatgpt/pair", { method: "POST", headers, body: JSON.stringify({ access_token: "unvalidated" }) }))).status).toBe(400);
  expect((await POST(new NextRequest("https://dossier.test/api/chatgpt/pair", { method: "POST", headers, body: "x".repeat(65000) }))).status).toBe(400);
  expect(fake.accept).not.toHaveBeenCalled();
});
