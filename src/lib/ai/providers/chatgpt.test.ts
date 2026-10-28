import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
const mock = vi.hoisted(() => ({ create: vi.fn(), token: vi.fn(), models: vi.fn() }));
vi.mock("openai", () => ({ default: class { responses = { create: mock.create }; } }));
vi.mock("../chatgpt-account", () => ({ accessToken: mock.token, accountModels: mock.models }));
import { ChatGPTProvider } from "./chatgpt";
async function* output(text: string, completed = true) { yield { type: "response.output_text.delta", delta: text }; if (completed) yield { type: "response.completed" }; }
beforeEach(() => { vi.clearAllMocks(); mock.token.mockResolvedValue({ token: "oauth", clientId: "client" }); mock.models.mockResolvedValue([{ slug: "available", name: "Available" }]); });
describe("ChatGPT provider", () => {
  it("preserves Zod validation and corrective retry without unsupported fields", async () => {
    mock.create.mockResolvedValueOnce(output('{"score":"wrong"}')).mockResolvedValueOnce(output('{"score":4}'));
    const provider = new ChatGPTProvider("available", 5000);
    await expect(provider.complete({ system: "Be accurate", messages: [{ role: "user", content: "Score" }], schema: z.object({ score: z.number() }), creativity: "BALANCED", maxTokens: 123 })).resolves.toEqual({ score: 4 });
    expect(mock.create).toHaveBeenCalledTimes(2);
    const body = mock.create.mock.calls[0][0];
    expect(body.store).toBe(false); expect(body.stream).toBe(true);
    expect(body.instructions).toContain("Be accurate"); expect(body.instructions).toContain("JSON");
    expect(body).not.toHaveProperty("temperature"); expect(body).not.toHaveProperty("max_output_tokens");
    expect(mock.create.mock.calls[1][0].input).toHaveLength(3);
  });
  it("never accepts a partial stream as successful output", async () => {
    mock.create.mockResolvedValue(output("partial", false));
    await expect(new ChatGPTProvider("available", 5000).complete({ system: "s", messages: [] })).rejects.toMatchObject({ kind: "provider" });
  });
  it("rejects models absent from the account and never falls back", async () => {
    await expect(new ChatGPTProvider("missing", 5000).complete({ system: "s", messages: [] })).rejects.toMatchObject({ kind: "model" });
    expect(mock.create).not.toHaveBeenCalled();
  });
  it("propagates cancellation", async () => {
    const abort = new AbortController(); abort.abort();
    await expect(new ChatGPTProvider("available", 5000).complete({ system: "s", messages: [], signal: abort.signal })).rejects.toThrow();
    expect(mock.create).not.toHaveBeenCalled();
  });
});
