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

| Layer | Technology |
|---|---|
| Frontend | SvelteKit + Svelte 5 |
| Editor | Fabric.js v7 |
| Rendering | @napi-rs/canvas (Skia) + Sharp |
| Database | PostgreSQL + Drizzle ORM |
| Auth | Better Auth |
| Storage | S3-compatible (MinIO) |
| Deployment | Docker Compose |

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

| Variable | Description |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string |
| `BETTER_AUTH_SECRET` | Session signing secret (generate with `openssl rand -base64 32`) |
| `BETTER_AUTH_URL` | Public app URL for auth callbacks |
| `S3_ENDPOINT` | S3-compatible storage endpoint |
| `S3_ACCESS_KEY` | Storage access key |
| `S3_SECRET_KEY` | Storage secret key |
| `S3_BUCKET` | Storage bucket name |
| `S3_PUBLIC_URL` | Public URL for accessing stored assets |
| `STORAGE_LOCAL` | Set to `true` for local filesystem storage (dev) |
| `PUBLIC_APP_URL` | Public-facing app URL |

## Scripts

```bash
pnpm dev          # Start dev server
pnpm build        # Production build
pnpm preview      # Preview production build
pnpm check        # TypeScript + Svelte checks
pnpm lint         # ESLint + Prettier
pnpm format       # Auto-format code
pnpm db:generate  # Generate migration from schema changes
pnpm db:push      # Push schema to database (dev)
pnpm db:migrate   # Run migrations (production)
pnpm test:e2e     # Run Playwright E2E tests
```

## License

MIT
