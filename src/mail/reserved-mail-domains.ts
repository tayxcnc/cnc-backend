/**
 * The domains no mailbox can ever be at (RFC 2606 and RFC 6761): the three
 * `example` second-level domains, and the `test`, `example`, `invalid` and
 * `localhost` top-level names, with every subdomain of each.
 */
const RESERVED_SECOND_LEVEL = ['example.com', 'example.net', 'example.org'];
const RESERVED_TOP_LEVEL = ['test', 'example', 'invalid', 'localhost'];

/**
 * Whether `address` is at a reserved domain, so a real provider could only
 * bounce it (C8 review). The load test books under `@example.com`, and
 * people trying staging type `test@example.com`; on a transport that
 * reaches real inboxes each such send would spend CNC's Resend quota and
 * count as a hard bounce against its sending domain.
 */
export function isReservedMailDomain(address: string): boolean {
  const at = address.lastIndexOf('@');

  if (at < 0) return false;

  const domain = address
    .slice(at + 1)
    .trim()
    .toLowerCase()
    .replace(/\.$/, '');
  const topLevel = domain.slice(domain.lastIndexOf('.') + 1);

  return (
    RESERVED_TOP_LEVEL.includes(topLevel) ||
    RESERVED_SECOND_LEVEL.some(
      (reserved) => domain === reserved || domain.endsWith(`.${reserved}`),
    )
  );
}
