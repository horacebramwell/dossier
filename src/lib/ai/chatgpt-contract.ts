// Independently implemented from the published SIWC protocol. No DevKit code.
// Shared by the server and the local loopback helper; never imported by browser UI.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { z } from "zod";
import { AiError } from "./errors";

export const ISSUER = "https://auth.openai.com";
export const RESOURCE = "https://api.openai.com/v1";
export const PLAN_SCOPE = "chatgpt.tokens.use.direct";
export const SCOPES = `openid profile email offline_access resource.invoke ${PLAN_SCOPE}`;
export type Attempt = { state: string; nonce: string; verifier: string; redirectUri: string; hostId: string; clientId?: string; subject?: string };
export const randomSecret = () => randomBytes(32).toString("base64url");
export function equalSecret(a: string, b: string): boolean {
  const left = Buffer.from(a); const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
export function authorizationUrl(attempt: Attempt): string {
  const url = new URL(`${ISSUER}/api/accounts/authorize`);
  url.search = new URLSearchParams({ client_id: attempt.clientId || "dynamic_agent_client", ext_agent_host_id: attempt.hostId,
    response_type: "code", prompt: "consent", redirect_uri: attempt.redirectUri, scope: SCOPES, resource: RESOURCE,
    state: attempt.state, nonce: attempt.nonce, code_challenge_method: "S256",
    code_challenge: createHash("sha256").update(attempt.verifier).digest("base64url"),
    ...(attempt.clientId ? {} : { agent_name_hint: "Dossier" }),
  }).toString();
  return url.toString();
}
export function callbackResult(params: URLSearchParams, attempt: Attempt): { code: string; clientId: string } {
  if (params.getAll("state").length !== 1 || !equalSecret(params.get("state") || "", attempt.state)) throw AiError.config("ChatGPT sign-in state did not match. Start again.");
  if (params.has("error")) throw AiError.config("ChatGPT authorization was declined or interrupted. Start again to enable plan usage.");
  const clientId = params.get("client_id") || attempt.clientId;
  if (!clientId || clientId === "dynamic_agent_client" || (attempt.clientId && clientId !== attempt.clientId) || params.getAll("client_id").length > 1) throw AiError.config("ChatGPT registration was incomplete or the client changed. Start again.");
  const code = params.get("code");
  if (!code || params.getAll("code").length !== 1) throw AiError.config("ChatGPT did not return an authorization code.");
  return { code, clientId };
}

const discoverySchema = z.object({ issuer: z.literal(ISSUER), jwks_uri: z.url(), revocation_endpoint: z.url() });
let discovery: Promise<z.infer<typeof discoverySchema>> | undefined;
export async function openidConfiguration() {
  discovery ??= fetch(`${ISSUER}/.well-known/openid-configuration`, { redirect: "error", signal: AbortSignal.timeout(15_000) })
    .then(async r => { if (!r.ok) throw new Error("Discovery unavailable"); return discoverySchema.parse(await r.json()); })
    .then(config => { for (const value of [config.jwks_uri, config.revocation_endpoint]) if (new URL(value).origin !== ISSUER) throw new Error("Unexpected OpenAI discovery host"); return config; })
    .catch(() => { discovery = undefined; throw AiError.config("OpenAI sign-in discovery is unavailable. Try again later."); });
  return discovery;
}
let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;
export async function verifyIdentity(idToken: string, clientId: string, nonce?: string, subject?: string) {
  const config = await openidConfiguration();
  jwks ??= createRemoteJWKSet(new URL(config.jwks_uri));
  try {
    const { payload } = await jwtVerify(idToken, jwks, { issuer: ISSUER, audience: clientId, requiredClaims: ["exp", "sub", "iat"], algorithms: ["RS256"] });
    if ((nonce !== undefined && payload.nonce !== nonce) || (subject && payload.sub !== subject)) throw new Error("Identity mismatch");
    if (payload.azp !== undefined && payload.azp !== clientId) throw new Error("Client mismatch");
    return { subject: payload.sub!, email: typeof payload.email === "string" ? payload.email : null };
  } catch { throw AiError.config("ChatGPT identity could not be verified. Start sign-in again."); }
}
export const tokenSchema = z.object({ access_token: z.string().min(1), refresh_token: z.string().min(1).optional(), id_token: z.string().min(1).optional(), token_type: z.string().refine(v => v.toLowerCase() === "bearer"), expires_in: z.number().positive(), scope: z.string().optional() });
export type Tokens = z.infer<typeof tokenSchema>;
export class TokenError extends Error { constructor(readonly terminal: boolean) { super(terminal ? "ChatGPT session expired or was revoked. Reconnect in Settings → AI provider." : "ChatGPT token renewal is temporarily unavailable. Try again later."); } }
export async function tokenGrant(body: Record<string, string>): Promise<Tokens> {
  const response = await fetch(`${ISSUER}/api/accounts/oauth/token`, { method: "POST", redirect: "error", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ ...body, resource: RESOURCE }), signal: AbortSignal.timeout(20_000) });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    const code = typeof error.error === "string" ? error.error : error.error?.code;
    throw new TokenError(["invalid_grant", "invalid_refresh_token", "token_expired", "refresh_token_expired", "refresh_token_invalidated", "refresh_token_reused"].includes(code));
  }
  return tokenSchema.parse(await response.json());
}
export function responseBody(call: { model: string; system: string; messages: { role: "user" | "assistant"; content: string }[] }) {
  return { model: call.model, instructions: call.system, input: call.messages, store: false as const, stream: true as const };
}
export const catalogModels = (body: unknown) => z.object({ models: z.array(z.object({ slug: z.string(), display_name: z.string(), visibility: z.string() })) }).parse(body).models.filter(m => m.visibility === "list").map(m => ({ slug: m.slug, name: m.display_name }));
export function inferenceError(status?: number, code?: string): AiError {
  if (code === "subscription_sharing_usage_limit_exceeded" || status === 429) return new AiError("rate-limited", "Your ChatGPT plan usage limit was reached. Manage usage in ChatGPT or wait before retrying. No API billing was used.");
  if (status === 503 || code === "subscription_sharing_usage_unavailable" || code === "subscription_sharing_user_unavailable") return new AiError("busy", "ChatGPT plan usage is temporarily unavailable. Try again later; no API billing was used.");
  if (status === 401) return AiError.config("Your ChatGPT authorization is no longer valid. Reconnect in Settings → AI provider.");
  if (status === 403) return AiError.config("ChatGPT plan permission is unavailable. Reconnect and authorize plan usage, or check workspace restrictions.");
  if (status === 404 || code === "model_not_found") return AiError.config("That model is no longer available to this ChatGPT account. Refresh the model picker.");
  return AiError.of("provider");
}
type StreamEvent = { type: string; delta?: unknown; response?: { error?: { code?: string } | null } };
export async function collectResponse(events: AsyncIterable<StreamEvent>): Promise<string> {
  let text = ""; let completed = false;
  for await (const event of events) {
    if (event.type === "response.output_text.delta") text += typeof event.delta === "string" ? event.delta : "";
    if (event.type === "response.failed") throw inferenceError(undefined, event.response?.error?.code);
    if (event.type === "response.incomplete") throw AiError.of("cut-off");
    if (event.type === "error") throw AiError.of("provider");
    if (event.type === "response.completed") completed = true;
  }
  if (!completed) throw new AiError("provider", "ChatGPT's response was interrupted before completion. Retry the task.");
  return text;
}
