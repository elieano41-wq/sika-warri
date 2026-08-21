import { useEffect, useRef, useState } from 'react';
import { Message } from './ui';
import { formatPhoneLocal } from '../lib/format';

/**
 * The customer's QR code.
 *
 * HARD RULE: this carries an identifier and nothing else. It authorises
 * nothing. A vendor who photographs it gains exactly what typing the number
 * already gives them, and no more — every debit still requires the customer's
 * PIN on the customer's own device.
 *
 * So the payload is the bare msisdn. No token, no signature, no session, no
 * URL, nothing with an expiry, nothing that could be replayed. If this code
 * ever needs to be secret, something has gone wrong upstream.
 */
export function QrCode({ msisdn }: { msisdn: string }) {
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);

  useEffect(() => {
    let annule = false;

    (async () => {
      try {
        // Loaded on demand: most sessions never open this screen, and the
        // encoder is dead weight in the main bundle on a slow connection.
        const { default: QRCode } = await import('qrcode');
        if (annule || !canvas.current) return;

        await QRCode.toCanvas(canvas.current, msisdn, {
          // Generous quiet zone and high error correction: this gets scanned
          // off a scratched screen, in a dim shop, at an angle.
          margin: 2,
          errorCorrectionLevel: 'H',
          width: 260,
          color: {
            // Dark modules on chalk. A dark-on-dark code is unscannable, so the
            // code carries its own light ground rather than inheriting the
            // page's.
            dark: '#0B2E22',
            light: '#F4F1E8',
          },
        });
      } catch (e) {
        if (!annule) setErreur((e as Error).message);
      }
    })();

    return () => { annule = true; };
  }, [msisdn]);

  if (erreur) {
    return (
      <Message ton="erreur">
        Impossible d'afficher le code. Donnez votre numéro : {formatPhoneLocal(msisdn)}
      </Message>
    );
  }

  return (
    <div className="qr">
      <canvas ref={canvas} className="qr__image" aria-label="Votre code à scanner" />
      {/* The number in plain text underneath, always. The QR is a convenience,
          never the only way: a vendor who prefers typing, or whose camera does
          not work, reads it from here. */}
      <div className="qr__numero montant">{formatPhoneLocal(msisdn)}</div>
    </div>
  );
}
