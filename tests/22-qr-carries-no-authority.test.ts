// The QR code must never authorise anything.
//
// The hard rule: it carries an identifier and nothing else. A vendor who
// photographs a customer's code gains exactly what typing the number already
// gives them — the ability to propose a debit that the customer must still
// confirm with their PIN, on their own device.
//
// What would break that rule: a payload containing a token, a signature, a
// session, a URL, or anything with an expiry. Any of those would make the code
// a bearer credential, and a photograph of it would become worth stealing.
// These tests exist so nobody "improves" the payload later.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  normaliseMsisdn, NormalisationError,
} from '../supabase/functions/_shared/identity';

const SRC = path.join(process.cwd(), 'src');

function code(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !/^\s*\/\//.test(l))
    .join('\n');
}

const affichage = readFileSync(path.join(SRC, 'components', 'QrCode.tsx'), 'utf8');
const scanner = readFileSync(path.join(SRC, 'components', 'QrScanner.tsx'), 'utf8');
const saisie = readFileSync(path.join(SRC, 'components', 'SaisieClient.tsx'), 'utf8');

describe('the QR payload is an identifier and nothing else', () => {
  it('encodes the bare msisdn', () => {
    // toCanvas(canvas, msisdn, ...) — the second argument is the payload.
    expect(code(affichage)).toMatch(/toCanvas\(\s*canvas\.current\s*,\s*msisdn\s*,/);
  });

  it('encodes NO token, signature, session or URL', () => {
    const src = code(affichage);
    // Anything from this list in the payload would turn a photograph of the
    // code into something worth stealing.
    for (const interdit of [
      /accessToken/, /refreshToken/, /session\./, /jwt/i, /signature/i,
      /https?:\/\//, /expires/i, /nonce/i, /secret/i,
    ]) {
      expect(src, `QrCode.tsx references ${interdit}`).not.toMatch(interdit);
    }
  });

  it('takes only a msisdn as its prop', () => {
    // A component that accepted a session could not help but be tempted to
    // encode part of it.
    expect(code(affichage)).toMatch(/\{\s*msisdn\s*\}\s*:\s*\{\s*msisdn:\s*string\s*\}/);
  });

  it('shows the number in plain text alongside the code', () => {
    // The QR is a convenience, never the only route. A vendor who prefers
    // typing, or whose camera is broken, reads it off the same screen.
    expect(code(affichage)).toMatch(/formatPhoneLocal\(msisdn\)/);
  });
});

describe('a scanned code is treated as untrusted input', () => {
  it('the scanner normalises and validates before accepting', () => {
    // Identical treatment to typed digits. The scan is a way of entering a
    // number, not a way of proving anything.
    expect(code(scanner)).toMatch(/normaliseMsisdn\(brut\.trim\(\)\)/);
  });

  it('the scanner never posts a ledger entry itself', () => {
    const src = code(scanner);
    expect(src).not.toMatch(/post_ledger_entry/);
    expect(src).not.toMatch(/initiateDebit/);
    expect(src).not.toMatch(/confirmDebit/);
    expect(src).not.toMatch(/recordCredit/);
  });

  it('rejects anything that is not an Ivorian mobile number', () => {
    // What a vendor scanning a biscuit packet produces.
    for (const brut of ['https://example.com', 'hello', '', '12345', '0901020304']) {
      expect(() => normaliseMsisdn(brut)).toThrow(NormalisationError);
    }
  });

  it('accepts a code containing the plain number, in any spelling', () => {
    for (const brut of ['2250701020304', '0701020304', '+225 07 01 02 03 04']) {
      expect(normaliseMsisdn(brut)).toBe('2250701020304');
    }
  });
});

describe('scanning and typing are equal options', () => {
  it('offers both, as two buttons of the same kind', () => {
    const src = code(saisie);
    const options = [...src.matchAll(/className="choix__option"/g)];
    // Same class means same size and same weight. A smaller "or type it"
    // link would make typing the fallback, which it is not.
    expect(options).toHaveLength(2);
    expect(src).toMatch(/Taper le numéro/);
    expect(src).toMatch(/Scanner son code/);
  });

  it('typing is reachable from inside the scanner at all times', () => {
    // Not only after a failure. A vendor who opens the camera by mistake, or
    // whose customer has no phone, needs one tap out.
    expect(code(scanner)).toMatch(/Taper le numéro à la place/);
  });

  it('every camera failure ends in an offer to type', () => {
    const src = code(scanner);
    // Permission refused, no camera, no decoder, and anything else.
    for (const etat of ['refuse', 'sans-camera', 'sans-decodeur', 'echec']) {
      expect(src, `no message for ${etat}`).toContain(etat);
    }
    expect(src).toMatch(/Tapez le numéro du client/);
    expect(src).toMatch(/BoutonSecondaire onClick=\{onAbandon\}/);
  });

  it('remembers the vendor’s choice so they are not asked twice', () => {
    expect(code(saisie)).toMatch(/retenirPreference/);
    expect(code(saisie)).toMatch(/preferenceEnregistree/);
  });

  it('falling back from the camera switches the remembered preference', () => {
    // A vendor whose camera does not work should not be sent back to it every
    // single time.
    expect(code(saisie)).toMatch(/onAbandon=\{\(\) => choisir\('clavier'\)\}/);
  });
});

describe('the scanner degrades without a native decoder', () => {
  it('tries BarcodeDetector first', () => {
    // Native, hardware-accelerated, and on Android it goes through Play
    // Services. Cheapest on battery where it exists.
    expect(code(scanner)).toMatch(/BarcodeDetector/);
  });

  it('falls back to jsQR, loaded only when needed', () => {
    // iOS Safari and Firefox have no BarcodeDetector at all, and an Android
    // build with stale Play Services can lack it too — exactly the cheap
    // handset case. The fallback is a dynamic import so nobody pays for the
    // 130 kB who does not need it.
    expect(code(scanner)).toMatch(/await import\('jsqr'\)/);
  });

  it('downscales frames before decoding', () => {
    // Full-resolution frames are slow on a cheap phone and add nothing for a
    // code held up close.
    expect(code(scanner)).toMatch(/640 \/ v\.videoWidth/);
  });

  it('asks for the rear camera', () => {
    expect(code(scanner)).toMatch(/facingMode/);
    expect(code(scanner)).toMatch(/environment/);
  });

  it('stops the camera when it goes away', () => {
    // Leaving the torch-adjacent camera running drains a battery and leaves the
    // indicator light on, which reads as the app spying.
    expect(code(scanner)).toMatch(/getTracks\(\)\.forEach\(\(t\) => t\.stop\(\)\)/);
  });
});
