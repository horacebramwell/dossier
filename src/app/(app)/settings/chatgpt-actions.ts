"use server";
import { z } from "zod";
import { action, ActionError } from "@/lib/action";
import { AiError } from "@/lib/ai/errors";
import { accountModels, accountStatus, beginPairing, disconnectAccount, selectAccount, setAgentAuthorization } from "@/lib/ai/chatgpt-account";
import { saveSettings } from "@/lib/settings-data";
async function safe<T>(fn: () => Promise<T>) {
  try { return await fn(); } catch (e) { throw new ActionError(e instanceof AiError ? e.message : "ChatGPT connection is unavailable. Check the private credential volume and try again."); }
}
export const chatgptStatus = action(z.object({}), () => safe(accountStatus));
export const chatgptPair = action(z.object({ clientId: z.string().optional() }), ({ clientId }) => safe(() => beginPairing(clientId)));
export const chatgptModels = action(z.object({}), () => safe(() => accountModels(AbortSignal.timeout(20_000))));
export const chatgptSelect = action(z.object({ clientId: z.string() }), ({ clientId }) => safe(async () => { await selectAccount(clientId); await saveSettings({ model: null }); }));
export const chatgptAgent = action(z.object({ allowed: z.boolean() }), ({ allowed }) => safe(() => setAgentAuthorization(allowed)));
export const chatgptDisconnect = action(z.object({}), () => safe(disconnectAccount));
