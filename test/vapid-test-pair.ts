import { createECDH } from 'node:crypto';
import type { VapidDetails, VapidKey } from '../src/config/vapid';

/**
 * A real VAPID key pair and contact for tests (C10), never a deployment's.
 *
 * Real, because the boot check derives the public key from the private one
 * (`readVapid`): two arbitrary values of the right lengths, as TAY's tests
 * use, are refused. The private key is a fixed scalar (`Buffer.alloc(32,
 * 7)`), so every run derives the same pair and nothing random lands in a
 * fixture. It signs nothing: unit tests mock `web-push` and e2e replaces the
 * sender (`RecordingPushSender`).
 *
 * Shared by the config specs and the e2e app factory, so the staging and
 * production fixtures and the served public key are one pair.
 */
export function testVapidTrio(): VapidDetails {
  const privateKey = Buffer.alloc(32, 7);
  const curve = createECDH('prime256v1');

  curve.setPrivateKey(privateKey);

  return {
    publicKey: curve.getPublicKey().toString('base64url'),
    privateKey: privateKey.toString('base64url'),
    subject: 'mailto:chefnoroculinarycnc@gmail.com',
  };
}

/** The same trio as the three variables, for an environment fixture. */
export function testVapidEnv(): Record<VapidKey, string> {
  const { publicKey, privateKey, subject } = testVapidTrio();

  return {
    CNC_VAPID_PUBLIC_KEY: publicKey,
    CNC_VAPID_PRIVATE_KEY: privateKey,
    CNC_VAPID_SUBJECT: subject,
  };
}
