import { Header } from '@nestjs/common';

/**
 * How long a browser or a shared cache (Vercel's, a proxy's) may keep a
 * public read before asking again: one minute. Long enough that a busy
 * page does not ask the API on every view, short enough that an Owner's
 * price change or new hours reach the website within a minute of the
 * page's own revalidation (C6 gate step 8).
 */
export const PUBLIC_MAX_AGE_SECONDS = 60;

/**
 * How long a photo link in a cached public read stays valid: one hour.
 * The storage's ten-minute default suits a signed-in screen that asks
 * again; a public page may be served from a cache, its own included, for
 * a while after the API answered, and a link that has expired by then
 * shows a broken image.
 */
export const PUBLIC_PHOTO_LINK_TTL_MS = 60 * 60 * 1000;

/**
 * `Cache-Control` for a public read that is the same for every caller and
 * changes only when staff change it (the menu, the business details, the
 * opening hours, the rooms, the ordering settings).
 *
 * A read that depends on the minute it is asked (table availability,
 * order times) is `no-store` instead: a cached "available" is a table
 * someone else has just booked.
 */
export function PublicCache(): MethodDecorator {
  return Header('Cache-Control', `public, max-age=${PUBLIC_MAX_AGE_SECONDS}`);
}
