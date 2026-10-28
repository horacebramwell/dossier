# ChatGPT Account

This fork independently implements OpenAI's published [Sign in with ChatGPT](https://developers.openai.com/siwc/token-sharing-open-source/sign-in) protocol. It uses the existing official `openai` SDK for Responses and `jose` for OIDC verification. It does **not** incorporate the noncommercial-licensed DevKit. Dossier and this integration remain AGPL-3.0-only, with upstream attribution preserved.

## Connect

1. Sign in to Dossier, open **Settings → AI provider**, select **ChatGPT Account**.
2. Click **Continue with ChatGPT**. Download the local helper from that section.
3. On the computer with your browser, with Node.js 22+, run `node ~/Downloads/chatgpt-sign-in.mjs`. Enter your own Dossier HTTPS origin and the one-time pairing code from settings. Inspect the address: credentials will be transferred there. Do not share the pairing code.
4. The helper opens OpenAI authorization, listens only on `127.0.0.1` with `/auth/callback`, validates PKCE/state/nonce and the signed identity, and sends credentials directly to your instance over TLS. Tokens are never printed, saved on the laptop, or routed through browser storage. A normal browser authorization code appears in OpenAI's loopback callback; access/refresh tokens do not.
5. Return to settings, click **I finished signing in · refresh**, choose an account-specific model, and **Test connection**. No models or account access are assumed in advance.

**Reconnect** uses the selected registration's issued client ID and identity. **Add another account** makes a separate registration; labels distinguish registrations even when emails match. Switching accounts clears the selected model: select a model available to the new account. Identity-only authorization is retained, but inference is disabled unless plan permission was granted.

The scheduled job agent and its automatic drafts are blocked until you explicitly enable the authorization checkbox for the selected account. Disconnect and reauthorization reset this permission. Existing non-ChatGPT providers remain available; no failure silently selects one or uses API billing.

**Manage usage** opens ChatGPT Settings → Usage. Eligibility, available models, plan allowances and any separately authorized ChatGPT credits are controlled by OpenAI. This does not guarantee unlimited or free inference. A usage-limit or availability failure stops further AI work in that agent scan. Retry later or explicitly choose a different provider. Interrupted streams are never treated as completed results.

## Docker / personal Dokploy

Build this fork's Dockerfile with target `production`. Keep the existing Postgres and `/data` volumes and all existing environment secrets. The only new mount is:

```yaml
services:
  dossier: # or app in compose.production.yml
    volumes:
      - chatgpt-credentials:/var/lib/dossier-chatgpt
volumes:
  chatgpt-credentials:
```

The image creates this directory for UID 1000. With bind mounts, prepare an owner-only directory owned by UID 1000. `DOSSIER_CHATGPT_DIR` can override the path; **never put it in `/data`, the repository, public assets, or an exported database directory**. Use one app replica with this persistent volume. Cross-process changes and refreshes serialize through a transaction-scoped Postgres advisory lock. Postgres contains no OAuth credentials, host ID or agent consent.

Credentials are AES-256-GCM encrypted, written by atomic rename with `0600` permissions under a `0700` directory, and a local `0600` encryption key is generated on first use. Restrict host/root and volume access. Database and ordinary Dossier exports/backups do not contain these files. Do not include this volume in ordinary server backup policies; if an explicit credential backup is necessary, encrypt and control it separately. Losing it requires reauthorization, not loss of application data. Preserve it across image upgrades/restarts.

Before upgrading a preexisting deployment, take a Postgres dump and retain the old image reference. Apply the normal upstream migrations via `start.sh`; never use `freshVolumes` or delete existing volumes. An additive enum migration introduces CHATGPT without changing existing settings or application records. Preserve the existing HTTPS route and password protection. No remote OAuth callback registration or developer API key is required. The one-time import endpoint accepts only a short-lived bearer pairing capability; browser/CORS requests are refused and it never accepts a session cookie as import authorization.

Build locally: `corepack yarn install --immutable && corepack yarn prisma generate && corepack yarn build`. The build bundles `scripts/chatgpt-sign-in.ts` into the downloadable helper; it is not a separately installed global application.

## Operation and recovery

- Access is renewed near expiry using the saved issued client ID; replacement tokens and scopes are stored together before requests resume. Temporary failures retain credentials; unusable refresh tokens are cleared and require reconnecting.
- **Disconnect** attempts refresh-token revocation at OpenAI's discovered endpoint, then clears local tokens but retains the account/client mapping and stable VM host ID. If remote revocation cannot be confirmed, the UI says so; disconnect the app in ChatGPT Settings as well. Already issued requests may finish remotely; no new requests are authorized after disconnect.
- OpenAI does not push revocation events to Dossier. Authentication failures require reconnecting; a temporary 503 does not erase credentials. Plan limits never trigger a billing fallback.
- Host-specific usage attribution/revocation of transferred sessions is currently limited by OpenAI's [self-hosted VM guide](https://developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms). The VM host ID is preserved on import and used for subsequent local authorization.
- Rolling back code after a schema upgrade may require restoring the matching Postgres dump. Stop the app first, restore into the same database, and use the retained image. Never restore just the old image against an incompatible newer schema. Keep the private credential volume separate from DB rollback; revoke/reconnect if its state is uncertain.
- OAuth/network errors are deliberately generic and never include raw provider messages, token values or authorization URLs. Health stays at `/api/health`. Watch normal Dokploy deployment/application logs for storage or database failures, not credential contents.

## Verification

Focused automated tests cover the OAuth parameter contract, callback/client binding, stream completion and failures, account catalog filtering, encrypted persistence, token rotation/recovery, pairing expiry/replay, permission gating, revocation, provider JSON retry/cancellation and settings UI. Real OpenAI authorization and account-specific résumé/cover-letter generation require the owner's interactive consent; mocked tests are not a substitute for that final live check.
