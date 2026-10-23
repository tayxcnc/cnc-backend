import { OnlineFulfilmentStatus } from '../../generated/cnc-client';
import {
  activeOnlineOrderItem,
  checkoutAttentionItem,
  docketTimingText,
  newWebDocketItem,
} from './online-bell-items';
import { sendsStatusMail, statusMailKind } from './online-order-mail';

/**
 * The customer's order emails (C7-6) and the online orders' bell items
 * (C7-7): which stage changes email whom, and the items' words.
 */
describe('online order messages', () => {
  describe('statusMailKind', () => {
    it('emails on its way, ready and cancelled, and nothing for the other stages', () => {
      const from = OnlineFulfilmentStatus.PREPARING;

      expect(statusMailKind(OnlineFulfilmentStatus.ON_THE_WAY, from)).toBe(
        'ON_THE_WAY',
      );
      expect(statusMailKind(OnlineFulfilmentStatus.READY, from)).toBe('READY');
      expect(statusMailKind(OnlineFulfilmentStatus.CANCELLED, from)).toBe(
        'CANCELLED',
      );

      for (const status of [
        OnlineFulfilmentStatus.RECEIVED,
        OnlineFulfilmentStatus.PREPARING,
        OnlineFulfilmentStatus.DELIVERED,
        OnlineFulfilmentStatus.COLLECTED,
      ]) {
        expect(
          statusMailKind(status, OnlineFulfilmentStatus.RECEIVED),
        ).toBeNull();
      }
    });

    it('sends nothing when the stage did not change', () => {
      expect(
        statusMailKind(
          OnlineFulfilmentStatus.ON_THE_WAY,
          OnlineFulfilmentStatus.ON_THE_WAY,
        ),
      ).toBeNull();
    });
  });

  describe('sendsStatusMail (Q31)', () => {
    it('follows Order Updates for progress, and always tells a cancellation', () => {
      const off = { prefOrderUpdates: false };
      const on = { prefOrderUpdates: true };

      expect(sendsStatusMail('ON_THE_WAY', on)).toBe(true);
      expect(sendsStatusMail('ON_THE_WAY', off)).toBe(false);
      expect(sendsStatusMail('READY', off)).toBe(false);
      expect(sendsStatusMail('CANCELLED', off)).toBe(true);
    });

    it('emails a guest, who has no switch', () => {
      expect(sendsStatusMail('READY', null)).toBe(true);
    });
  });

  describe('bell items', () => {
    it('gives the Cashier the demo’s active online order item', () => {
      expect(
        activeOnlineOrderItem({
          id: 'o1',
          orderNumber: 'CNCR-000124',
          contactName: 'Ada Okafor',
          fulfilmentStatus: OnlineFulfilmentStatus.RECEIVED,
        }),
      ).toEqual({
        id: 'online:o1',
        title: 'Online Order · Paid',
        detail: 'CNCR-000124 · Ada Okafor',
        page: 'online',
        category: 'Fulfilment',
      });
      expect(
        activeOnlineOrderItem({
          id: 'o1',
          orderNumber: 'CNCR-000124',
          contactName: 'Ada',
          fulfilmentStatus: OnlineFulfilmentStatus.ON_THE_WAY,
        }).title,
      ).toBe('Online Order · Out for Delivery');
    });

    it('names a new web docket by its ref and when it is for, with the ref to fill in', () => {
      // 18:30 UTC is 19:30 in Jos.
      const at = new Date('2026-10-24T18:30:00.000Z');

      expect(
        newWebDocketItem({
          ref: 'KOT-CNCR-000124',
          revision: 2,
          scheduledFor: at,
        }),
      ).toEqual({
        id: 'docket:KOT-CNCR-000124:2',
        title: 'New Web Docket',
        detail: 'KOT-CNCR-000124 · Sat 24 Oct 2026 at 19:30',
        page: 'kitchen',
        category: 'Kitchen',
        ref: 'KOT-CNCR-000124',
      });
      expect(docketTimingText(null)).toBe('As soon as possible');
      // 23:30 UTC on the 24th is 00:30 on the 25th in Jos.
      expect(docketTimingText(new Date('2026-10-24T23:30:00.000Z'))).toBe(
        'Sun 25 Oct 2026 at 00:30',
      );
    });

    it('shows managers a held checkout with the name, total and reason', () => {
      expect(
        checkoutAttentionItem({
          id: 'c1',
          contactName: 'Ada Okafor',
          totalKobo: 2273750,
          attentionReason: 'Paystack verified ₦1.00, not ₦22,737.50.',
        }),
      ).toEqual({
        id: 'attention:c1',
        title: 'Checkout Needs Attention',
        detail:
          'Ada Okafor · ₦22,737.50 · Paystack verified ₦1.00, not ₦22,737.50.',
        page: 'online',
        category: 'Payment',
        ref: 'c1',
      });
    });
  });
});
