# Releasing

Canvas uses [changesets](https://github.com/changesets/changesets) to version and publish `@canvas-images/sdk` to npm. The web app (`apps/web`) and the example (`examples/nextjs-og-cards`) are marked private and never publish.

## Flow

The release process is driven by `.github/workflows/release.yml`:

1. **Add a changeset** when you make a user-visible change to the SDK:

   ```bash
   pnpm exec changeset
   ```

   Pick the SDK (`@canvas-images/sdk`), choose the bump kind (patch / minor / major), and write a one-line summary. The command writes a `.changeset/<random>.md` file you commit alongside your changes.

2. **Open a PR** with your code change + the changeset file. The PR gets reviewed and merged into `main` as usual.

3. **Release PR auto-opens.** When `main` has pending changesets, the workflow opens (or updates) a "Version Packages" PR that:
   - Consumes every pending changeset.
   - Bumps the version in `packages/sdk/package.json`.
   - Updates `packages/sdk/CHANGELOG.md`.
   - Deletes the consumed changeset files.

4. **Review + merge the release PR.** When it merges, the workflow runs `pnpm changeset publish` which calls `npm publish` per package. Provenance is requested automatically via the `id-token: write` permission + `publishConfig.provenance: true`.

## Requirements

- The `NPM_TOKEN` repo secret must be set to an **automation** token (not granular) with publish rights on the `@canvas-images` scope. Granular tokens don't currently support npm provenance.
- The repo must be public for provenance attestation to work (it is).
- Node 22 + pnpm 10 — pinned in the workflow.

## What gets published

Only `@canvas-images/sdk`. The `.changeset/config.json` `ignore` list excludes `web` and `nextjs-og-cards`. The `files` allowlist in the SDK's `package.json` ships exactly `dist/`, `README.md`, and `LICENSE`.

## First release

The initial `0.1.0` release goes out from the first merge of a "Version Packages" PR that consumes `.changeset/initial-release.md` (which is committed alongside the workflow itself in TASK-230).

## Local sanity check

Before opening a release PR, you can preview what a publish would ship:

```bash
pnpm --filter @canvas-images/sdk build
pnpm --filter @canvas-images/sdk publish --dry-run --no-git-checks
```

This prints the package contents without actually publishing.
