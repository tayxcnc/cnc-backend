# CNC Backend: Standing Instructions

**`docs/conventions.md` is the canonical record.** If this file and that one
disagree, that one wins. Do not restate rules here: add them there, each with
its reason, and point at them from here.

The plan and the progress record live in the workspace docs repository, beside
this one, not in it:

- `TAYxCNC/docs/cnc-phase-plan.md`: the approved plan. Architecture decisions
  A1 to A22 (§3), the TAY patterns copied (§11), environments (§12), phases
  and cards (§15), the founder's questions (§18). Read the card before
  starting work that maps to one.
- `TAYxCNC/docs/cnc-progress.md`: what was done, verified and decided, and
  the founder's answers and gate results in their words.

TAY's backend (`TAYxCNC/tayxcnc-backend`) is the pattern source. Copy its
files and adapt them; never import from it and never edit it.

## Where the rules live

Every entry below is a pointer, not a rule. Read the named section of
`docs/conventions.md` before working in that area.

| Topic | Section |
| :--- | :--- |
| What CNC shares with TAY (nothing) | Isolation from TAY |
| Route prefix, REST paths, JSON casing, timestamps | Contract conventions |
| Money fields and the `*Kobo` integer rule | Contract conventions |
| Business dates, `Africa/Lagos`, `wat.ts` | Contract conventions |
| Enums on the wire and the frontend adapters | Contract conventions |
| Pagination shape | Contract conventions |
| Error body, messages kept byte for byte, status codes | Errors |
| `version` and the stale-write 409 | Optimistic concurrency |
| `Idempotency-Key` and its CORS consequence | Idempotency |
| The `CNC_` prefix, the `TAY_` refusal, `check:env-names` | Configuration |
| Deployed and production boot rules, `CNC_WEB_URL` base path | Configuration |
| The Prisma `7.10.0` pin, `prisma-client-js`, the driver adapter, pool size | Data and migrations |
| `migrate dev` local only; `migrate deploy` by hand before the merge | Data and migrations |
| Raw-SQL `now()`, `P2002`, sequences | Data and migrations |
| Staff and customer sign-in, cookies, guards (from C3) | Auth |
| The allowlist, rejection, credentials, methods, headers | CORS |
| Region, service accounts, WIF, `--set-secrets`, placeholders | Infrastructure |
| TAY staging resources CNC work never touches | Infrastructure → Never touched from CNC work |
| Editor tools only, no `sed`/`awk`/`perl` | Making changes to source files |
| Branches, merges, PRs, commit identity, hooks, attribution | Git and workflow |
| Local Postgres, the proxy port, secret handling, clean clones | Local environment |
| What may be called verified | Verification |

**Isolation** is the one thing to internalise rather than look up: CNC and TAY
share no data layer, no auth realm and no environment. CNC never reads a
`TAY_*` variable, and reads nothing unprefixed except `PORT` and `NODE_ENV`.
It is enforced at boot by `CncConfigService` and in CI by `check:env-names`.
The reasoning is under *Isolation from TAY* and *Configuration*.

## Commands

```
npm run start            # watch mode
npm run build            # nest build
npm test                 # jest unit tests
npm run test:e2e         # jest, test/jest-e2e.json (locally: -- --maxWorkers=2)
npm run lint             # eslint --fix
npm run check:env-names  # fails on any env read that is not CNC_*, PORT or NODE_ENV
npm run mock             # prism mock against openapi-cnc.json, port 4014

npm run db:generate      # prisma generate, to generated/cnc-client
npm run db:migrate       # prisma migrate dev, LOCAL ONLY
```

## Layout

```
src/
  main.ts            entry point; boots CncAppModule
  bootstrap.ts       prefix, pipes, helmet, CORS (list from CncConfigService)
  app.module.ts      CncAppModule
  cnc-swagger.ts     Swagger UI and the openapi-cnc.json export (not in production)
  config/            CncConfigService, the only reader of the environment
  common/            money, dates, errors, pagination, request helpers
  health/            liveness and readiness
  prisma/            CncPrismaService, sequences, Prisma error helpers
prisma/
  schema.prisma      generates to generated/cnc-client (gitignored)
  migrations/
test/                e2e specs and create-test-app.ts
scripts/             check-env-names.ts
```

## Working style

- Confirm understanding before generating anything substantial, and flag a
  conflict with the plan rather than silently reconciling it: the plan is
  the founder's approved record, and a quiet deviation is one nobody agreed.
- The rules on verification, secrets, file edits and attribution are in
  `docs/conventions.md`: *Verification*, *Local environment*, *Making changes
  to source files*, *Git and workflow*.

Never add AI attribution or a `Co-authored-by` trailer to a commit message or
a PR description (*Git and workflow*).
