import {
  type Prisma,
  PushMessageStatus,
  SubjectType,
} from '../../generated/cnc-client';

/** A Prisma client or a transaction's, holding what a forget deletes. */
export type PushForgetWriter = Pick<
  Prisma.TransactionClient,
  'customerPushSubscription' | 'staffPushSubscription' | 'pushMessage'
>;

/**
 * Forget a person's devices, and the pushes still waiting for them (C10,
 * D4): every subscription of their realm, and their PENDING and FAILED push
 * rows. Sent and dropped rows stay as the record of what was sent, until
 * the retention sweep.
 *
 * Called by `CncTokenService.revokeAllForSubject` with the client it was
 * given, so it commits with the revocation that caused it: sign-out on
 * every device, a role, email or status change, a password change or
 * reset, a reused refresh token, an account deletion. Revocation means
 * "this session's holder is no longer who the device belongs to", and a
 * push to a device nobody is signed in on, or to a role the person no
 * longer holds, is exactly what must stop. Plain session expiry does not
 * come here, so the 24-hour reminder still reaches a customer who has not
 * opened the app for a week.
 *
 * A plain function with no dependency, so the auth module calls it without
 * importing the push module, and neither module cycles through the other.
 */
export async function forgetPushSubject(
  client: PushForgetWriter,
  subjectType: SubjectType,
  subjectId: string,
): Promise<void> {
  const open = {
    status: { in: [PushMessageStatus.PENDING, PushMessageStatus.FAILED] },
  };

  if (subjectType === SubjectType.CUSTOMER) {
    await client.customerPushSubscription.deleteMany({
      where: { customerId: subjectId },
    });
    await client.pushMessage.deleteMany({
      where: { customerId: subjectId, ...open },
    });
  } else {
    await client.staffPushSubscription.deleteMany({
      where: { staffId: subjectId },
    });
    await client.pushMessage.deleteMany({
      where: { staffId: subjectId, ...open },
    });
  }
}
