# mikeandxan-rsvp

RSVP + guest-list backend for [mikeandxan.com](https://mikeandxan.com), Michael & Alexandria's wedding site.

Replaces an earlier Google Sheets / Apps Script backend with a Cloudflare Worker + D1 (SQLite) database — real
guest/household/RSVP rows with real ids, instead of matching people by name or spreadsheet row position.

## Stack

- **Cloudflare Worker** (`src/index.js`) — plain JS, no build step
- **D1** — schema in `migrations/`
- **Resend** — guest confirmation emails (with .ics calendar attachment) + internal notification emails

## Local development

```bash
npm install
npx wrangler d1 migrations apply mikeandxan-rsvp --local
npx wrangler dev --local
```

Local secrets go in `.dev.vars` (gitignored):
```
ADMIN_PASSWORD=your-local-test-password
RESEND_API_KEY=re_...
```

## Deploy

```bash
npx wrangler deploy
```

Secrets on the real deployment are set once via `wrangler secret put ADMIN_PASSWORD` / `RESEND_API_KEY` — never
committed.

## API

One endpoint (`fetch` handles everything), same request/response shapes the frontend (`mikeandxan` repo) expects:

- `GET  ?action=lookup&name=...` — guest-facing household lookup (nickname-aware)
- `GET  ?action=admin&token=...` — staff dashboard data (requires a valid admin session token)
- `POST { action: 'submit', payload }` — records an RSVP, emails the couple + the guest
- `POST { action: 'adminLogin', password }` — password → session token
- `POST { action: 'adminAddGuest', token, payload }` — add a guest to an existing or new household
- `POST { action: 'adminRemoveGuest', token, payload }` — remove a guest

## Seeding

`seed/parse_seed.js` parses a one-time markdown export of the old Google Sheet into SQL insert statements. Not
needed again after the initial migration — kept for reference. The seed files themselves (real guest names/
addresses) are gitignored on purpose and never committed.
