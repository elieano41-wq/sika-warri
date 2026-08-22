// The verification flags: off by default, and failing closed to today's
// behaviour when someone fat-fingers the value.
//
// Amendment E. The flags exist so that turning SMS verification on is a
// configuration change rather than a code change, and so the paths that would
// need it are written and reviewed now rather than bolted on later.
//
// The tests that matter here are about the DEFAULT. A flag that gates whether
// people can use the product must not turn itself on because someone typed "1"
// or "yes" in a dashboard field — and must not turn itself on by being absent.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  vendorVerificationRequired,
  customerVerificationRequired,
  estVerifie,
  blocageVerification,
} from '../supabase/functions/_shared/verification';

describe('both flags are off unless explicitly turned on', () => {
  it('an empty environment requires nothing', () => {
    // A project that has never heard of these behaves exactly as it does today.
    expect(vendorVerificationRequired({})).toBe(false);
    expect(customerVerificationRequired({})).toBe(false);
  });

  it('only the exact string "true" enables them', () => {
    for (const flag of [vendorVerificationRequired, customerVerificationRequired]) {
      expect(flag({ SIKA_REQUIRE_VENDOR_SMS_VERIFICATION: 'true' })
             || flag({ SIKA_REQUIRE_CUSTOMER_SMS_VERIFICATION: 'true' })).toBe(true);
    }
  });

  it('tolerates case and surrounding space, because a dashboard field will have both', () => {
    expect(vendorVerificationRequired({ SIKA_REQUIRE_VENDOR_SMS_VERIFICATION: ' TRUE ' }))
      .toBe(true);
    expect(customerVerificationRequired({ SIKA_REQUIRE_CUSTOMER_SMS_VERIFICATION: 'True' }))
      .toBe(true);
  });

  it('every other truthy-looking value stays OFF', () => {
    // Failing closed to the CURRENT behaviour. Someone typing "1" expecting it to
    // work gets today's product, not a country of locked-out vendors.
    for (const v of ['1', 'yes', 'on', 'oui', 'enabled', 'y', 't', '']) {
      expect(
        vendorVerificationRequired({ SIKA_REQUIRE_VENDOR_SMS_VERIFICATION: v }),
        `"${v}" should not enable the flag`
      ).toBe(false);
    }
  });

  it('the two flags are independent', () => {
    const env = { SIKA_REQUIRE_VENDOR_SMS_VERIFICATION: 'true' };
    expect(vendorVerificationRequired(env)).toBe(true);
    // A vendor requirement must not silently impose a customer one: requiring a
    // customer to receive an SMS before they can DISPUTE a claim would make the
    // dispute path depend on the thing most likely to fail.
    expect(customerVerificationRequired(env)).toBe(false);
  });
});

describe('required is not the same as done', () => {
  it('reads whether verification HAPPENED from the profile, not the flag', () => {
    expect(estVerifie({ phone_verified_at: null })).toBe(false);
    expect(estVerifie({})).toBe(false);
    expect(estVerifie({ phone_verified_at: '2026-08-22T10:00:00Z' })).toBe(true);
  });

  it('lets everything through while the flags are off', () => {
    expect(blocageVerification('vendor', {}, { phone_verified_at: null })).toBeNull();
    expect(blocageVerification('customer', {}, { phone_verified_at: null })).toBeNull();
  });

  it('blocks an unverified vendor once the flag is on', () => {
    const b = blocageVerification(
      'vendor',
      { SIKA_REQUIRE_VENDOR_SMS_VERIFICATION: 'true' },
      { phone_verified_at: null }
    );
    expect(b).not.toBeNull();
    expect(b!.code).toBe('VENDOR_NOT_VERIFIED');
    // French, and it says what to do — the same standard as every other message.
    expect(b!.message).toMatch(/vérifié/i);
    expect(b!.message).toMatch(/Contactez le support/i);
  });

  it('lets a VERIFIED vendor through with the flag on', () => {
    expect(
      blocageVerification(
        'vendor',
        { SIKA_REQUIRE_VENDOR_SMS_VERIFICATION: 'true' },
        { phone_verified_at: '2026-08-22T10:00:00Z' }
      )
    ).toBeNull();
  });

  it('the customer message tells them what will happen next', () => {
    const b = blocageVerification(
      'customer',
      { SIKA_REQUIRE_CUSTOMER_SMS_VERIFICATION: 'true' },
      {}
    );
    expect(b!.message).toMatch(/SMS/);
  });
});

describe('the flags are documented and unset in the repo', () => {
  it('neither flag is turned on anywhere in the codebase', () => {
    // Turning one on is a deliberate act in a dashboard, never a committed
    // default that ships to production because a branch merged.
    const config = readFileSync(
      path.join(process.cwd(), 'supabase', 'config.toml'), 'utf8'
    ).replace(/\r\n/g, '\n');
    expect(config).not.toMatch(/SIKA_REQUIRE_\w+\s*=\s*"?true/i);
  });

  it('the module says what verification would and would not buy', () => {
    // The reasoning has to survive the person who wrote it. Whoever turns this
    // on later needs to know it stops pre-loaded claims and does NOT stop a
    // vendor lying to someone standing in front of them.
    const src = readFileSync(
      path.join(process.cwd(), 'supabase', 'functions', '_shared', 'verification.ts'),
      'utf8'
    ).replace(/\r\n/g, '\n');
    expect(src).toMatch(/WOULD NOT/);
    expect(src).toMatch(/pre-load/i);
  });
});
