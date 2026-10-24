/**
 * The C8-4 load test: the till and booking paths under a realistic mix
 * (plan §15 C8-4, §19 risk 1). Plain Node: `fetch` (undici, built into
 * Node 22) and `pg` for the optional connection sampler, so it adds no
 * package. Run with `npm run load:till`; how, where and where never is in
 * `docs/load-testing.md`.
 *
 * The mix, each virtual user looping until the duration ends:
 * - cashiers: open a Restaurant bill, add one to three dishes, send it to
 *   the kitchen, hand it to payment and settle it in cash, reading the
 *   open bills between bills;
 * - receptionists: read the floor, book a table, read the day's bookings;
 * - website guests: read a room's availability and book a table;
 * - pollers: managers reading the bell, the overview and Online Orders,
 *   cashiers reading the bell, their overview and Online Orders, every
 *   `CNC_LOAD_POLL_MS`.
 *
 * Setup signs in as an Owner, creates (or resets) one staff account per
 * virtual user, `load-<role>-<n>@example.com`, and gives each a random
 * password held in memory only. Bookings are made at least 400 days ahead,
 * one table and date each, so they never meet a real evening; they are
 * cancelled at the end. Bills are settled and stay: money records are
 * never deleted.
 *
 * Reads only `CNC_LOAD_*` settings, never a database URL other than the
 * sampler's, which must be a local database (`databaseTarget`).
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { databaseTarget } from '../../prisma/local-database';

interface Settings {
  baseUrls: string[];
  ownerEmail: string;
  ownerPassword: string;
  durationMs: number;
  cashiers: number;
  receptionists: number;
  guests: number;
  pollers: number;
  pollMs: number;
  spoofAddresses: boolean;
  cleanup: boolean;
  samplerUrl: string | undefined;
}

function integer(value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`Not a whole number: ${value}`);
  }

  return parsed;
}

function readSettings(): Settings {
  const ownerEmail = process.env.CNC_LOAD_OWNER_EMAIL ?? '';
  const ownerPassword = process.env.CNC_LOAD_OWNER_PASSWORD ?? '';

  if (ownerEmail === '' || ownerPassword === '') {
    throw new Error(
      'Set CNC_LOAD_OWNER_EMAIL and CNC_LOAD_OWNER_PASSWORD (an Owner whose ' +
        'password is not a temporary one).',
    );
  }

  const durationS = integer(process.env.CNC_LOAD_DURATION_S, 60);

  // An access token lives 15 minutes and this script never refreshes.
  if (durationS < 1 || durationS > 600) {
    throw new Error('CNC_LOAD_DURATION_S must be 1 to 600.');
  }

  return {
    baseUrls: (process.env.CNC_LOAD_BASE_URLS ?? 'http://localhost:3000')
      .split(',')
      .map((url) => url.trim().replace(/\/$/, ''))
      .filter((url) => url !== ''),
    ownerEmail,
    ownerPassword,
    durationMs: durationS * 1000,
    cashiers: integer(process.env.CNC_LOAD_CASHIERS, 4),
    receptionists: integer(process.env.CNC_LOAD_RECEPTIONISTS, 1),
    guests: integer(process.env.CNC_LOAD_GUESTS, 2),
    pollers: integer(process.env.CNC_LOAD_POLLERS, 4),
    pollMs: integer(process.env.CNC_LOAD_POLL_MS, 1000),
    spoofAddresses: process.env.CNC_LOAD_SPOOF_ADDRESSES === 'true',
    cleanup: process.env.CNC_LOAD_CLEANUP !== 'false',
    samplerUrl: process.env.CNC_LOAD_DB_URL || undefined,
  };
}

// ------------------------------------------------------------- the client

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A field of a response body, narrowed at runtime, or a thrown error. */
function text(body: unknown, key: string): string {
  const value = isRecord(body) ? body[key] : undefined;

  if (typeof value !== 'string') throw new Error(`No text field ${key}.`);

  return value;
}

function count(body: unknown, key: string): number {
  const value = isRecord(body) ? body[key] : undefined;

  if (typeof value !== 'number') throw new Error(`No number field ${key}.`);

  return value;
}

function list(body: unknown, key: string): Json[] {
  const value = isRecord(body) ? body[key] : undefined;

  if (!Array.isArray(value)) throw new Error(`No list field ${key}.`);

  return value.filter(isRecord);
}

function record(body: unknown, key: string): Json {
  const value = isRecord(body) ? body[key] : undefined;

  if (!isRecord(value)) throw new Error(`No object field ${key}.`);

  return value;
}

interface Sample {
  ms: number;
  status: number;
}

/** Latencies and statuses by request kind. */
class Stats {
  readonly kinds = new Map<string, Sample[]>();
  unexpected = 0;
  limited = 0;
  failures = 0;
  readonly examples: string[] = [];

  add(kind: string, sample: Sample, expected: readonly number[]): void {
    const samples = this.kinds.get(kind) ?? [];

    samples.push(sample);
    this.kinds.set(kind, samples);

    if (sample.status === 429) {
      this.limited += 1;
    } else if (sample.status === 0) {
      this.failures += 1;
    } else if (!expected.includes(sample.status)) {
      this.unexpected += 1;

      if (this.examples.length < 10) {
        this.examples.push(`${kind} answered ${sample.status}`);
      }
    }
  }
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;

  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
}

class Api {
  private next = 0;

  constructor(
    private readonly settings: Settings,
    readonly stats: Stats,
  ) {}

  /** A caller's address: unique per call when spoofing (local runs only). */
  private address(): string | undefined {
    if (!this.settings.spoofAddresses) return undefined;

    return `10.${[...randomBytes(3)].join('.')}, 10.255.255.1`;
  }

  async call(
    kind: string,
    method: string,
    path: string,
    options: {
      token?: string;
      body?: unknown;
      idempotent?: boolean;
      expected?: readonly number[];
    } = {},
  ): Promise<{ status: number; body: unknown }> {
    const base =
      this.settings.baseUrls[this.next++ % this.settings.baseUrls.length];
    const headers: Record<string, string> = {};
    const address = this.address();

    if (options.token) headers.Authorization = `Bearer ${options.token}`;
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }
    if (options.idempotent) headers['Idempotency-Key'] = randomUUID();
    if (address) headers['X-Forwarded-For'] = address;

    const started = performance.now();

    try {
      const response = await fetch(`${base}/api/v1${path}`, {
        method,
        headers,
        body:
          options.body === undefined ? undefined : JSON.stringify(options.body),
      });
      const raw = await response.text();
      const ms = performance.now() - started;

      this.stats.add(
        kind,
        { ms, status: response.status },
        options.expected ?? [200, 201, 204],
      );

      return {
        status: response.status,
        body: raw === '' ? null : (JSON.parse(raw) as unknown),
      };
    } catch {
      this.stats.add(kind, { ms: performance.now() - started, status: 0 }, []);

      return { status: 0, body: null };
    }
  }
}

// ------------------------------------------------------------------ setup

type Role = 'MANAGER' | 'CASHIER' | 'RECEPTION';

async function signIn(
  api: Api,
  email: string,
  password: string,
): Promise<{ token: string; mustChange: boolean }> {
  const { status, body } = await api.call(
    'setup',
    'POST',
    '/auth/staff/sign-in',
    { body: { email, password } },
  );

  if (status !== 200) {
    throw new Error(`Sign-in for ${email} answered ${status}.`);
  }

  return {
    token: text(body, 'accessToken'),
    mustChange: record(body, 'staff').mustChangePassword === true,
  };
}

/** A load account with a fresh password, signed in. */
async function account(
  api: Api,
  owner: string,
  role: Role,
  n: number,
): Promise<string> {
  const email = `load-${role.toLowerCase()}-${n}@example.com`;
  const created = await api.call('setup', 'POST', '/staff/people', {
    token: owner,
    body: { name: `Load ${role.toLowerCase()} ${n}`, email, role },
    expected: [201, 409],
  });
  let temporary: string;

  if (created.status === 201) {
    temporary = text(created.body, 'temporaryPassword');
  } else {
    const found = await api.call(
      'setup',
      'GET',
      `/staff/people?q=${encodeURIComponent(email)}`,
      { token: owner },
    );
    const id = text(list(found.body, 'data')[0], 'id');
    const reset = await api.call(
      'setup',
      'POST',
      `/staff/people/${id}/reset-password`,
      { token: owner },
    );

    temporary = text(reset.body, 'temporaryPassword');
  }

  const first = await signIn(api, email, temporary);
  const changed = await api.call(
    'setup',
    'POST',
    '/auth/staff/change-password',
    {
      token: first.token,
      body: {
        currentPassword: temporary,
        newPassword: randomBytes(16).toString('hex'),
      },
    },
  );

  return text(changed.body, 'accessToken');
}

interface Table {
  id: string;
  code: string;
  venue: string;
}

/** Today's date in Jos plus `days`, as YYYY-MM-DD. */
function josDate(days: number): string {
  const jos = new Date(Date.now() + 60 * 60 * 1000);

  jos.setUTCDate(jos.getUTCDate() + days);

  return jos.toISOString().slice(0, 10);
}

/** One table and date per booking, from 400 days ahead. */
class Slots {
  private next = 0;

  constructor(
    private readonly tables: Table[],
    private readonly firstDay: number,
  ) {}

  take(): { table: Table; date: string } {
    const k = this.next++;

    return {
      table: this.tables[k % this.tables.length],
      date: josDate(this.firstDay + Math.floor(k / this.tables.length)),
    };
  }
}

// ---------------------------------------------------------- virtual users

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

async function cashier(
  api: Api,
  token: string,
  dishes: string[],
  until: number,
): Promise<number> {
  let settled = 0;

  while (Date.now() < until) {
    const opened = await api.call('till: open bill', 'POST', '/staff/orders', {
      token,
      idempotent: true,
      body: { department: 'RESTAURANT' },
    });

    if (opened.status !== 201) continue;

    const id = text(opened.body, 'id');
    let version = count(opened.body, 'version');
    const lines = 1 + Math.floor(Math.random() * 3);
    let ok = true;

    for (let i = 0; i < lines && ok; i += 1) {
      const dish = dishes[Math.floor(Math.random() * dishes.length)];
      const added = await api.call(
        'till: add line',
        'PUT',
        `/staff/orders/${id}/lines`,
        { token, body: { version, menuItemId: dish, qty: 1 + i } },
      );

      ok = added.status === 200;
      if (ok) version = count(added.body, 'version');
    }

    if (!ok) continue;

    const sent = await api.call(
      'till: send to kitchen',
      'POST',
      `/staff/orders/${id}/confirm`,
      { token, body: { version } },
    );

    if (sent.status !== 200) continue;
    version = count(record(sent.body, 'order'), 'version');

    const handed = await api.call(
      'till: hand to payment',
      'POST',
      `/staff/orders/${id}/payment`,
      { token, body: { version } },
    );

    if (handed.status !== 200) continue;

    const due = count(record(handed.body, 'totals'), 'balanceKobo');
    const paid = await api.call(
      'till: settle',
      'POST',
      `/staff/orders/${id}/settle`,
      {
        token,
        idempotent: true,
        body: {
          version: count(handed.body, 'version'),
          payments: [{ method: 'CASH', amountKobo: due }],
        },
      },
    );

    if (paid.status === 200) settled += 1;

    await api.call(
      'till: open bills',
      'GET',
      '/staff/orders?department=RESTAURANT&state=ACTIVE',
      { token },
    );
  }

  return settled;
}

interface Booked {
  id: string;
  version: number;
}

async function receptionist(
  api: Api,
  token: string,
  slots: Slots,
  until: number,
  booked: Booked[],
): Promise<void> {
  while (Date.now() < until) {
    const { table, date } = slots.take();

    await api.call(
      'reception: floor',
      'GET',
      `/staff/floor?venue=${table.venue}&date=${date}`,
      { token },
    );

    const made = await api.call(
      'reception: book',
      'POST',
      '/staff/reservations',
      {
        token,
        idempotent: true,
        body: {
          tableId: table.id,
          name: 'Load Guest',
          phone: '08000000000',
          email: `load-guest-${randomUUID()}@example.com`,
          party: 2,
          businessDate: date,
          time: '19:00',
        },
      },
    );

    if (made.status === 201) {
      booked.push({
        id: text(made.body, 'id'),
        version: count(made.body, 'version'),
      });
    }

    await api.call(
      'reception: bookings',
      'GET',
      `/staff/reservations?date=${date}`,
      { token },
    );
  }
}

async function guest(
  api: Api,
  slots: Slots,
  until: number,
  booked: { number: string }[],
): Promise<void> {
  while (Date.now() < until) {
    const { table, date } = slots.take();

    await api.call(
      'website: availability',
      'GET',
      `/venues/${table.venue}/availability?date=${date}`,
    );

    const made = await api.call('website: book', 'POST', '/reservations', {
      idempotent: true,
      body: {
        venue: table.venue,
        table: table.code,
        businessDate: date,
        time: '19:00',
        party: 2,
        name: 'Load Guest',
        phone: '0803 123 4567',
        email: `load-web-${randomUUID()}@example.com`,
      },
    });

    if (made.status === 201) booked.push({ number: text(made.body, 'number') });

    // A guest who was refused waits before trying again, as a person would.
    if (made.status === 429) await sleep(1000);
  }
}

async function poller(
  api: Api,
  token: string,
  manager: boolean,
  pollMs: number,
  until: number,
): Promise<void> {
  const who = manager ? 'manager' : 'cashier';

  while (Date.now() < until) {
    await api.call(`poll: ${who} bell`, 'GET', '/staff/notifications', {
      token,
    });
    await api.call(`poll: ${who} overview`, 'GET', '/staff/overview', {
      token,
    });
    await api.call(
      `poll: ${who} online orders`,
      'GET',
      '/staff/online-orders',
      { token },
    );
    await sleep(pollMs);
  }
}

// ---------------------------------------------------------------- sampler

interface Connections {
  max: number;
  mean: number;
  samples: number;
  serverMax: number;
  /** The most non-client backends (parallel workers, autovacuum) seen. */
  workers: number;
}

/** Counts the database's connections every 200 ms (a local database only). */
async function sampleConnections(
  url: string,
  until: () => boolean,
): Promise<Connections> {
  if (databaseTarget(url).kind !== 'local') {
    throw new Error('CNC_LOAD_DB_URL must be a local development database.');
  }

  const client = new Client({ connectionString: url });

  await client.connect();

  try {
    const name = (
      await client.query<{ name: string }>('SELECT current_database() AS name')
    ).rows[0].name;
    const shown = await client.query<{ max_connections: string }>(
      'SHOW max_connections',
    );
    const serverMax = Number(shown.rows[0].max_connections);
    const counts: number[] = [];
    let workers = 0;

    while (!until()) {
      // Client connections only: a parallel query's workers and autovacuum
      // also show the database's name, and hold no pool connection.
      const { rows } = await client.query<{ clients: string; others: string }>(
        "SELECT count(*) FILTER (WHERE backend_type = 'client backend') " +
          'AS clients, ' +
          "count(*) FILTER (WHERE backend_type <> 'client backend') AS others " +
          'FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
        [name],
      );

      counts.push(Number(rows[0].clients));
      workers = Math.max(workers, Number(rows[0].others));
      await sleep(200);
    }

    return {
      max: Math.max(0, ...counts),
      mean: counts.reduce((sum, n) => sum + n, 0) / Math.max(1, counts.length),
      samples: counts.length,
      serverMax,
      workers,
    };
  } finally {
    await client.end();
  }
}

// ------------------------------------------------------------------- main

async function main(): Promise<void> {
  const settings = readSettings();
  const stats = new Stats();
  const api = new Api(settings, stats);

  const owner = await signIn(api, settings.ownerEmail, settings.ownerPassword);

  if (owner.mustChange) {
    throw new Error(
      'The Owner account still has a temporary password. Change it first; ' +
        'this script never changes an Owner password.',
    );
  }

  const tokens = async (role: Role, n: number) => {
    const out: string[] = [];

    for (let i = 1; i <= n; i += 1) {
      out.push(await account(api, owner.token, role, i));
    }

    return out;
  };

  const managerPollers = Math.ceil(settings.pollers / 2);
  const cashierTokens = await tokens(
    'CASHIER',
    Math.max(settings.cashiers, settings.pollers - managerPollers),
  );
  const managerTokens = await tokens('MANAGER', Math.max(1, managerPollers));
  const receptionTokens = await tokens(
    'RECEPTION',
    Math.max(1, settings.receptionists),
  );

  const menu: Json[] = [];

  for (let page = 1; ; page += 1) {
    const { body } = await api.call(
      'setup',
      'GET',
      `/staff/menu?page=${page}&pageSize=100`,
      { token: owner.token },
    );
    const rows = list(body, 'data');

    menu.push(...rows);
    if (menu.length >= count(body, 'total') || rows.length === 0) break;
  }

  const dishes = menu
    .filter(
      (item) =>
        item.department === 'RESTAURANT' &&
        item.active === true &&
        Array.isArray(item.choiceOptions) &&
        item.choiceOptions.length === 0 &&
        typeof item.priceKobo === 'number' &&
        item.priceKobo > 0,
    )
    .map((item) => text(item, 'id'));

  const floor = await api.call('setup', 'GET', '/staff/floor', {
    token: receptionTokens[0],
  });
  const tables = list(floor.body, 'tables')
    .filter(
      (table) => typeof table.capacity === 'number' && table.capacity >= 2,
    )
    .map((table) => ({
      id: text(table, 'id'),
      code: text(table, 'code'),
      venue: text(table, 'venueSlug'),
    }));

  if (dishes.length === 0 || tables.length === 0) {
    throw new Error('No Restaurant dish without options, or no table.');
  }

  // Far from any real evening, and a fresh range per run.
  const slots = new Slots(tables, 400 + Math.floor(Math.random() * 3000));

  // Setup's own requests are not part of the measure.
  stats.kinds.clear();

  const started = Date.now();
  const until = started + settings.durationMs;
  let finished = false;

  // How long this process itself was paused: a stall of the machine the
  // test runs on, which no server timing can be blamed for.
  let lastTick = performance.now();
  let pausedMs = 0;
  const pauses = setInterval(() => {
    const now = performance.now();

    pausedMs = Math.max(pausedMs, now - lastTick - 100);
    lastTick = now;
  }, 100);
  const sampler = settings.samplerUrl
    ? sampleConnections(settings.samplerUrl, () => finished)
    : Promise.resolve(null);

  const staffBookings: Booked[] = [];
  const webBookings: { number: string }[] = [];
  const settledCounts = await Promise.all([
    ...cashierTokens
      .slice(0, settings.cashiers)
      .map((token) => cashier(api, token, dishes, until)),
    ...receptionTokens
      .slice(0, settings.receptionists)
      .map((token) =>
        receptionist(api, token, slots, until, staffBookings).then(() => 0),
      ),
    ...Array.from({ length: settings.guests }, () =>
      guest(api, slots, until, webBookings).then(() => 0),
    ),
    ...Array.from({ length: settings.pollers }, (_, i) =>
      poller(
        api,
        i % 2 === 0
          ? managerTokens[Math.floor(i / 2) % managerTokens.length]
          : cashierTokens[Math.floor(i / 2) % cashierTokens.length],
        i % 2 === 0,
        settings.pollMs,
        until,
      ).then(() => 0),
    ),
  ]);
  const elapsedS = (Date.now() - started) / 1000;

  finished = true;
  clearInterval(pauses);
  const connections = await sampler;

  report(settings, stats, elapsedS, settledCounts, staffBookings, webBookings);
  console.log(
    `The load generator itself was paused for up to ` +
      `${(pausedMs / 1000).toFixed(1)} s (a stall of this machine, not a ` +
      `server timing).`,
  );

  if (connections) {
    const pool = 3 * settings.baseUrls.length;

    console.log(
      `\nDatabase connections (sampled every 200 ms, ${connections.samples} ` +
        `samples): max ${connections.max}, mean ${connections.mean.toFixed(1)}; ` +
        `the pools allow ${pool} (3 per instance × ${settings.baseUrls.length}); ` +
        `this server allows ${connections.serverMax}. At most ` +
        `${connections.workers} other backend(s) (parallel workers, ` +
        `autovacuum) at once.`,
    );
  }

  if (settings.cleanup) {
    await cancelBookings(api, receptionTokens[0], staffBookings, webBookings);
  }
}

async function cancelBookings(
  api: Api,
  token: string,
  staff: Booked[],
  web: { number: string }[],
): Promise<void> {
  let cancelled = 0;

  for (const booking of staff) {
    const { status } = await api.call(
      'cleanup',
      'POST',
      `/staff/reservations/${booking.id}/cancel`,
      { token, body: { version: booking.version } },
    );

    if (status === 200) cancelled += 1;
  }

  for (const { number } of web) {
    const found = await api.call(
      'cleanup',
      'GET',
      `/staff/reservations?q=${number}&all=true`,
      { token },
    );
    const row = list(found.body, 'data').find((r) => r.number === number);

    if (row === undefined) continue;

    const { status } = await api.call(
      'cleanup',
      'POST',
      `/staff/reservations/${text(row, 'id')}/cancel`,
      { token, body: { version: count(row, 'version') } },
    );

    if (status === 200) cancelled += 1;
  }

  console.log(
    `\nCleanup: cancelled ${cancelled} of ${staff.length + web.length} bookings.`,
  );
}

function report(
  settings: Settings,
  stats: Stats,
  elapsedS: number,
  settledCounts: number[],
  staffBookings: Booked[],
  webBookings: { number: string }[],
): void {
  const all = [...stats.kinds.values()].flat();
  const rows = [...stats.kinds.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  );
  const line = (name: string, samples: Sample[]) => {
    const sorted = samples.map((s) => s.ms).sort((a, b) => a - b);

    return (
      name.padEnd(30) +
      String(samples.length).padStart(7) +
      (samples.length / elapsedS).toFixed(1).padStart(9) +
      percentile(sorted, 0.5).toFixed(0).padStart(8) +
      percentile(sorted, 0.95).toFixed(0).padStart(8) +
      percentile(sorted, 0.99).toFixed(0).padStart(8) +
      String(
        samples.filter((s) => s.status >= 400 || s.status === 0).length,
      ).padStart(8)
    );
  };

  console.log(
    `Load test: ${settings.cashiers} cashier(s), ${settings.receptionists} ` +
      `receptionist(s), ${settings.guests} website guest(s), ` +
      `${settings.pollers} poller(s) every ${settings.pollMs} ms, against ` +
      `${settings.baseUrls.length} instance(s), for ${elapsedS.toFixed(1)} s.\n`,
  );
  console.log(
    'request'.padEnd(30) +
      'count'.padStart(7) +
      'per s'.padStart(9) +
      'p50 ms'.padStart(8) +
      'p95 ms'.padStart(8) +
      'p99 ms'.padStart(8) +
      '4xx/5xx'.padStart(8),
  );

  for (const [name, samples] of rows) console.log(line(name, samples));

  console.log(line('all', all));
  console.log(
    `\nBills settled: ${settledCounts.reduce((a, b) => a + b, 0)}. ` +
      `Bookings made: ${staffBookings.length} by Reception, ` +
      `${webBookings.length} from the website.`,
  );
  console.log(
    `Errors: ${stats.unexpected} unexpected status(es), ${stats.failures} ` +
      `failed connection(s); ${stats.limited} refused by a rate limit (429, ` +
      `expected for the website from one address).`,
  );

  for (const example of stats.examples) console.log(`  ${example}`);
}

main().catch((error: unknown) => {
  console.error(
    error instanceof Error ? error.message : 'The load test failed.',
  );
  process.exitCode = 1;
});
