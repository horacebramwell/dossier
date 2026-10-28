import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Vault, ChatGPTAccount } from "./chatgpt-store";
const fake = vi.hoisted(() => ({ vault: {} as Vault, provider: "CHATGPT", grant: vi.fn(), identity: vi.fn(), config: vi.fn() }));
vi.mock("./chatgpt-store", () => ({ withVault: async (fn: (v: Vault) => unknown) => fn(fake.vault) }));
vi.mock("./config", () => ({ loadAiConfig: async () => ({ provider: fake.provider }) }));
vi.mock("./chatgpt-contract", async original => ({ ...await original<typeof import("./chatgpt-contract")>(), tokenGrant: fake.grant, verifyIdentity: fake.identity, openidConfiguration: fake.config }));
import { accessToken, accountStatus, beginPairing, disconnectAccount, importCredentials, pairingConfiguration, requireAgentAuthorization, selectAccount, setAgentAuthorization } from "./chatgpt-account";
import { PLAN_SCOPE, TokenError } from "./chatgpt-contract";
const account = (): ChatGPTAccount => ({ clientId: "issued", subject: "sub", email: "user@example.com", accessToken: "access", refreshToken: "refresh", idToken: "id", expiresAt: Date.now() + 3600000, scopes: [PLAN_SCOPE], agentAllowed: false });
beforeEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); fake.provider = "CHATGPT"; fake.vault = { hostId: "vm-host", active: "issued", accounts: [account()], pairing: null }; fake.identity.mockResolvedValue({ subject: "sub", email: "user@example.com" }); fake.config.mockResolvedValue({ revocation_endpoint: "https://auth.openai.com/revoke" }); });
describe("ChatGPT credential lifecycle", () => {
  it("returns only safe account metadata to settings", async () => { const status = JSON.stringify(await accountStatus()); for (const secret of ["accessToken", "refreshToken", "idToken"]) expect(status).not.toContain(secret); });
  it("requires express agent authorization and stops after withdrawal", async () => {
    await expect(requireAgentAuthorization()).rejects.toThrow("Authorize");
    await setAgentAuthorization(true); await expect(requireAgentAuthorization()).resolves.toBeUndefined();
    await setAgentAuthorization(false); await expect(requireAgentAuthorization()).rejects.toThrow("Authorize");
    fake.provider = "OPENAI"; await expect(requireAgentAuthorization()).resolves.toBeUndefined();
  });
  it("refreshes near expiry and atomically adopts rotated tokens", async () => {
    fake.vault.accounts[0].expiresAt = 0;
    fake.grant.mockResolvedValue({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600, token_type: "Bearer" });
    expect(await accessToken()).toEqual({ token: "new-access", clientId: "issued" });
    expect(fake.grant).toHaveBeenCalledWith({ grant_type: "refresh_token", client_id: "issued", refresh_token: "refresh" });
    expect(fake.vault.accounts[0].refreshToken).toBe("new-refresh");
    await accessToken(); expect(fake.grant).toHaveBeenCalledTimes(1);
  });
  it("clears unusable tokens on terminal refresh failure but keeps registration", async () => {
    fake.vault.accounts[0].expiresAt = 0; fake.grant.mockRejectedValue(new TokenError(true));
    await expect(accessToken()).rejects.toThrow("Reconnect");
    expect(fake.vault.accounts[0]).toMatchObject({ clientId: "issued", accessToken: null, refreshToken: null, agentAllowed: false });
  });
  it("preserves credentials on temporary refresh failure", async () => {
    fake.vault.accounts[0].expiresAt = 0; fake.grant.mockRejectedValue(new TokenError(false));
    await expect(accessToken()).rejects.toThrow("retained"); expect(fake.vault.accounts[0].refreshToken).toBe("refresh");
  });
  it("does not infer plan permission from identity alone", async () => {
    fake.vault.accounts[0].scopes = []; await expect(accessToken()).rejects.toThrow("permission");
    expect(fake.grant).not.toHaveBeenCalled();
  });
  it("binds pairing to the VM host, validates nonce and consumes a successful pairing once", async () => {
    const { secret } = await beginPairing("issued");
    const config = await pairingConfiguration(secret); expect(config.hostId).toBe("vm-host");
    await importCredentials(secret, { clientId: "issued", tokens: { access_token: "new", refresh_token: "r", id_token: "id", token_type: "Bearer", expires_in: 3600, scope: PLAN_SCOPE } });
    expect(fake.identity).toHaveBeenCalledWith("id", "issued", config.nonce, "sub");
    expect(fake.vault.hostId).toBe("vm-host"); expect(fake.vault.accounts[0].agentAllowed).toBe(false);
    await expect(pairingConfiguration(secret)).rejects.toThrow();
  });
  it("rejects invalid or expired pairing and mismatched accounts", async () => {
    const { secret } = await beginPairing("issued");
    await expect(pairingConfiguration("wrong")).rejects.toThrow();
    await expect(importCredentials(secret, { clientId: "other", tokens: { access_token: "a", id_token: "id", expires_in: 3600, token_type: "Bearer" } })).rejects.toThrow("changed");
    fake.vault.pairing!.expiresAt = 0; await expect(pairingConfiguration(secret)).rejects.toThrow("expired");
  });
  it("keeps separate registrations even with the same email", async () => {
    fake.vault.accounts.push({ ...account(), clientId: "other", subject: "other-sub" });
    await selectAccount("other"); expect(fake.vault.active).toBe("other"); expect(fake.vault.accounts).toHaveLength(2);
  });
  it("revokes with the issued client, clears credentials and retains identity", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));
    expect(await disconnectAccount()).toEqual({ revoked: true });
    expect(String(fetch.mock.calls[0][1]?.body)).toContain("client_id=issued");
    expect(fake.vault.accounts[0]).toMatchObject({ subject: "sub", clientId: "issued", accessToken: null, refreshToken: null, idToken: null });
  });
  it("reports unconfirmed remote revocation while still disconnecting locally", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network"));
    expect(await disconnectAccount()).toEqual({ revoked: false }); expect(fake.vault.accounts[0].accessToken).toBeNull();
  });
});
