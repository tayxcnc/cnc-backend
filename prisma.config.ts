import 'dotenv/config';
import { defineConfig } from 'prisma/config';

/**
 * Prisma CLI configuration.
 *
 * Prisma 7 moved the datasource URL out of the schema file and into a config
 * file, and made the config file mandatory for every CLI command. One config
 * describes one schema, one migrations directory and one database URL, and
 * this repository has one of each, so this file is discovered automatically
 * and no command needs `--config`.
 *
 * The client at runtime does not read this file. It is for `generate`,
 * `migrate` and `studio` only — the running service builds its own client
 * with a driver adapter in CncPrismaService.
 *
 * `process.env.CNC_DB_URL`, not Prisma's `env()` helper. `env()` throws the
 * moment the config loads if the variable is unset, and the config loads for
 * `prisma generate` too — which runs in CI's lint and build jobs and inside the
 * Docker build, none of which has a database. Reading `process.env` directly
 * leaves generate free to run with no URL, and lets `migrate deploy` fail with
 * Prisma's own "empty URL" message when one is genuinely missing.
 *
 * `dotenv/config` loads `.env`. The CLI no longer loads it on its own.
 *
 * No schema guard. `--schema` overrides the schema named here while the URL
 * and the migrations path stay this file's, so a repository holding two
 * schemas needs a guard refusing a `--schema` that names the other one, or a
 * migration lands in the wrong database. This repository holds one schema,
 * so there is no other one for `--schema` to name.
 */
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: process.env.CNC_DB_URL ?? '',
  },
});
