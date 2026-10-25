# CNC Backend

The API for CNC (Chef Noro Culinary), the restaurant, lounge and bar at 7A
Hospital Place, Jos. It serves CNC's website, its customer app ("My Account")
and its staff operations app.

NestJS 11, Prisma 7.10.1 and Postgres 16, deployed to Cloud Run in
`europe-west1`. It is CNC's alone: it shares no database, auth realm or
environment with TAY, and it reads no `TAY_*` variable.

The rules, each with its reason, are in [`docs/conventions.md`](docs/conventions.md).
The plan and progress record are in the workspace docs repository
(`TAYxCNC/docs/cnc-phase-plan.md`, `cnc-progress.md`).

## Requirements

| | |
|---|---|
| Node | 22.x (`engines` in `package.json`) |
| Package manager | npm; `package-lock.json` is committed |
| Database | PostgreSQL 16 (Homebrew locally) |
| Secret scanning | `gitleaks`, used by the pre-commit hook |

## Setup

1. Install dependencies:

   ```bash
   npm ci
   ```

2. Enable the repository's hooks, once per clone:

   ```bash
   git config core.hooksPath .githooks
   ```

   `.git/hooks/` does not travel with a clone, so the hooks are tracked in
   `.githooks/`: a `gitleaks` pre-commit hook and a pre-push hook that refuses
   `main` and `develop`.

3. Create the local role and databases. Homebrew's Postgres superuser is your
   Mac user, so run these as yourself. Generate the password with
   `openssl rand -hex 24` (hex needs no escaping inside a connection string):

   ```bash
   psql -d postgres -c "CREATE ROLE cnc_app LOGIN CREATEDB PASSWORD 'the-generated-password';"
   createdb -O cnc_app cnc_db
   createdb -O cnc_app cnc_test
   ```

   `CREATEDB` is for `prisma migrate dev`'s shadow database, and only local.
   `cnc_db` is your working copy; `cnc_test` takes the rows e2e runs leave
   behind.

4. Copy `.env.example` to `.env` and fill it in an editor. Each variable is
   explained in `.env.example`. Generate `CNC_JWT_SECRET` with
   `openssl rand -hex 32`. Never commit `.env`, and never print it.

5. Generate the Prisma client (it is gitignored, at `generated/cnc-client`)
   and apply the migrations to your local database:

   ```bash
   npx prisma generate
   npm run db:migrate
   ```

   `npm run db:migrate` is `prisma migrate dev`: local only. Staging is
   migrated by hand with `migrate deploy`; see *Data and migrations* in the
   conventions.

6. Seed the reference data and the menu, then the first Owner:

   ```bash
   npm run db:seed
   npm run db:seed:owner
   ```

   `db:seed` writes the settings row, CNC's business details, the two rooms
   and their 23 tables, the 12 customer and 25 staff menu categories, the
   166 menu items and one Bar stock item for each of the 87 Bar items. The
   opening hours come from the migration. It is also Prisma's `seed` key,
   so `npx prisma db seed` runs it.

   `db:seed:owner` creates the first Owner from `CNC_SEED_OWNER_EMAIL` and
   `CNC_SEED_OWNER_PASSWORD` (and the optional `CNC_SEED_OWNER_NAME`). The
   password is temporary: the app asks for a new one at first sign-in. It is
   deliberately not Prisma's `seed` key, so `migrate reset` never creates a
   credential.

   Both are safe to run again: they insert only what is missing and never
   change a row, so a price the Owner changed in the app stays changed, and
   the Owner seed does nothing once any Owner exists. Both refuse any
   database but a local one unless their own flag
   (`CNC_SEED_DATA_ALLOW_REMOTE`, `CNC_SEED_OWNER_ALLOW_REMOTE`) is `true`
   for the run.

   The menu data is copied from `cnc-frontend` (`lib/order/menu.ts`,
   `staff/lib/menu.json`, `docs/staff-id-map.json`) into `prisma/seed-data/`.
   Change the menu in the staff app, not there.

7. Start the API:

   ```bash
   npm run start
   ```

## Health

- Liveness: `GET http://localhost:3000/api/v1/health`
- Readiness, with a database probe: `GET http://localhost:3000/api/v1/health/ready`,
  which answers 200 with `status: "ready"`, `database: "ok"` and
  `service: "cnc"`.

## Tests and checks

```bash
npm test                              # unit tests
npm run test:e2e -- --maxWorkers=2    # e2e, against the database CNC_DB_URL names
npm run lint
npm run check:env-names               # every env read is CNC_*, PORT or NODE_ENV
npm run build
```

Run e2e against `cnc_test`, not your working copy: point `CNC_DB_URL` at
`cnc_test` for the run and apply the migrations to it with
`npx prisma migrate deploy` first. CI runs the same suites against a
throwaway `postgres:16` container.

Outside production, the app writes `openapi-cnc.json` when it boots;
`npm run mock` serves a Prism mock of it on port 4014.

## Where the rules are

- [`docs/conventions.md`](docs/conventions.md): canonical, every rule with
  its reason.
- [`CLAUDE.md`](CLAUDE.md): standing instructions and a topic index into the
  conventions.
