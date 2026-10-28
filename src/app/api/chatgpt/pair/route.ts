import { NextRequest, NextResponse } from "next/server";
import { importCredentials, importSchema, pairingConfiguration } from "@/lib/ai/chatgpt-account";
export const runtime = "nodejs";
const headers = { "cache-control": "no-store", "referrer-policy": "no-referrer" };
// No cookies, CORS or browser support. The one-time high-entropy secret is issued only by an authenticated owner action.
export async function GET(request: NextRequest) { return handle(request, false); }
export async function POST(request: NextRequest) { return handle(request, true); }
async function handle(request: NextRequest, importing: boolean) {
  if (request.headers.has("origin") || request.headers.has("sec-fetch-site")) return NextResponse.json({ error: "Use the local sign-in helper." }, { status: 403, headers });
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ") || authorization.length > 100) return NextResponse.json({ error: "Pairing required." }, { status: 401, headers });
  try {
    const secret = authorization.slice(7);
    if (!importing) return NextResponse.json(await pairingConfiguration(secret), { headers });
    if (Number(request.headers.get("content-length")) > 64_000) return NextResponse.json({ error: "Too large." }, { status: 413, headers });
    // Bound streamed bodies too, not just the optional Content-Length header.
    const reader = request.body?.getReader(); let size = 0; const chunks: Uint8Array[] = [];
    if (!reader) throw new Error("Missing body");
    for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > 64_000) { await reader.cancel(); throw new Error("Too large"); } chunks.push(value); }
    const input = importSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    return NextResponse.json(await importCredentials(secret, input), { headers });
  } catch { return NextResponse.json({ error: "Pairing failed or expired. Start again in Settings." }, { status: 400, headers }); }
}
