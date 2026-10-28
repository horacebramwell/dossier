import "server-only";
import OpenAI from "openai";
import { accessToken, accountModels } from "../chatgpt-account";
import { collectResponse, inferenceError, RESOURCE, responseBody } from "../chatgpt-contract";
import { AiError } from "../errors";
import { BaseProvider, withJsonSchema, type ChatCall, type ChatAnswer } from "../provider";
import { keyGuardedFetch } from "./guarded-fetch";

/** ChatGPT plan OAuth only. Never uses DOSSIER_AI_KEY, custom URLs, or API billing fallback. */
export class ChatGPTProvider extends BaseProvider {
  readonly kind = "CHATGPT" as const;
  private clientId?: string;
  protected acceptsTemperature() { return false; }
  protected async fetchModels(signal: AbortSignal) { return (await accountModels(signal)).map(m => m.slug); }
  protected async chat(call: ChatCall): Promise<ChatAnswer> {
    call.signal.throwIfAborted();
    const session = await accessToken(call.signal, this.clientId);
    this.clientId = session.clientId;
    const models = await accountModels(call.signal, this.clientId);
    if (!models.some(m => m.slug === call.model)) throw AiError.unknownModel(call.model);
    const { token } = await accessToken(call.signal, this.clientId);
    const client = new OpenAI({ apiKey: token, baseURL: RESOURCE, maxRetries: 0, fetch: keyGuardedFetch() });
    try {
      const stream = await client.responses.create(responseBody({ ...call, system: call.json ? withJsonSchema(call.system, call.json.schema) : call.system }), { signal: call.signal });
      const text = await collectResponse(stream);
      // A switch/disconnect while streaming must not commit a result under another account.
      await accessToken(call.signal, this.clientId);
      return { text, cutOff: false };
    } catch (e) {
      if (e instanceof AiError) throw e;
      if (call.signal.aborted) throw call.signal.reason;
      // Never pass SDK/provider messages to logs: they may contain request/credential data.
      throw inferenceError((e as { status?: number })?.status, (e as { code?: string })?.code);
    }
  }
}
