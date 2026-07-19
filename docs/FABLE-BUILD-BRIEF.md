# Fable Build Brief — Community Dashboard (read this first)

You are building the **Fixer community-management dashboard** into THIS repo
(`hivesync`). Everything you need is already in this repo. Do not go looking
outside it, and do not create anything outside it.

---

## THE HARD RULES (anti-fragmentation — do not break these)

1. **Build into `public/dashboard.html`.** That file already exists — it's the
   operator dashboard ("Hivesync — Dashboard", with **Message Intelligence** and
   **Waitlist** tabs). You are ADDING tabs to it, not replacing it, not starting a
   new page. Extend the existing tab structure.
2. **Only write files inside `hivesync/public/`.** No new top-level folders. No new
   repo. **Never** write to `~/Downloads` or `~/Desktop` or anywhere outside this
   repo. If you think you need a new file, it goes in `public/` (e.g. a `public/js/`
   or `public/css/` you create *inside this repo*), never elsewhere.
3. **Reuse the existing brand CSS** at `public/otto-brand.css` (already linked in
   the repo). Match the existing dashboard's look — same fonts, colors, spacing.
   Do not import a new framework or CDN.
4. **Only call WIRED endpoints.** The API is fixed and documented in
   `docs/fixer-dashboard-endpoint-contract.md`. If an endpoint isn't in that doc,
   it does not exist — build that panel as a disabled "coming soon" stub, do NOT
   invent a route or a fake fetch.
5. **Same-origin, relative paths.** All calls are `/connectors/...` on this same
   server. Never hardcode a host.

If you follow these five rules, nothing fragments and nothing gets lost.

---

## Everything you need is in this repo — read these, in order

| File | What it is / why you need it |
|---|---|
| `docs/fixer-dashboard-endpoint-contract.md` | **THE API CONTRACT.** Every endpoint, request/response, auth, errors. Your source of truth for what to call. |
| `public/dashboard.html` | The existing dashboard you are EXTENDING. Read its tab structure and copy the pattern for new tabs. |
| `public/otto-brand.css` | The brand stylesheet to reuse for a consistent look. |
| `connectors.js` | The backend that answers every `/connectors/*` call. If a response shape is unclear, this is the implementation. Read-only for you — do not edit it. |
| `server.js` | Serves `public/` statically (line ~65) and mounts `connectors.js` (line ~1222). Confirms the dashboard and API share one origin. |
| `docs/integrations-spec.md` | Existing integrations context (background). |

---

## What to build (tabs to add to `public/dashboard.html`)

Each maps to a section of the contract. Build the WIRED ones fully; stub the rest.

- **Channels** — list/add/delete Discord channel routes (webhook per tier). *(§2, WIRED)*
- **Composer** — compose + send a rich embed or plain message now. *(§3, WIRED)*
- **Sources** — manage RSS/news sources. *(§4, WIRED — config only; auto-post runner not built, note it)*
- **Scheduled** — schedule one-shot posts (a live 60s runner fires them). *(§5, WIRED)*
- **Activity** — the recent-sends log feed. *(§6, WIRED)*
- **Command Otto** — create a dispatch job → poll → review the draft → approve to
  publish. Human approves before anything sends. *(§7, WIRED)*
- **Coming soon (stub, disabled):** Moderation, Roles & Onboarding, Leveling,
  Analytics. *(§8 — no backend yet, lay out but disable)*

## Auth (how every call authenticates)

The dashboard holds the master key in memory for the tab and sends it on every
request as `Authorization: Bearer <ADMIN_KEY>` (or `x-admin-key`). A 401 means
"not signed in" — gate the whole UI behind a key-entry field. Never render the key
back, never log it. See §0 of the contract.

## The safety floor the UI must honor (§9)

- Human approves before publish (the Command Otto lane) — never auto-approve.
- No mass-ping controls — mentions are locked server-side; don't build an @everyone toggle.
- Webhook URLs arrive masked; show masked, never try to un-mask.

---

*When done: it's still one page (`public/dashboard.html`) with more tabs, styled with
`public/otto-brand.css`, calling only documented `/connectors/*` routes. That's it.*
