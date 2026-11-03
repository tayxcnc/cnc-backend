-- Contact details, batch 2 section 2 (platform fixes plan, wave 0, PR 1;
-- decision P43).
--
-- Data only, and hand-written as a whole: no table, column, index or
-- constraint changes, so `prisma migrate diff --from-config-datasource
-- --to-schema prisma/schema.prisma --script` still prints an empty
-- migration.
--
-- The one Business row is updated only while its phone is still the old
-- number, 0802 218 8797. It is compared as digits, so the `0`, `234` and
-- `+234 (0)` spellings, with spaces, hyphens or brackets, are all found. A
-- number staff have typed in Settings since is theirs: that row is left
-- alone, its social links included.
--
-- On a row that still holds the old number:
-- 1. `phone` becomes 09113500003, which every screen shows as 0911 350 0003.
-- 2. `socialLinks.instagram` becomes CNC's Instagram, only where
--    `socialLinks` is a JSON object. Every other key is kept, and an earlier
--    Instagram link is replaced (batch 2: the new link replaces any found
--    earlier). Anything that is not an object is left as it is: the service
--    already reads it as {}, and merging a key into it would change its
--    shape.
-- 3. `version` moves by one, so a Settings page opened before this ran gets
--    the stale-version 409 instead of saving the old number back. `updatedAt`
--    is stamped in UTC, as Prisma writes it.
--
-- Safe to run twice: after the first run the phone is the new number, so a
-- second run matches no row and changes nothing.
UPDATE "Business"
SET "phone" = '09113500003',
    "socialLinks" = CASE
      WHEN jsonb_typeof("socialLinks") = 'object'
        THEN "socialLinks" || jsonb_build_object(
          'instagram', 'https://www.instagram.com/chefnoroculinary'
        )
      ELSE "socialLinks"
    END,
    "version" = "version" + 1,
    "updatedAt" = now() AT TIME ZONE 'UTC'
WHERE regexp_replace("phone", '[^0-9]', '', 'g') ~ '^(0|234|2340)?8022188797$';
