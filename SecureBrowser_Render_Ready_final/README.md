# Secure Browser — Render deployment

This is the **same Apple Home Screen Secure Browser** with its custom Secure Search engine, Input Summary, Images / Videos / Maps, saved themes, animated tabs, and Safari fallback. It is now packaged as a **single Render Node.js Web Service**, not a Netlify or Vercel deployment.

## Deploy to Render

1. Unzip this project and upload its files to the **root of a GitHub repository** (`server.js`, `public/`, `package.json`, and `render.yaml` should all be at the repository root).
2. On [Render](https://dashboard.render.com/) choose **New > Blueprint**, select that GitHub repository, and deploy the `render.yaml` blueprint. Alternatively choose **New > Web Service**, runtime **Node**, build command `npm install --omit=dev`, start command `npm start`, and health-check path `/healthz`.
3. Open the assigned `https://your-service.onrender.com` address. The search engine, summary, media endpoints, proxy, and UI are served by the **same domain**.
4. On Apple devices, open that address in Safari and use **Share > Add to Home Screen** for the web app. If you previously installed an older Netlify version, remove its old Home Screen icon and install this new URL.

### Useful URLs for checking deployment

- `/healthz` — returns `{ "ok": true, "service": "secure-browser" }`.
- `/` — Secure Browser start page.
- `/secure-search.html?q=example` — Secure Search UI.
- `/api/search?q=example` — structured search results.
- `/api/suggest?q=exa` — search suggestions.
- `/api/summary?q=why%20is%20the%20sky%20blue` — Input Summary.
- `/api/media?kind=images&q=dogs` — media search.
- `/api/youtube?mode=search&q=cats` — YouTube data when available.
- `/proxy?url=https%3A%2F%2Fexample.org%2F` — proxied sample site.

### Free and paid plans

The bundled `render.yaml` uses the **Free** web-service plan. Render currently spins down Free instances after 15 minutes of inactivity, and the next request can take about a minute to warm them up. For consistently responsive browsing, change the plan to a paid always-on instance in Render. There is no need to buy a plan just to test the project.

### Environment variables (optional)

- `BRAVE_SEARCH_API_KEY` — optional Brave search source for better web results.
- `YOUTUBE_API_KEY` — optional YouTube video and channel metadata.
- `ALLOWED_HOSTS` — optional comma-separated proxy allowed domains. Leave unset for general browsing.
- `PROXY_TIMEOUT_MS` — upstream request timeout, default `12000`.
- `PORT` — Render supplies this; the app listens on `0.0.0.0`.

**Do not commit API keys to the ZIP or repository.** Set them in Render's Environment settings.

### Limits

Render runs the backend as a persistent process and avoids Netlify serverless function constraints. However, it **does not make all websites render like Safari**. Proxied pages are still loaded into an iframe at a different origin; some websites block or break because of their JavaScript, authentication, DRM, or other restrictions. YouTube's Safari opening fallback remains important on iOS.

This is a public-facing proxy endpoint; restrict usage and monitor bandwidth before public promotion. The basic project includes DNS/private-address validation but not production-grade anti-abuse protection.

## Local development

```bash
npm install
npm start
```

Open http://localhost:3000. Run `npm test` for built-in offline tests.

## Changes from Netlify package

- Keeps the original Express `/api/*` and `/proxy` routes, so no serverless function conversion is required.
- Removes unused Netlify functions and `netlify.toml`.
- Adds Render blueprint, health check, `0.0.0.0` port binding, and a Render-compatible Node startup.
- Removes the old Netlify proxy URL fallback. Everything is same-origin on Render.
- Raises proxy response-size cap modestly from ~5.5 MB to 10 MB; upstream timeout defaults to 12 seconds. Both limits protect a memory-constrained service.

Previous feature notes are preserved in `PREVIOUS_RELEASE_NOTES.md`.
