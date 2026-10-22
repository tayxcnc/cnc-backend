import {
  StaffRole,
  StockLocation,
  StockRequestStatus,
} from '../../generated/cnc-client';
import { INT4_MAX } from '../prisma/int4';
import {
  isOpenRequest,
  issueProblem,
  requestLocationFor,
  statusAfterIssue,
} from './stock-request-rules';

describe('stock request rules', () => {
  describe('requestLocationFor (the demo request.create)', () => {
    it('sends a Kitchen user’s request to the Kitchen, whatever was sent', () => {
      expect(requestLocationFor(StaffRole.KITCHEN, undefined)).toBe(
        StockLocation.KITCHEN,
      );
      expect(requestLocationFor(StaffRole.KITCHEN, StockLocation.BAR)).toBe(
        StockLocation.KITCHEN,
      );
    });

    it('sends a Bartender’s and a Cashier’s request to the Bar', () => {
      expect(requestLocationFor(StaffRole.BARTENDER, undefined)).toBe(
        StockLocation.BAR,
      );
      expect(requestLocationFor(StaffRole.CASHIER, StockLocation.KITCHEN)).toBe(
        StockLocation.BAR,
      );
    });

    it('lets a manager choose the Kitchen or the Bar, and nothing else', () => {
      expect(requestLocationFor(StaffRole.MANAGER, StockLocation.KITCHEN)).toBe(
        StockLocation.KITCHEN,
      );
      expect(requestLocationFor(StaffRole.OWNER, StockLocation.BAR)).toBe(
        StockLocation.BAR,
      );
      expect(
        requestLocationFor(StaffRole.MANAGER, StockLocation.STORE),
      ).toBeNull();
      expect(requestLocationFor(StaffRole.MANAGER, undefined)).toBeNull();
    });
  });

  it('keeps Pending and Partially Issued requests open, and only those', () => {
    expect(isOpenRequest(StockRequestStatus.PENDING)).toBe(true);
    expect(isOpenRequest(StockRequestStatus.PARTIALLY_ISSUED)).toBe(true);
    expect(isOpenRequest(StockRequestStatus.ISSUED)).toBe(false);
    expect(isOpenRequest(StockRequestStatus.REJECTED)).toBe(false);
  });

  describe('issueProblem (the demo request.issue)', () => {
    const request = { qtyPacks: 3, issuedPacks: 1 };
    const rice = { pack: 'bag', factor: 50 };
    const sentence =
      'Enter a whole number of bags within the remaining request.';

    it.each([1, 2])('accepts %p of the 2 bags still wanted', (qty) => {
      expect(issueProblem(qty, request, rice)).toBeNull();
    });

    it.each([0, -1, 1.5, 3, '2', null, undefined])(
      'refuses %p with the pack named',
      (qty) => {
        expect(issueProblem(qty, request, rice)).toBe(sentence);
      },
    );

    it('refuses packs whose units would not fit an Int column', () => {
      const huge = { qtyPacks: INT4_MAX, issuedPacks: 0 };

      expect(issueProblem(INT4_MAX, huge, { pack: 'crate', factor: 2 })).toBe(
        'Enter a whole number of crates within the remaining request.',
      );
    });
  });

  it('is Issued once every pack is sent, and Partially Issued before', () => {
    expect(statusAfterIssue(3, 3)).toBe(StockRequestStatus.ISSUED);
    expect(statusAfterIssue(3, 1)).toBe(StockRequestStatus.PARTIALLY_ISSUED);
  });
});
