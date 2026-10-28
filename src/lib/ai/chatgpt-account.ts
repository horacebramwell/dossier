import "server-only";
import { createHash } from "node:crypto";
import { AiError } from "./errors";
import { withVault, type ChatGPTAccount } from "./chatgpt-store";
import { equalSecret, inferenceError, openidConfiguration, PLAN_SCOPE, randomSecret, RESOURCE, tokenGrant, tokenSchema, TokenError, verifyIdentity, catalogModels } from "./chatgpt-contract";
import { z } from "zod";

const activeAccount = (vault: { active: string | null; accounts: ChatGPTAccount[] }) => vault.accounts.find(a => a.clientId === vault.active);
export const digestPairing = (secret: string) => createHash("sha256").update(secret).digest("hex");
export async function accountStatus() {
  return withVault(async vault => ({ active: vault.active, accounts: vault.accounts.map(a => ({ clientId: a.clientId, label: `${a.email || "ChatGPT account"} · ${a.clientId.slice(-8)}`, connected: !!a.accessToken, planAllowed: a.scopes.includes(PLAN_SCOPE), agentAllowed: a.agentAllowed })) }));
}
export async function beginPairing(clientId?: string) {
  return withVault(async vault => {
    const selected = clientId ? vault.accounts.find(a => a.clientId === clientId) : undefined;
    if (clientId && !selected) throw AiError.config("Choose a saved ChatGPT account first.");
    const secret = randomSecret();
    vault.pairing = { digest: digestPairing(secret), expiresAt: Date.now() + 5 * 60_000, nonce: randomSecret(), ...(selected ? { clientId: selected.clientId, subject: selected.subject } : {}) };
    return { secret, expiresAt: vault.pairing.expiresAt };
  });
}
function requirePairing(vault: Awaited<Parameters<Parameters<typeof withVault>[0]>[0]>, secret: string) {
  if (!vault.pairing || vault.pairing.expiresAt < Date.now() || !equalSecret(digestPairing(secret), vault.pairing.digest)) throw AiError.config("Pairing code expired or is invalid. Start Continue with ChatGPT again.");
  return vault.pairing;
}
export async function pairingConfiguration(secret: string) {
  return withVault(async vault => {
    const p = requirePairing(vault, secret);
    return { hostId: vault.hostId, nonce: p.nonce, clientId: p.clientId, subject: p.subject };
  });
}
export const importSchema = z.object({ clientId: z.string().min(1).max(300).refine(id => id !== "dynamic_agent_client"), tokens: tokenSchema });
export async function importCredentials(secret: string, input: z.infer<typeof importSchema>) {
  return withVault(async vault => {
    const p = requirePairing(vault, secret);
    if (p.clientId && p.clientId !== input.clientId) throw AiError.config("The ChatGPT registration changed. Start again.");
    if (!input.tokens.id_token) throw AiError.config("OpenAI did not return an ID token.");
    const identity = await verifyIdentity(input.tokens.id_token, input.clientId, p.nonce, p.subject);
    const existing = vault.accounts.find(a => a.clientId === input.clientId);
    if (existing && existing.subject !== identity.subject) throw AiError.config("The ChatGPT account identity changed.");
    const account: ChatGPTAccount = { clientId: input.clientId, ...identity, accessToken: input.tokens.access_token, refreshToken: input.tokens.refresh_token || null, idToken: input.tokens.id_token, expiresAt: Date.now() + input.tokens.expires_in * 1000, scopes: (input.tokens.scope || "").split(/\s+/).filter(Boolean), agentAllowed: false };
    vault.accounts = [...vault.accounts.filter(a => a.clientId !== account.clientId), account];
    vault.active = account.clientId; vault.pairing = null;
    return { planAllowed: account.scopes.includes(PLAN_SCOPE) };
  });
}
export async function selectAccount(clientId: string) {
  return withVault(async vault => { if (!vault.accounts.some(a => a.clientId === clientId)) throw AiError.config("ChatGPT account not found."); vault.active = clientId; });
}
export async function setAgentAuthorization(allowed: boolean) {
  return withVault(async vault => { const account = activeAccount(vault); if (!account?.accessToken || !account.scopes.includes(PLAN_SCOPE)) throw AiError.config("Connect ChatGPT and enable plan usage first."); account.agentAllowed = allowed; });
}
export async function requireAgentAuthorization() {
  const { loadAiConfig } = await import("./config");
  if ((await loadAiConfig()).provider !== "CHATGPT") return;
  const allowed = await withVault(async vault => { const a = activeAccount(vault); return !!a?.agentAllowed && !!a.accessToken && a.scopes.includes(PLAN_SCOPE); });
  if (!allowed) throw AiError.config("Authorize the job agent to use your ChatGPT plan in Settings → AI provider before running it.");
}
export async function accessToken(signal?: AbortSignal, expectedClientId?: string): Promise<{ token: string; clientId: string }> {
  const result = await withVault(async vault => {
    signal?.throwIfAborted();
    const account = activeAccount(vault);
    if (expectedClientId && account?.clientId !== expectedClientId) return { error: "The active ChatGPT account changed. Retry the task with the selected account." };
    if (!account?.accessToken) return { error: "Connect your ChatGPT account in Settings → AI provider." };
    if (!account.scopes.includes(PLAN_SCOPE)) return { error: "ChatGPT plan permission is disabled. Reconnect and authorize plan usage." };
    if (account.expiresAt <= Date.now() + 60_000) {
      if (!account.refreshToken) return { error: "Your ChatGPT session expired. Reconnect in Settings → AI provider." };
      try {
        const tokens = await tokenGrant({ grant_type: "refresh_token", client_id: account.clientId, refresh_token: account.refreshToken });
        if (tokens.id_token) await verifyIdentity(tokens.id_token, account.clientId, undefined, account.subject);
        account.accessToken = tokens.access_token; account.refreshToken = tokens.refresh_token || account.refreshToken;
        account.idToken = tokens.id_token || account.idToken; account.expiresAt = Date.now() + tokens.expires_in * 1000;
        if (tokens.scope !== undefined) account.scopes = tokens.scope.split(/\s+/).filter(Boolean);
      } catch (e) {
        if (e instanceof TokenError && e.terminal) { account.accessToken = account.refreshToken = account.idToken = null; account.agentAllowed = false; return { error: e.message }; }
        throw AiError.config("ChatGPT renewal is temporarily unavailable. Try again later; your connection was retained.");
      }
    }
    if (!account.scopes.includes(PLAN_SCOPE)) return { error: "ChatGPT plan permission was removed. Reconnect to authorize it." };
    return { token: account.accessToken!, clientId: account.clientId };
  });
  if ("error" in result) throw AiError.config(result.error!);
  signal?.throwIfAborted(); return result;
}
export async function accountModels(signal?: AbortSignal, expectedClientId?: string) {
  const { token } = await accessToken(signal, expectedClientId);
  const response = await fetch(`${RESOURCE}/models`, { headers: { Authorization: `Bearer ${token}` }, redirect: "error", cache: "no-store", signal: signal || AbortSignal.timeout(20_000) });
  if (!response.ok) throw inferenceError(response.status);
  return catalogModels(await response.json());
}
export async function disconnectAccount() {
  return withVault(async vault => {
    const account = activeAccount(vault); if (!account) return { revoked: true };
    let revoked = !account.refreshToken;
    if (account.refreshToken) {
      try {
        const { revocation_endpoint } = await openidConfiguration();
        for (let attempt = 0; attempt < 2; attempt++) {
          const result = await fetch(revocation_endpoint, { method: "POST", redirect: "error", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: account.refreshToken, token_type_hint: "refresh_token", client_id: account.clientId }), signal: AbortSignal.timeout(10_000) });
          if (result.ok) { revoked = true; break; }
          if (result.status < 500) break;
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      } catch { /* Clear locally, report unconfirmed remote revocation. */ }
    }
    account.accessToken = account.refreshToken = account.idToken = null; account.agentAllowed = false;
    vault.pairing = null;
    return { revoked };
  });
}
