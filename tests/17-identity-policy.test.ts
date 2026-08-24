// Phone normalisation and PIN policy.
//
// Not one of the numbered acceptance tests, but the phone number IS the
// identity in this product, so a normalisation bug does not produce a tidy
// error — it produces two accounts for one person, each holding a separate
// balance at the same shop, with the customer able to see only one of them.

import { describe, it, expect } from 'vitest';
import {
  normaliseMsisdn,
  authEmailFor,
  checkPin,
  pinLengthFor,
  PIN_LENGTH,
  PIN_LENGTHS_ACCEPTED,
  NormalisationError,
} from '../supabase/functions/_shared/identity.ts';

describe('phone normalisation', () => {
  it('accepts a bare local 10-digit number', () => {
    expect(normaliseMsisdn('0701020304')).toBe('2250701020304');
  });

  it('accepts every spelling a human might type', () => {
    // All of these are one person. If any produced a different result, they
    // would end up with two balances at the same vendor.
    const spellings = [
      '0701020304',
      '07 01 02 03 04',
      '07-01-02-03-04',
      '07.01.02.03.04',
      '+225 07 01 02 03 04',
      '+2250701020304',
      '00225 0701020304',
      '2250701020304',
      '  0701020304  ',
      '(07) 01 02 03 04',
    ];
    for (const s of spellings) {
      expect(normaliseMsisdn(s)).toBe('2250701020304');
    }
  });

  it('accepts each valid Ivorian mobile prefix', () => {
    for (const prefix of ['01', '05', '07', '25', '27']) {
      expect(normaliseMsisdn(`${prefix}01020304`)).toBe(`225${prefix}01020304`);
    }
  });

  it('rejects a landline-style or unknown prefix', () => {
    expect(() => normaliseMsisdn('0901020304')).toThrow(NormalisationError);
    expect(() => normaliseMsisdn('0901020304')).toThrow(/mobile ivoirien/);
  });

  it('rejects the wrong number of digits', () => {
    expect(() => normaliseMsisdn('070102030')).toThrow(/10 chiffres/);
    expect(() => normaliseMsisdn('07010203045')).toThrow(/10 chiffres/);
  });

  it('rejects empty and non-numeric input', () => {
    expect(() => normaliseMsisdn('')).toThrow(/requis/);
    expect(() => normaliseMsisdn('   ')).toThrow(/requis/);
    expect(() => normaliseMsisdn('abcdefghij')).toThrow(/invalide/);
  });

  it('carries a machine-readable code alongside the French message', () => {
    try {
      normaliseMsisdn('0901020304');
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(NormalisationError);
      expect((err as NormalisationError).code).toBe('PHONE_NOT_MOBILE');
    }
  });

  it('builds the synthetic auth email', () => {
    expect(authEmailFor('2250701020304')).toBe('2250701020304@id.sikawarri.app');
  });
});

describe('PIN policy — one length, for everyone', () => {
  // ==========================================================================
  // THIS BLOCK USED TO ASSERT TWO LENGTHS: 6 for a vendor, 4 for a customer.
  //
  // That was not a policy about credentials. The auth password is derived from
  // the PIN, so two lengths meant one phone number could not hold both halves
  // of the app — and register/index.ts refused the second outright. The visible
  // consequence was that an ordinary person could not write down a debt
  // somebody owed THEM without opening a business-shaped account.
  //
  // Six was chosen over four because the 4-digit PIN was justified in the spec
  // by "exposure is capped at 3 000 F per vendor by design". That cap was a
  // property of being a customer — of never holding anyone else's money. One
  // account type removes the cap, so it removes the justification.
  //
  // Every example below is therefore six digits. The four-digit ones were not
  // deleted for tidiness: at four digits every one of them now returns
  // PIN_WRONG_LENGTH before the pattern check it was written to exercise, so
  // keeping them would have tested the length rule six times over and the
  // guessability rules not at all.
  // ==========================================================================

  it('is one length, and does not depend on a role', () => {
    expect(PIN_LENGTH).toBe(6);
    // The old signature still resolves, so nothing silently kept two lengths.
    expect(pinLengthFor()).toBe(6);
    expect(pinLengthFor('vendor')).toBe(6);
    expect(pinLengthFor('customer')).toBe(6);
  });

  it('accepts a reasonable PIN', () => {
    expect(checkPin('481627')).toBeNull();
    expect(checkPin('284605')).toBeNull();
  });

  it('enforces the length, in both directions', () => {
    expect(checkPin('4821')?.code).toBe('PIN_WRONG_LENGTH');
    expect(checkPin('48162')?.code).toBe('PIN_WRONG_LENGTH');
    expect(checkPin('4816270')?.code).toBe('PIN_WRONG_LENGTH');
  });

  it('a four-digit code is refused as a NEW code', () => {
    // The upgrade path only works while this stays true. Login accepts four so
    // an existing account is not locked out of its own money; everything that
    // SETS a code requires six, which is what drains the fours away.
    const r = checkPin('4821');
    expect(r?.code).toBe('PIN_WRONG_LENGTH');
    expect(r?.message).toMatch(/6 chiffres/);
  });

  it('but a four-digit code is still ACCEPTED at login', () => {
    // The other half, and the one that matters more: requiring six at the login
    // screen would not ask an existing account to upgrade, it would lock it out
    // with "code incorrect" as the only clue.
    expect(PIN_LENGTHS_ACCEPTED).toContain(4);
    expect(PIN_LENGTHS_ACCEPTED).toContain(6);
  });

  it('rejects non-numeric PINs', () => {
    expect(checkPin('48a162')?.code).toBe('PIN_NOT_NUMERIC');
    expect(checkPin('')?.code).toBe('PIN_NOT_NUMERIC');
    expect(checkPin('12 456')?.code).toBe('PIN_NOT_NUMERIC');
  });

  it('rejects repeated digits, as the spec requires', () => {
    for (const pin of ['000000', '111111', '999999']) {
      expect(checkPin(pin)?.code).toBe('PIN_REPEATED');
    }
  });

  it('rejects sequences, as the spec requires', () => {
    for (const pin of ['123456', '234567', '456789', '654321', '987654']) {
      expect(checkPin(pin)?.code).toBe('PIN_SEQUENTIAL');
    }
  });

  it('rejects sequences that wrap past zero', () => {
    // 901234 is exactly as guessable as 123456 but survives a naive ascending
    // check that compares raw digit values.
    expect(checkPin('901234')?.code).toBe('PIN_SEQUENTIAL');
    expect(checkPin('109876')?.code).toBe('PIN_SEQUENTIAL');
  });

  it('rejects alternating pairs', () => {
    // 121212 reads as varied but is two digits, so it falls in the first
    // handful of guesses.
    expect(checkPin('121212')?.code).toBe('PIN_REPEATED_PAIR');
    expect(checkPin('272727')?.code).toBe('PIN_REPEATED_PAIR');
  });

  it('does not over-reject ordinary PINs', () => {
    // The policy has to leave a usable space, or people write the PIN down.
    // Six digits is a million codes; refusing the handful an attacker tries
    // first must not cost more than that handful.
    const fine = ['482165', '135792', '284605', '913746', '506218', '102384'];
    for (const pin of fine) {
      expect(checkPin(pin), pin).toBeNull();
    }
  });

  it('never echoes the PIN in its message', () => {
    // Standing rule 11: a PIN must not appear in any error message.
    const r = checkPin('123456');
    expect(r?.message).not.toContain('123456');
    expect(r?.message).toBe('Ce code est trop simple');
  });

  it('speaks French', () => {
    expect(checkPin('4821')?.message).toMatch(/chiffres/);
    expect(checkPin('000000')?.message).toMatch(/simple/);

  });
});
