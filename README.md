# ABF Reference Proxy

A tiny Node HTTP service that fetches ABF CCF reference URLs and returns their text.

It exists because `https://www.ccf.customs.gov.au/reference/` only negotiates the legacy
`AES128-SHA` (TLS 1.2) cipher, which the Supabase Edge runtime (Deno) refuses with a TLS
handshake failure. This relay uses a Node `https.Agent` that explicitly enables that cipher,
so the Starship `abf-reference-sync` Edge Function can fall back to it when its own direct
`fetch` fails.

It only accepts ABF CCF URLs under `https://www.ccf.customs.gov.au/reference/` and requires
the `x-abf-proxy-secret` request header to match the `ABF_REFERENCE_PROXY_SECRET` env var.

## Run locally

```bash
ABF_REFERENCE_PROXY_SECRET=change-me npm start
# health check:
curl http://localhost:8787/health   # -> {"ok":true}
```

## Deploy to Render

Create a **Web Service** pointed at this repository:

| Setting | Value |
| --- | --- |
| Branch | `main` |
| Root Directory | *(leave blank — this repo's root is the service)* |
| Runtime | Node |
| Build Command | `npm install` |
| Start Command | `npm start` |
| Instance Type | Free |
| Health Check Path | `/health` |

Add one environment variable: `ABF_REFERENCE_PROXY_SECRET` = a strong random secret.

Render injects `PORT`, which the script already honours. The free instance sleeps after
~15 minutes idle, so the first request during a sync pays a ~30–60s cold start — harmless
for a background sync.

## Wire the Supabase Edge Function to it

Use the `https://...onrender.com` URL Render assigns, and the same secret:

```bash
supabase secrets set ABF_REFERENCE_PROXY_URL=https://<your-service>.onrender.com
supabase secrets set ABF_REFERENCE_PROXY_SECRET=<same-strong-secret>
supabase functions deploy abf-reference-sync
```

## Note on the cipher

`AES128-SHA` is deprecated. If a future Node base image drops it from its default OpenSSL
build, pin an older Node in `engines.node` (or add `NODE_OPTIONS=--openssl-legacy-provider`)
until the ABF endpoint is modernised. This is the one fragile dependency of the relay.
