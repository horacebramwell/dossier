import { describe, expect, it } from "vitest";
import { authorizationUrl, callbackResult, responseBody, collectResponse, catalogModels } from "./chatgpt-contract";

const attempt = { state: "state", nonce: "nonce", verifier: "verifier", redirectUri: "http://127.0.0.1:1455/auth/callback", hostId: "urn:uuid:test" };
describe("official ChatGPT contract", () => {
  it("requests dynamic registration, plan permission and S256 PKCE", () => {
    const url = new URL(authorizationUrl(attempt));
    expect(url.origin).toBe("https://auth.openai.com");
    expect(url.searchParams.get("client_id")).toBe("dynamic_agent_client");
    expect(url.searchParams.get("scope")).toContain("chatgpt.tokens.use.direct");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("agent_name_hint")).toBe("Dossier");
  });
  it("rejects state mismatch, denied consent, missing issued client and client substitution", () => {
    for (const query of ["state=bad&code=a&client_id=oaiapp_x", "state=state&error=access_denied", "state=state&code=a", "state=state&code=a&client_id=dynamic_agent_client"]) {
      expect(() => callbackResult(new URLSearchParams(query), attempt)).toThrow();
    }
    expect(() => callbackResult(new URLSearchParams("state=state&code=a&client_id=other"), { ...attempt, clientId: "issued" })).toThrow();
    expect(callbackResult(new URLSearchParams("state=state&code=a"), { ...attempt, clientId: "issued" })).toEqual({ code: "a", clientId: "issued" });
  });
  it("sends only supported Responses fields, preserves history and JSON instructions", () => {
    const body = responseBody({ model: "account-model", system: "Truth only", messages: [{ role: "assistant", content: "draft" }, { role: "user", content: "refine" }] });
    expect(body).toEqual({ model: "account-model", instructions: "Truth only", input: [{ role: "assistant", content: "draft" }, { role: "user", content: "refine" }], store: false, stream: true });
  });
  it("requires completed event and rejects interrupted or failed partial results", async () => {
    async function* events(types: string[]) { for (const type of types) yield { type, delta: "partial" }; }
    await expect(collectResponse(events(["response.output_text.delta"])) ).rejects.toThrow();
    await expect(collectResponse(events(["response.output_text.delta", "response.failed"]))).rejects.toThrow();
    await expect(collectResponse(events(["response.output_text.delta", "response.incomplete"]))).rejects.toThrow();
    await expect(collectResponse(events(["response.output_text.delta", "response.completed"]))).resolves.toBe("partial");
  });
  it("uses only visible account models and preserves their ordering and display names", () => {
    expect(catalogModels({ models: [{ slug: "b", display_name: "B", visibility: "list" }, { slug: "secret", display_name: "Hidden", visibility: "hide" }, { slug: "a", display_name: "A", visibility: "list" }] })).toEqual([{ slug: "b", name: "B" }, { slug: "a", name: "A" }]);
    expect(() => catalogModels({ data: [{ id: "api-model" }] })).toThrow();
  });
});
