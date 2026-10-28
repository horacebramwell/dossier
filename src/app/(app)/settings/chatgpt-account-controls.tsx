"use client";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { chatgptStatus, chatgptPair, chatgptAgent, chatgptDisconnect, chatgptSelect } from "./chatgpt-actions";

type Status = Extract<Awaited<ReturnType<typeof chatgptStatus>>, { ok: true }>["data"];
export function ChatGPTAccountControls({ onChange }: { onChange: () => void }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [pair, setPair] = useState<{ secret: string; expiresAt: number } | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(async () => { const r = await chatgptStatus({}); if (r.ok) setStatus(r.data); else setMessage(r.error); }, []);
  useEffect(() => { let current = true; void chatgptStatus({}).then(r => { if (!current) return; if (r.ok) setStatus(r.data); else setMessage(r.error); }); return () => { current = false; }; }, []);
  const active = status?.accounts.find(a => a.clientId === status.active);
  const connect = async (clientId?: string) => {
    setBusy(true); const r = await chatgptPair({ clientId }); setBusy(false);
    if (r.ok) { setPair(r.data); setMessage("Run the local helper on the computer with your browser. Enter this address and the one-time pairing code when prompted. The code expires in five minutes."); } else setMessage(r.error);
  };
  return <section aria-label="ChatGPT account connection" className="flex flex-col gap-4 rounded-card border border-line-card p-5">
    <h3 className="font-medium">Sign in with ChatGPT</h3>
    <p className="text-sm text-muted">OAuth credentials stay on your server, never in browser storage or database exports. Plan limits apply. Dossier never falls back to API-key billing.</p>
    {status && status.accounts.length > 0 && <label className="flex flex-col gap-2">ChatGPT account
      <select className="rounded border border-line-card bg-card p-2" value={status.active || ""} disabled={busy} onChange={async e => { setBusy(true); const r = await chatgptSelect({ clientId: e.target.value }); if (!r.ok) setMessage(r.error); else { await refresh(); setPair(null); onChange(); } setBusy(false); }}>
        {status.accounts.map(a => <option key={a.clientId} value={a.clientId}>{a.label}</option>)}
      </select>
    </label>}
    <p role="status">{status ? active?.connected ? `Connected · ${active.planAllowed ? "ChatGPT plan permission enabled" : "Plan usage not authorized"}` : "Not connected" : "Loading account status…"}</p>
    <div className="flex flex-wrap gap-3">
      <Button disabled={busy} onClick={() => void connect(active?.clientId)}>Continue with ChatGPT</Button>
      {active && <Button variant="secondary" disabled={busy} onClick={() => void connect(active.clientId)}>Reconnect</Button>}
      {active && <Button variant="secondary" disabled={busy} onClick={async () => { setBusy(true); const r = await chatgptDisconnect({}); setPair(null); if (r.ok) { setMessage(r.data.revoked ? "Disconnected safely." : "Disconnected locally. Remote revocation was not confirmed. Disconnect Dossier in ChatGPT Settings → Usage."); await refresh(); onChange(); } else setMessage(r.error); setBusy(false); }}>Disconnect</Button>}
      <Button variant="secondary" disabled={busy} onClick={() => void connect()}>Add another account</Button>
      <a className="self-center underline" href="https://chatgpt.com/#settings/Usage" target="_blank" rel="noreferrer">Manage usage</a>
    </div>
    {pair && <div className="flex flex-col gap-3 border-t border-line-card pt-4">
      <a className="underline" href="/chatgpt-sign-in.mjs" download>Download local sign-in helper</a>
      <p className="text-sm">Requires Node.js 22 or newer. Run <code>node ~/Downloads/chatgpt-sign-in.mjs</code>, enter <code>{typeof window === "undefined" ? "your Dossier HTTPS address" : window.location.origin}</code>, then paste the code below into the terminal. Do not share it.</p>
      <code className="break-all rounded border border-line-card p-3 select-all">{pair.secret}</code>
      <Button variant="secondary" disabled={busy} onClick={async () => { await refresh(); setPair(null); setMessage("Account status refreshed."); onChange(); }}>I finished signing in · refresh</Button>
    </div>}
    {active?.connected && active.planAllowed && <label className="flex items-start gap-3 text-sm">
      <input type="checkbox" className="mt-1 size-4" checked={active.agentAllowed} disabled={busy} onChange={async e => { setBusy(true); const r = await chatgptAgent({ allowed: e.target.checked }); if (!r.ok) setMessage(r.error); await refresh(); setBusy(false); }} />
      I expressly authorize Dossier’s job agent, including scheduled scans and automatic drafts, to use this ChatGPT account’s plan. I can withdraw this permission here at any time.
    </label>}
    {message && <p role="status" className="text-sm">{message}</p>}
  </section>;
}
