# Netlify deployment

The deployed site is the migrated `v0.1` Gatherly RSVP workspace. The root
`netlify.toml` publishes `v0.1/public` and bundles Functions from
`v0.1/netlify/functions`.

## Required Netlify configuration

Set these as encrypted **Site configuration → Environment variables** (do not
commit a `.env` file):

- `DATABASE_URL`: Neon pooled connection string (`postgresql://...`).
- `SESSION_SECRET`: long random value used to sign/rotate production sessions.
- `NODE_VERSION`: already pinned to `22` in `netlify.toml`; keep the site and
  local validation on the same major version.

Neon must be provisioned separately. Run schema migrations through a controlled
migration job or Neon SQL editor before enabling writes; Functions should not
run migrations during a request. Use a pooled Neon URL for serverless
connections and keep the database private apart from Neon’s supported access.

## Function contract

`/.netlify/functions/api` is the API entry point. `/api/*` is redirected to it
before the catch-all SPA redirect. The adapter in
`netlify/functions/_shared/backend.mjs` delegates to the hosted v0.1 handler,
which exports `createHandler({ sql, env })`, returns a Netlify
`(event, context) => response` handler, uses parameterized SQL, and persists
API data in Neon. It never imports or copies `v0.1/data/gatherly.sqlite`.

## Build and verification

```sh
npm ci
npm run build
npm run validate:deployment
```

The build is intentionally a validation-only static build: there is no bundler
or generated output to maintain. Netlify bundles Functions independently.

## Rollback and operational notes

Disable the production deploy or restore the previous Netlify deploy if the
health check or API smoke tests fail. Keep database migrations backward
compatible with the previous deploy, and rotate `SESSION_SECRET` deliberately
because changing it invalidates active sessions.
