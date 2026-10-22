import {
  StaffRole,
  StockLocation,
  StockMovementType,
  WasteReason,
  WasteStatus,
} from '../../generated/cnc-client';
import { INT4_MAX } from '../prisma/int4';
import {
  BAR_WASTE_ONLY_MESSAGE,
  CREATE_QTY_REASON_MESSAGE,
  EDIT_QTY_REASON_MESSAGE,
  KITCHEN_WASTE_ONLY_MESSAGE,
  STORE_WASTE_ONLY_MESSAGE,
} from './waste-messages';
import {
  fitsValueColumn,
  isWasteReason,
  ownLocationProblem,
  qtyReasonProblem,
  statusMove,
  wasteLocationFor,
} from './waste-rules';

describe('waste rules', () => {
  describe('fitsValueColumn', () => {
    it('admits a value an Int holds and refuses one it does not', () => {
      expect(fitsValueColumn(0)).toBe(true);
      expect(fitsValueColumn(INT4_MAX)).toBe(true);
      expect(fitsValueColumn(INT4_MAX + 1)).toBe(false);
      expect(fitsValueColumn(10000 * 250000)).toBe(false);
    });
  });

  describe('wasteLocationFor (the screens’ scope)', () => {
    it('gives each logging role its own location', () => {
      expect(wasteLocationFor(StaffRole.KITCHEN)).toBe(StockLocation.KITCHEN);
      expect(wasteLocationFor(StaffRole.BARTENDER)).toBe(StockLocation.BAR);
      expect(wasteLocationFor(StaffRole.CASHIER)).toBe(StockLocation.BAR);
      expect(wasteLocationFor(StaffRole.STOREKEEPER)).toBe(StockLocation.STORE);
    });

    it('scopes neither managers nor the roles that never log waste', () => {
      expect(wasteLocationFor(StaffRole.OWNER)).toBeUndefined();
      expect(wasteLocationFor(StaffRole.MANAGER)).toBeUndefined();
      expect(wasteLocationFor(StaffRole.RECEPTION)).toBeUndefined();
      expect(wasteLocationFor(StaffRole.WAITER)).toBeUndefined();
    });
  });

  describe('ownLocationProblem (the demo waste.create)', () => {
    it('refuses each role elsewhere with its own sentence', () => {
      expect(ownLocationProblem(StaffRole.KITCHEN, StockLocation.BAR)).toBe(
        KITCHEN_WASTE_ONLY_MESSAGE,
      );
      expect(
        ownLocationProblem(StaffRole.BARTENDER, StockLocation.KITCHEN),
      ).toBe(BAR_WASTE_ONLY_MESSAGE);
      expect(ownLocationProblem(StaffRole.CASHIER, StockLocation.STORE)).toBe(
        BAR_WASTE_ONLY_MESSAGE,
      );
      expect(
        ownLocationProblem(StaffRole.STOREKEEPER, StockLocation.KITCHEN),
      ).toBe(STORE_WASTE_ONLY_MESSAGE);
    });

    it('lets each role log at its own location, and managers anywhere', () => {
      expect(
        ownLocationProblem(StaffRole.KITCHEN, StockLocation.KITCHEN),
      ).toBeNull();
      expect(ownLocationProblem(StaffRole.CASHIER, StockLocation.BAR)).toBe(
        null,
      );
      expect(
        ownLocationProblem(StaffRole.STOREKEEPER, StockLocation.STORE),
      ).toBeNull();

      for (const location of Object.values(StockLocation)) {
        expect(ownLocationProblem(StaffRole.MANAGER, location)).toBeNull();
        expect(ownLocationProblem(StaffRole.OWNER, location)).toBeNull();
      }
    });
  });

  describe('qtyReasonProblem', () => {
    it('waste must be a whole quantity', () => {
      expect(
        qtyReasonProblem(1.5, WasteReason.BURNT, CREATE_QTY_REASON_MESSAGE),
      ).toBe(CREATE_QTY_REASON_MESSAGE);
    });

    it('refuses zero, negatives, text and an Int overflow, in the command’s words', () => {
      for (const qty of [0, -1, '2', null, undefined, INT4_MAX + 1]) {
        expect(
          qtyReasonProblem(qty, WasteReason.SPOILED, EDIT_QTY_REASON_MESSAGE),
        ).toBe(EDIT_QTY_REASON_MESSAGE);
      }
    });

    it('refuses a missing or unknown reason with the same sentence', () => {
      expect(qtyReasonProblem(2, undefined, CREATE_QTY_REASON_MESSAGE)).toBe(
        CREATE_QTY_REASON_MESSAGE,
      );
      expect(qtyReasonProblem(2, 'Burnt', CREATE_QTY_REASON_MESSAGE)).toBe(
        CREATE_QTY_REASON_MESSAGE,
      );
    });

    it('accepts a whole quantity above zero with any of the six reasons', () => {
      for (const reason of Object.values(WasteReason)) {
        expect(isWasteReason(reason)).toBe(true);
        expect(
          qtyReasonProblem(INT4_MAX, reason, CREATE_QTY_REASON_MESSAGE),
        ).toBeNull();
      }
    });
  });

  describe('statusMove (the demo waste.status)', () => {
    it('takes the quantity on reaching Approved', () => {
      expect(statusMove(WasteStatus.PENDING, WasteStatus.APPROVED)).toEqual({
        sign: -1,
        type: StockMovementType.WASTE,
      });
      expect(statusMove(WasteStatus.REJECTED, WasteStatus.APPROVED)).toEqual({
        sign: -1,
        type: StockMovementType.WASTE,
      });
    });

    it('returns it on leaving Approved', () => {
      for (const to of [WasteStatus.PENDING, WasteStatus.REJECTED]) {
        expect(statusMove(WasteStatus.APPROVED, to)).toEqual({
          sign: 1,
          type: StockMovementType.WASTE_APPROVAL_CORRECTION,
        });
      }
    });

    it('moves nothing otherwise', () => {
      expect(statusMove(WasteStatus.APPROVED, WasteStatus.APPROVED)).toBeNull();
      expect(statusMove(WasteStatus.PENDING, WasteStatus.REJECTED)).toBeNull();
      expect(statusMove(WasteStatus.REJECTED, WasteStatus.PENDING)).toBeNull();
    });
  });
});
