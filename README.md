# Canvas

**Open-source, self-hostable platform for designing and serving dynamic images via a visual editor and URL API.**

Design templates visually. Bind properties to URL parameters. Serve dynamic images on the fly.

Canvas is what Satori would be if it had a visual editor, and what Bannerbear would be if it were open-source.

## What It Does

1. **Design** a template in the drag-and-drop editor (text, images, shapes)
2. **Bind** any property to a URL parameter (make it dynamic)
3. **Publish** and get a URL that renders images on the fly
4. **Share** — social media crawlers see the dynamic OG image, humans get redirected

```
GET /c/my-template/image.png?title=Hello&avatar=https://...
```

Returns a rendered PNG in ~35ms.

## Use Cases

- **OG images** — dynamic social share cards for every page
- **Social cards** — personalized images for Twitter, LinkedIn, Discord
- **Email banners** — dynamic headers with user data
- **Blog covers** — templated featured images

## Features

- **Visual Editor** — Fabric.js-powered drag-and-drop canvas with layers, properties, undo/redo, and snapping guides
- **Parameter Binding** — toggle any text, image source, or color as dynamic and bind to URL parameters
- **Fast Rendering** — Skia-based server-side rendering (~35ms per image)
- **Multiple Formats** — PNG, JPEG, WebP output via URL extension
- **OG Meta Tags** — share pages serve proper `og:image` tags for social crawlers
- **Configurable Redirects** — human visitors redirected to your destination URL (with parameter substitution)
- **Self-Hostable** — Docker Compose for one-command deployment
- **S3-Compatible Storage** — MinIO, AWS S3, Cloudflare R2, or local filesystem

## Tech Stack

| Layer      | Technology                     |
| ---------- | ------------------------------ |
| Frontend   | SvelteKit + Svelte 5           |
| Editor     | Fabric.js v7                   |
| Rendering  | @napi-rs/canvas (Skia) + Sharp |
| Database   | PostgreSQL + Drizzle ORM       |
| Auth       | Better Auth                    |
| Storage    | S3-compatible (MinIO)          |
| Deployment | Docker Compose                 |

## Repository Layout

Canvas is a **pnpm monorepo**:

```
canvas/
├── apps/
│   └── web/               # The SvelteKit application
│       ├── src/           # App source
│       ├── e2e/           # Playwright tests
│       ├── drizzle/       # Database schema + migrations
│       ├── scripts/       # App-level scripts (sweeps, migrate runner)
│       └── package.json   # name: "web"
├── packages/
│   └── sdk/               # @canvas-images/sdk (TypeScript client) — coming soon
├── scripts/
│   └── deploy.sh          # Production deploy (operates on docker-compose.prod.yml)
├── Dockerfile             # Workspace-aware multi-stage build
├── docker-compose*.yml
├── pnpm-workspace.yaml    # workspaces: apps/*, packages/*
├── tsconfig.base.json     # Shared TypeScript compiler options
├── tsconfig.json          # Root project references
└── package.json           # Delegators: root scripts forward to `pnpm --filter web …`
```

All root-level scripts (`pnpm dev`, `pnpm build`, `pnpm test:unit`, `pnpm db:*`, etc.) delegate to the web workspace. Run them from anywhere — the repo root is the canonical entry point. Aggregated variants exist too: `pnpm build:all`, `pnpm check:all`, `pnpm lint:all`, `pnpm test:all` run across every workspace package.

The single workspace-wide `.env` lives at the repo root and feeds both `vite dev`/`vite build` (via `envDir`) and the drizzle / sweep scripts (via explicit `dotenv` path).

## Quick Start

### Prerequisites

- [Node.js](https://nodejs.org/) 22+
- [pnpm](https://pnpm.io/)
- [Docker](https://docs.docker.com/get-docker/) and Docker Compose

### Development

```bash
# Clone the repo
git clone https://github.com/xarmian/canvas.git
cd canvas

# Copy environment config
cp .env.example .env

# Start PostgreSQL and MinIO
docker compose up -d

# Install dependencies
pnpm install

# Push database schema
pnpm db:push

# Start dev server
pnpm dev
```

Open [http://localhost:5173](http://localhost:5173), sign up, and create your first canvas.

### Production (Docker)

```bash
# Copy and edit environment config
cp .env.example .env
# Edit .env — set POSTGRES_PASSWORD, BETTER_AUTH_SECRET, PUBLIC_APP_URL, etc.

# Build and start everything
docker compose -f docker-compose.prod.yml up -d
```

The app runs migrations on startup and serves on port 3000.

### Render storage management

Baked-render rows (from `POST /api/v1/renders`) persist indefinitely unless the row carries an `expiresAt`. Run the sweep periodically to expire stale rows and reap long-soft-deleted ones:

```bash
# Manual run from the host (dev)
pnpm renders:sweep

# Inside the production container
docker compose -f docker-compose.prod.yml exec app node scripts/renders-sweep.mjs

# Cron (daily at 03:00, prod container)
0 3 * * * docker compose -f /opt/canvas/docker-compose.prod.yml exec -T app \
  node scripts/renders-sweep.mjs >> /var/log/canvas/sweep.log 2>&1
```

Flags:

| Flag                        | Default | Notes                                                                                                                 |
| --------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------- |
| `--mode=expire\|reap\|both` | `both`  | `expire` drops storage bytes + sets `deleted_at`; `reap` hard-deletes rows soft-deleted longer than the grace window. |
| `--dry-run`                 | off     | Logs what would happen, mutates nothing.                                                                              |
| `--max-rows=N`              | `10000` | Cap per invocation. Multiple invocations chip away at larger backlogs.                                                |
| `--reap-after-days=N`       | `30`    | Soft-delete grace before reap hard-deletes.                                                                           |

Output is structured JSON-lines logs (`sweep_start`, `expire_done`, `reap_done`, `sweep_end`). Concurrency-safe via `FOR UPDATE SKIP LOCKED` inside a transaction — two simultaneous invocations partition the work instead of double-processing rows.

### Render event log

Canvas logs every render — public on-the-fly URL requests, baked POSTs, and editor previews — to a narrow `render_events` table. No payload, no IPs in cleartext, just daily-salted hashes. The aggregates surface at [`/account/usage`](#) and [`/admin/usage`](#). One row per render: source (`on-the-fly` / `baked-api` / `baked-app` / `preview`), canvas, owner, requester, API key, format, params hash, cache-hit flag, duration, status code, optional `ip_hash`.

Retention defaults to **30 days**. Configure via `RENDER_EVENTS_RETENTION_DAYS`. A daily cron drops rows past the cutoff:

```bash
# Manual run (dev)
pnpm events:sweep

# Inside the production container
docker compose -f docker-compose.prod.yml exec app node scripts/render-events-sweep.mjs

# Cron (daily at 03:05, prod container) — mirrors the renders:sweep schedule
5 3 * * * docker compose -f /opt/canvas/docker-compose.prod.yml exec -T app \
  node scripts/render-events-sweep.mjs >> /var/log/canvas/events-sweep.log 2>&1
```

Flags:

| Flag           | Default    | Notes                                                                                         |
| -------------- | ---------- | --------------------------------------------------------------------------------------------- |
| `--dry-run`    | off        | Counts rows that _would_ be deleted; mutates nothing.                                         |
| `--max-rows=N` | _(no cap)_ | Cap per invocation. The default drains the whole backlog in one transaction via a CTE delete. |

Output is a one-line summary (`swept N rows older than YYYY-MM-DD (retention=30d, 37ms)`) — machine-greppable for log monitors. Errors go to stderr with a non-zero exit. Concurrency-safe via the same `FOR UPDATE SKIP LOCKED` pattern as `renders:sweep`.

**Disable the log entirely.** Set `RENDER_EVENTS_RETENTION_DAYS=0`. The insertion hooks still record events, but every row is past the cutoff on the next sweep — the table drains to zero and `/account/usage` / `/admin/usage` show empty states. Not recommended unless you actively don't want the log; the analytics surfaces become useless without it.

**Privacy: IP hashing.** Set `RENDER_EVENTS_IP_SALT` to a long random string (e.g. `openssl rand -base64 32`). The server hashes each requester IP as `sha256(salt + ':' + utc_date + ':' + ip)` — the date component rotates daily so even a static salt prevents long-term cross-day IP correlation. If the env is unset, `ip_hash` stays `NULL` for every row and a single warning logs at process start. Rotate the salt by replacing the env value; existing hashes become uncorrelatable from new ones automatically (which is the point).

## URL API

### Render an image

```
GET /c/{slug}/image.png?param1=value1&param2=value2
GET /c/{slug}/image.jpg?...
GET /c/{slug}/image.webp?...
```

Returns the rendered image with the given parameters substituted into the template.

### Share a canvas

```
GET /c/{slug}?param1=value1
```

- **Bots/crawlers** (Twitter, Facebook, Slack, etc.) receive an HTML page with `og:image` meta tags
- **Humans** are redirected to the creator-configured destination URL

## Programmatic Render API

Two ways to drive Canvas from a backend:

1. **URL API** (above) — `GET /c/{slug}/image.png?param=value` for live, template-resolved renders. Best for OG cards where the template can evolve and you want every share to reflect the current design.
2. **Render API** — `POST /api/v1/renders` returns a stable `/i/{shortId}` permalink to a frozen image. Best for backend-generated cards (blog posts, newsletters, transactional emails) where you want the share to never change even if the canvas template is edited.

### Authentication

Create an API key at `/account/api-keys`. The full token is shown ONCE on creation — save it somewhere safe. Use it as a bearer token:

```bash
curl -X POST https://canvas.example.com/api/v1/renders \
  -H "Authorization: Bearer ck_live_xxx" \
  -H "Content-Type: application/json" \
  -d '{
    "canvas": "lp-card",
    "params": { "title": "Hello", "avatar": "https://example.com/me.png" },
    "forwardUrl": "https://example.com/post/123"
  }'
```

Response:

```json
{
	"id": "aB3cDeFgHi",
	"url": "https://canvas.example.com/i/aB3cDeFgHi",
	"imageUrl": "https://canvas.example.com/i/aB3cDeFgHi/image.png",
	"forwardUrl": "https://example.com/post/123",
	"deduplicated": false,
	"createdAt": "2026-05-12T20:00:00Z"
}
```

The returned `url` is the share permalink — social-card crawlers fetch its OG meta, humans see a branded landing with a "Continue to {host}" CTA that forwards to `forwardUrl`.

### Endpoints

| Method | Path                        | Description                                                      |
| ------ | --------------------------- | ---------------------------------------------------------------- |
| POST   | `/api/v1/renders`           | Create a baked render. Scope: `render:create`                    |
| GET    | `/api/v1/renders`           | List your renders (paginated, `?limit=`, `?cursor=`, `?canvas=`) |
| GET    | `/api/v1/renders/{shortId}` | Single render metadata. Scope: `render:read`                     |
| DELETE | `/api/v1/renders/{shortId}` | Soft-delete + free storage. Scope: `render:delete`               |

All endpoints return `429 rate_limited` with `Retry-After`, `X-RateLimit-Limit`, and `X-RateLimit-Remaining: 0` once the per-API-key bucket is exhausted. Successful (2xx) responses additionally carry `X-RateLimit-Reset` (seconds until the bucket refills to its burst cap). POST has its own bucket; the read + delete endpoints share a separate, looser bucket.

### Request fields

| Field           | Type    | Notes                                                                                          |
| --------------- | ------- | ---------------------------------------------------------------------------------------------- |
| `canvas`        | string  | Required. Canvas slug OR uuid. Must be owned by the API key's user. Unpublished canvases work. |
| `params`        | object  | String → string. Validated strictly against the canvas's defined params.                       |
| `format`        | string  | `png` (default), `jpeg`, `webp`, or `avif`.                                                    |
| `forwardUrl`    | string  | Optional. Substituted from `params`, must resolve to `http:` or `https:`.                      |
| `ogTitle`       | string  | Optional override for the share-page OG title.                                                 |
| `ogDescription` | string  | Optional override for the share-page OG description.                                           |
| `dpr`           | 1\|2\|3 | Render at higher DPR (output dimensions scale).                                                |

### Deduplication

Identical POSTs (same `canvas` + `params` + `format` + `dpr` + `forwardUrl` + og text, AND same underlying canvas template + font set + referenced assets) return the existing `shortId` instead of creating a second image — response status is `200` instead of `201`, and `deduplicated: true` in the body. Safe to retry on network errors without flooding storage.

### Limits

- **Per-user storage quota** — `RENDER_QUOTA_PER_USER` (default `1000` rows). 429 once exceeded.
- **Per-API-key rate limits** — `RENDER_API_RATE_LIMIT_PER_MIN` / `_BURST` (defaults 60 / 120 for writes; reads get 5×).
- **Param value length** — capped at 2 000 chars per value; `ogTitle` / `ogDescription` capped at 300 chars.

See `/account/storage` for your utilization.

## Project Structure

```
canvas/
  src/
    lib/
      server/
        db/          # Drizzle schema, migrations
        auth/        # Better Auth config
        storage/     # S3/local storage adapters
      engine/        # Skia rendering engine
      components/
        editor/      # Fabric.js editor components
    routes/
      (app)/         # Authenticated app (dashboard, editor)
      (auth)/        # Login, signup
      api/           # REST API endpoints
      c/[slug]/      # Public canvas URLs + image rendering
  drizzle/
    migrations/      # SQL migration files
  e2e/               # Playwright E2E tests
  static/
    fonts/           # Bundled Inter font
  docker-compose.yml      # Dev services (PostgreSQL + MinIO)
  docker-compose.prod.yml # Production (adds app container)
  Dockerfile              # Multi-stage production build
```

## Environment Variables

See [`.env.example`](.env.example) for all configuration options.

| Variable                        | Description                                                                   |
| ------------------------------- | ----------------------------------------------------------------------------- |
| `DATABASE_URL`                  | PostgreSQL connection string                                                  |
| `BETTER_AUTH_SECRET`            | Session signing secret (generate with `openssl rand -base64 32`)              |
| `BETTER_AUTH_URL`               | Public app URL for auth callbacks                                             |
| `S3_ENDPOINT`                   | S3-compatible storage endpoint                                                |
| `S3_ACCESS_KEY`                 | Storage access key                                                            |
| `S3_SECRET_KEY`                 | Storage secret key                                                            |
| `S3_BUCKET`                     | Storage bucket name                                                           |
| `S3_PUBLIC_URL`                 | Public URL for accessing stored assets                                        |
| `STORAGE_LOCAL`                 | Set to `true` for local filesystem storage (dev)                              |
| `PUBLIC_APP_URL`                | Public-facing app URL                                                         |
| `RENDER_QUOTA_PER_USER`         | Baked-render row cap per user. Default `1000`.                                |
| `RENDER_API_RATE_LIMIT_PER_MIN` | Per-API-key steady rate for `POST /api/v1/renders`. Default `60`.             |
| `RENDER_API_RATE_LIMIT_BURST`   | Per-API-key burst cap. Default `120`. Reads get 5× both values.               |
| `RENDER_EVENTS_RETENTION_DAYS`  | Retention window for `render_events`. Default `30`. `0` disables the log.     |
| `RENDER_EVENTS_IP_SALT`         | Long random salt for hashing requester IPs. Unset = `ip_hash` stays NULL.     |
| `CANVAS_ADMIN_EMAILS`           | Comma-separated allowlist for `/admin/*`. Empty (default) = 403 for everyone. |

## Scripts

```bash
pnpm dev           # Start dev server
pnpm build         # Production build
pnpm preview       # Preview production build
pnpm check         # TypeScript + Svelte checks
pnpm lint          # ESLint + Prettier
pnpm format        # Auto-format code
pnpm db:generate   # Generate migration from schema changes
pnpm db:push       # Push schema to database (dev)
pnpm db:migrate    # Run migrations (production)
pnpm test:unit     # Run vitest unit tests
pnpm test:e2e      # Run Playwright E2E tests
pnpm renders:sweep # Expire + reap baked-render rows (see Operations)
pnpm events:sweep  # Trim render_events past RENDER_EVENTS_RETENTION_DAYS
```

## License

MIT
