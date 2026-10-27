/**
 * The largest value a Prisma `Int` (a Postgres `integer`) column holds.
 *
 * Request DTOs that write an `Int` cap their numbers here, so an oversized
 * value is a 400 the caller can act on rather than a 500 from the driver.
 * Shared because every money and count field meets the same limit: in kobo
 * it is ₦21,474,836.47.
 */
export const INT4_MAX = 2_147_483_647;
