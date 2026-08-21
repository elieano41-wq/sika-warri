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

describe('PIN policy', () => {
  it('uses 6 digits for vendors and 4 for customers', () => {
    expect(pinLengthFor('vendor')).toBe(6);
    expect(pinLengthFor('customer')).toBe(4);
  });

  it('accepts a reasonable PIN', () => {
    expect(checkPin('4821', 'customer')).toBeNull();
    expect(checkPin('481627', 'vendor')).toBeNull();
  });

  it('enforces the length per role', () => {
    expect(checkPin('482', 'customer')?.code).toBe('PIN_WRONG_LENGTH');
    expect(checkPin('48216', 'customer')?.code).toBe('PIN_WRONG_LENGTH');
    expect(checkPin('4821', 'vendor')?.code).toBe('PIN_WRONG_LENGTH');
  });

  it('rejects non-numeric PINs', () => {
    expect(checkPin('48a1', 'customer')?.code).toBe('PIN_NOT_NUMERIC');
    expect(checkPin('', 'customer')?.code).toBe('PIN_NOT_NUMERIC');
    expect(checkPin('12 4', 'customer')?.code).toBe('PIN_NOT_NUMERIC');
  });

  it('rejects repeated digits, as the spec requires', () => {
    for (const pin of ['0000', '1111', '9999']) {
      expect(checkPin(pin, 'customer')?.code).toBe('PIN_REPEATED');
    }
    expect(checkPin('111111', 'vendor')?.code).toBe('PIN_REPEATED');
  });

  it('rejects sequences, as the spec requires', () => {
    for (const pin of ['1234', '2345', '6789', '4321', '9876']) {
      expect(checkPin(pin, 'customer')?.code).toBe('PIN_SEQUENTIAL');
    }
    expect(checkPin('123456', 'vendor')?.code).toBe('PIN_SEQUENTIAL');
    expect(checkPin('654321', 'vendor')?.code).toBe('PIN_SEQUENTIAL');
  });

  it('rejects sequences that wrap past zero', () => {
    // 9012 and 1098 are exactly as guessable as 1234 but survive a naive
    // ascending check that compares raw digit values.
    expect(checkPin('9012', 'customer')?.code).toBe('PIN_SEQUENTIAL');
    expect(checkPin('1098', 'customer')?.code).toBe('PIN_SEQUENTIAL');
  });

  it('rejects alternating pairs', () => {
    // 1212 reads as varied but is two digits, so it falls in the first handful
    // of guesses.
    expect(checkPin('1212', 'customer')?.code).toBe('PIN_REPEATED_PAIR');
    expect(checkPin('2727', 'customer')?.code).toBe('PIN_REPEATED_PAIR');
    expect(checkPin('121212', 'vendor')?.code).toBe('PIN_REPEATED_PAIR');
  });

  it('does not over-reject ordinary PINs', () => {
    // The policy has to leave a usable space, or people write the PIN down.
    const fine = ['4821', '1357', '2846', '9137', '5062', '1023'];
    for (const pin of fine) {
      expect(checkPin(pin, 'customer')).toBeNull();
    }
  });

  it('never echoes the PIN in its message', () => {
    // Standing rule 11: a PIN must not appear in any error message.
    const r = checkPin('1234', 'customer');
    expect(r?.message).not.toContain('1234');
    expect(r?.message).toBe('Ce code est trop simple');
  });

  it('speaks French', () => {
    expect(checkPin('482', 'customer')?.message).toMatch(/chiffres/);
    expect(checkPin('0000', 'customer')?.message).toMatch(/simple/);
  });
});
