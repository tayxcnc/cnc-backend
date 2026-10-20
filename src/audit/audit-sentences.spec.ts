import {
  AUDIT_MODULES,
  actionLabel,
  auditModule,
  describeChange,
} from './audit-sentences';

/**
 * The staff app's `lib/audit.ts` on the server. Each case is the demo's
 * rule; the cases marked "server" are where the server's field names
 * (`*Kobo`, `*Bps`, enums, `@db.Date`) decide how a value reads.
 */
describe('auditModule', () => {
  it('files each command family under its screen', () => {
    expect(auditModule('order.settle')).toBe('Point of Sale');
    expect(auditModule('cash.count')).toBe('Point of Sale');
    expect(auditModule('stockitem.create')).toBe('Stock & Requests');
    expect(auditModule('staff.save')).toBe('Staff & Access');
    expect(auditModule('staff.changePassword')).toBe('Staff & Access');
    expect(auditModule('menu.save')).toBe('Menu & Prices');
    expect(auditModule('settings.save')).toBe('Settings');
  });

  it('calls an unknown family Other and an action with no dot System', () => {
    expect(auditModule('nothing.here')).toBe('Other');
    expect(auditModule('Workspace created')).toBe('System');
  });

  it('lists every module a row can carry, once each', () => {
    expect(AUDIT_MODULES).toContain('Point of Sale');
    expect(AUDIT_MODULES).toContain('Other');
    expect(AUDIT_MODULES).toContain('System');
    expect(new Set(AUDIT_MODULES).size).toBe(AUDIT_MODULES.length);
    expect(AUDIT_MODULES).not.toContain('Demo Clock');
  });
});

describe('actionLabel', () => {
  it('uses the staff app labels', () => {
    expect(actionLabel('order.reverse')).toBe('Settlement Reversed');
    expect(actionLabel('menu.save')).toBe('Menu Item Saved');
    expect(actionLabel('staff.resetPassword')).toBe('Password Reset');
  });

  it('spells out an unlabelled command and keeps an action with no dot', () => {
    expect(actionLabel('order.partPay')).toBe('Part Pay');
    expect(actionLabel('Workspace created')).toBe('Workspace created');
  });
});

describe('describeChange', () => {
  it('describes a changed record field by field, hiding bookkeeping', () => {
    expect(
      describeChange(
        { id: 'x', version: 3, name: 'Jollof', active: true, sort: 4 },
        { id: 'x', version: 4, name: 'Party Jollof', active: false, sort: 4 },
      ),
    ).toEqual([
      'Name changed from Jollof to Party Jollof.',
      'Active changed from yes to no.',
    ]);
  });

  it('lists a created record’s fields', () => {
    expect(describeChange(null, { name: 'Rice', minimum: 15 })).toEqual([
      'Name: Rice.',
      'Minimum: 15.',
    ]);
  });

  it('says blank for an empty value and shortens a long one', () => {
    const long = 'x'.repeat(80);

    expect(describeChange({ description: '' }, { description: long })).toEqual([
      `Description changed from blank to ${'x'.repeat(57)}….`,
    ]);
  });

  it('counts lists and calls a nested object updated', () => {
    expect(
      describeChange(
        { choiceOptions: ['A'], socialLinks: {} },
        { choiceOptions: ['A', 'B'], socialLinks: { x: 'y' } },
      ),
    ).toEqual([
      'Choice Options changed from 1 entry to 2 entries.',
      'Social Links changed from updated to updated.',
    ]);
  });

  it('sums up changed order items and lines in one sentence each', () => {
    expect(
      describeChange(
        { items: [{ qty: 1 }], lines: [] },
        { items: [{ qty: 2 }, { qty: 1 }], lines: [{ qty: 1 }] },
      ),
    ).toEqual(['Order items updated (2 lines).', 'Lines updated (1).']);
  });

  it('has a sentence for every change with nothing to list', () => {
    expect(describeChange(null, null)).toEqual([
      'No further details were recorded for this change.',
    ]);
    expect(describeChange('Open', 'Open')).toEqual([
      'Saved with no visible change.',
    ]);
    expect(describeChange(null, 'Open')).toEqual(['Set to Open.']);
    expect(describeChange('Open', null)).toEqual(['Removed.']);
    expect(describeChange('Open', 'Payment')).toEqual([
      'Changed from Open to Payment.',
    ]);
    expect(describeChange({ a: 1 }, { a: 1 })).toEqual([
      'Saved with no visible change.',
    ]);
    expect(describeChange(null, { id: 'x' })).toEqual(['Record created.']);
  });

  it('server: shows *Kobo as naira and drops the suffix from the label', () => {
    expect(
      describeChange({ priceKobo: 250_000 }, { priceKobo: 300_050 }),
    ).toEqual(['Price changed from ₦2,500 to ₦3,000.50.']);
  });

  it('server: shows *Bps as a percentage', () => {
    expect(
      describeChange(
        { vatBps: 750, serviceBps: 0 },
        { vatBps: 800, serviceBps: 250 },
      ),
    ).toEqual([
      'VAT changed from 7.5% to 8%.',
      'Service Charge changed from 0% to 2.5%.',
    ]);
  });

  it('server: shows enum values in words', () => {
    expect(
      describeChange(
        { role: 'MANAGER', printerWidth: 'MM80' },
        { role: 'STOREKEEPER', printerWidth: 'A4' },
      ),
    ).toEqual([
      'Role changed from Manager to Storekeeper.',
      'Printer Width changed from 80mm to A4.',
    ]);
    // Capitals that are not an enum value are left alone.
    expect(describeChange({ note: 'OK' }, { note: 'NO' })).toEqual([
      'Note changed from OK to NO.',
    ]);
  });

  it('server: shows an instant in Jos time, and a business date as the day', () => {
    expect(
      describeChange(
        { closedAt: null, joinedOn: '2026-10-01T00:00:00.000Z' },
        {
          closedAt: '2026-10-21T13:30:00.000Z',
          joinedOn: '2026-10-21T00:00:00.000Z',
        },
      ),
    ).toEqual([
      'Closed At changed from blank to 21 Oct, 14:30.',
      'Joined On changed from 2026-10-01 to 2026-10-21.',
    ]);
  });

  it('server: never describes a credential or a staff record’s id fields', () => {
    expect(
      describeChange(
        { passwordHash: 'a', qrToken: 'b', mustChangePassword: true },
        { passwordHash: 'c', qrToken: 'd', mustChangePassword: false },
      ),
    ).toEqual(['Must Change Password changed from yes to no.']);
    expect(
      describeChange({ staffCategoryId: 'c1' }, { staffCategoryId: 'c2' }),
    ).toEqual(['Staff Category changed from c1 to c2.']);
  });
});
