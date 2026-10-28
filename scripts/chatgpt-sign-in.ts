/** Minimal local loopback helper. Tokens go directly from this process to the user's VPS over TLS. */
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { authorizationUrl, callbackResult, randomSecret, tokenGrant, verifyIdentity, type Attempt } from "../src/lib/ai/chatgpt-contract";

async function main() {
  const input = createInterface({ input: stdin, output: stdout });
  const serverUrl = new URL((await input.question("Your Dossier HTTPS address: ")).trim());
  if (serverUrl.protocol !== "https:" || serverUrl.username || serverUrl.password || serverUrl.search || serverUrl.hash || serverUrl.pathname !== "/") throw new Error("Use the HTTPS origin of your own Dossier server.");
  const pairing = (await input.question("One-time pairing code from Settings → AI provider: ")).trim();
  input.close();
  async function remote(method: string, body?: unknown) {
    const response = await fetch(new URL("/api/chatgpt/pair", serverUrl), { method, redirect: "error", headers: { Authorization: `Bearer ${pairing}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(45_000) });
    if (!response.ok) throw new Error("Dossier pairing failed. Confirm the address and generate a fresh code in Settings.");
    return response.json();
  }
  const config = await remote("GET");
  let busy = false;
  const server = createServer(async (request, response) => {
    response.setHeader("cache-control", "no-store"); response.setHeader("referrer-policy", "no-referrer");
    response.setHeader("content-security-policy", "default-src 'none'; frame-ancestors 'none'");
    if (request.method !== "GET" || !request.url?.startsWith("/auth/callback?") || busy) { response.writeHead(404).end(); return; }
    const params = new URL(request.url, attempt.redirectUri).searchParams;
    // Reject unsolicited requests without consuming this attempt.
    if (params.get("state") !== attempt.state) { response.writeHead(400).end("Invalid sign-in state."); return; }
    busy = true;
    try {
      const { code, clientId } = callbackResult(params, attempt);
      const tokens = await tokenGrant({ grant_type: "authorization_code", client_id: clientId, code, code_verifier: attempt.verifier, redirect_uri: attempt.redirectUri });
      if (!tokens.id_token) throw new Error("Missing identity token");
      await verifyIdentity(tokens.id_token, clientId, attempt.nonce, attempt.subject);
      const result = await remote("POST", { clientId, tokens });
      response.writeHead(200, { "content-type": "text/plain; charset=utf-8" }).end("ChatGPT connected. Return to Dossier settings. You can close this window.");
      console.log(result.planAllowed ? "Connected. Refresh Dossier settings and choose a model." : "Signed in, but plan usage was not granted. Reconnect to authorize it.");
    } catch {
      response.writeHead(400, { "content-type": "text/plain" }).end("Sign-in failed. Start again in Dossier settings.");
      console.error("Sign-in failed. Generate a fresh pairing code and try again. No credentials were printed or saved locally.");
      process.exitCode = 1;
    } finally { server.close(); clearTimeout(timer); }
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not bind loopback callback");
  const attempt: Attempt = { ...config, state: randomSecret(), verifier: randomSecret(), redirectUri: `http://127.0.0.1:${address.port}/auth/callback` };
  const timer = setTimeout(() => { console.error("Sign-in timed out. Start again in Settings."); server.close(); process.exitCode = 1; }, 5 * 60_000);
  const url = authorizationUrl(attempt);
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "rundll32" : "xdg-open";
  const args = process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
  const browser = spawn(command, args, { stdio: "ignore" });
  browser.on("error", () => { console.error("Could not open the system browser. Start again on a machine with a browser."); server.close(); clearTimeout(timer); });
  console.log("Opening OpenAI sign-in in your browser. Credentials will be transferred only to your Dossier server.");
}
main().catch(() => { console.error("Sign-in could not start. Check your HTTPS address, pairing code and network connection."); process.exitCode = 1; });
