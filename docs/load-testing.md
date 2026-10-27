# Load testing the till and booking paths (C8-4)

`npm run load:till` runs `scripts/load/till-and-booking.ts`: several
cashiers opening, filling, sending and settling bills; Reception reading
the floor and booking; website guests reading availability and booking;
managers and cashiers polling the bell, the overview and Online Orders. It
prints, for each kind of request, the count, rate, p50, p95, p99 and
refusals, then the totals, the errors, how long the load generator itself
was paused, and (on a local database only) the database connections
against the pools' allowance.

The rules it follows are in `docs/conventions.md` under *Load testing*.

## What it writes

- One staff account per virtual user, `load-<role>-<n>@example.com`
  (cashier, manager, reception), created by the Owner the first time and
  reset on later runs. Each password is random and kept in memory only.
- Bills, dockets and cash payments, settled. They stay: money records are
  never deleted, so they appear in that day's reports.
- Bookings at least 400 days ahead, one table and date each, cancelled at
  the end (`CNC_LOAD_CLEANUP=false` keeps them).
- **No email.** Every booking queues a confirmation and every cancel a
  cancellation, to `load-guest-…@example.com` and `load-web-…@example.com`.
  `example.com` is a reserved domain that can never receive mail, so on
  staging (Resend) the outbound queue gives each up unsent, with no
  Resend call, no attempt spent and no bounce against CNC's sending
  domain (`isReservedMailDomain`). Locally the recording transport sends
  nothing anyway, so the local figures include no mail send, and neither
  will staging's for these addresses.

Between steps, a virtual user whose step was refused or failed waits for
the server's `Retry-After` (2 s on the busy database's 503), or a second,
before its next step. The summary counts these waits apart.

## Settings

| Variable | Default | Meaning |
| :--- | :--- | :--- |
| `CNC_LOAD_BASE_URLS` | `http://localhost:3000` | API origins, comma separated; requests go to each in turn. Only `localhost`, `127.0.0.1`, `[::1]` and `https://api-cnc-staging.tayxcnc.com` are accepted; any other host, production included, is refused before a request is sent |
| `CNC_LOAD_CONFIRM_STAGING` | none | Must be exactly `api-cnc-staging.tayxcnc.com` for a staging origin to be accepted |
| `CNC_LOAD_OWNER_EMAIL`, `CNC_LOAD_OWNER_PASSWORD` | none | An Owner whose password is not temporary; never changed by the script |
| `CNC_LOAD_DURATION_S` | `60` | 1 to 600 (an access token lives 15 minutes) |
| `CNC_LOAD_CASHIERS`, `CNC_LOAD_RECEPTIONISTS`, `CNC_LOAD_GUESTS`, `CNC_LOAD_POLLERS` | `4`, `1`, `2`, `4` | Virtual users of each kind |
| `CNC_LOAD_POLL_MS` | `1000` | Pause between a poller's rounds (the screens poll every 10 to 60 s) |
| `CNC_LOAD_SPOOF_ADDRESSES` | off | `true` sends a fresh `X-Forwarded-For` per request: **local runs only** (refused with a staging origin), so the per-address limits do not stop the website guests |
| `CNC_LOAD_DB_URL` | none | A **local** database to sample connections from; refused unless local |
| `CNC_LOAD_CLEANUP` | on | `false` keeps the bookings |

## Locally

On a throwaway database, never `cnc_db` or `cnc_test`: create one, run
`npx prisma migrate deploy`, `npm run db:seed` and `npm run db:seed:owner`
with `CNC_DB_URL` pointing at it, change the seeded Owner's temporary
password once, start one or two `node dist/main` processes on their own
ports with that `CNC_DB_URL`, then run the script with
`CNC_LOAD_SPOOF_ADDRESSES=true` and `CNC_LOAD_DB_URL` set to the same
database. Drop the database afterwards.

## Against CNC staging (the founder, with TAY idle)

Never run this against staging without these steps. CNC staging shares the
db-f1-micro instance with TAY (about 25 connections; plan §19, risk 1):
TAY alone can open 40, so a load test while TAY is busy can take both down.

1. Run this only once the C8 backend is live on CNC staging: an earlier
   revision would send every booking's and cancel's email through Resend
   to `example.com`, hundreds of hard bounces from CNC's sending domain.
   Choose a time when nobody is using TAY staging or CNC staging, and say
   so to anyone who might.
2. In the Cloud Run console, check that `tayxcnc-tay-staging` shows no
   requests in the last few minutes (TAY idle).
3. In the Cloud SQL console, open `tayxcnc-staging-pg` → Monitoring, and
   keep the active connections chart open.
4. In a terminal in `cnc-backend`, type the Owner's password without it
   being shown or stored:
   `read -s CNC_LOAD_OWNER_PASSWORD && export CNC_LOAD_OWNER_PASSWORD`
5. Run a small first pass:
   `CNC_LOAD_BASE_URLS=https://api-cnc-staging.tayxcnc.com CNC_LOAD_CONFIRM_STAGING=api-cnc-staging.tayxcnc.com CNC_LOAD_OWNER_EMAIL=<your Owner email> CNC_LOAD_CASHIERS=2 CNC_LOAD_POLLERS=2 CNC_LOAD_DURATION_S=60 npm run load:till`
   Do not change the host: the script refuses any other one.
   Do not set `CNC_LOAD_SPOOF_ADDRESSES` or `CNC_LOAD_DB_URL`. The website
   guests share your one address, so some of their bookings are refused
   with 429 after the first 30: that is the limit working, and the summary
   counts them apart from errors.
6. Watch the connections chart. If it nears 25, or the summary shows
   errors, press Ctrl-C and stop there.
7. If the first pass is clean, run the default mix (`CNC_LOAD_CASHIERS=4`,
   `CNC_LOAD_POLLERS=4`) once more.
8. Afterwards, in the staff app's Staff & Access, deactivate the
   `load-…@example.com` accounts, and expect that day's Sales and Payments
   Received to include the test bills.
9. Send the two printed tables and the connections chart's peak.

Unset the password with `unset CNC_LOAD_OWNER_PASSWORD` when done.
