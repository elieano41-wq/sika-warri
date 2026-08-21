import { useCallback, useEffect, useRef, useState } from 'react';
import { Message, BoutonSecondaire, BoutonDiscret } from './ui';
import { normaliseMsisdn, NormalisationError } from '../../supabase/functions/_shared/identity';

/**
 * Scanning a customer's QR code.
 *
 * Two decoders, because one is not available everywhere:
 *
 *   1. BarcodeDetector — native, hardware-accelerated, and on Android it goes
 *      through Play Services. Fast and cheap on battery. Absent on iOS Safari
 *      and Firefox entirely, and can be missing on an Android build without
 *      current Play Services, which is exactly the cheap-handset case.
 *   2. jsQR — pure JavaScript, works anywhere a camera does, slower and warmer.
 *      Loaded on demand only when the native path is unavailable, so nobody
 *      pays for it who does not need it.
 *
 * And typing, always, as an equal option rather than a punishment. Every failure
 * here — no camera, permission refused, no decoder, a code that is not a phone
 * number — ends in the same place: type the number instead. No drama, no dead
 * end, no explaining to a shopkeeper why the app has stopped.
 *
 * The scanned value is treated as untrusted text. It is normalised and validated
 * exactly like typed digits, because a QR code is a way of entering a number and
 * carries no authority whatsoever.
 */

type Etat =
  | 'demarrage'
  | 'scan'
  | 'refuse'        // permission denied
  | 'sans-camera'   // no camera on the device
  | 'sans-decodeur' // camera works, nothing can decode
  | 'echec';        // something else broke

export function QrScanner({
  onNumero,
  onAbandon,
}: {
  onNumero: (msisdn: string) => void;
  onAbandon: () => void;
}) {
  const video = useRef<HTMLVideoElement | null>(null);
  const flux = useRef<MediaStream | null>(null);
  const boucle = useRef<number | null>(null);
  const [etat, setEtat] = useState<Etat>('demarrage');
  const [detail, setDetail] = useState<string | null>(null);
  const [mauvaisCode, setMauvaisCode] = useState<string | null>(null);

  const arreter = useCallback(() => {
    if (boucle.current) {
      window.clearInterval(boucle.current);
      boucle.current = null;
    }
    flux.current?.getTracks().forEach((t) => t.stop());
    flux.current = null;
  }, []);

  /** Accept a decoded string only if it is a usable Ivorian number. */
  const accepter = useCallback(
    (brut: string) => {
      try {
        const msisdn = normaliseMsisdn(brut.trim());
        arreter();
        onNumero(msisdn);
      } catch (e) {
        // Someone scanned a packet of biscuits. Say so and keep scanning.
        setMauvaisCode(
          e instanceof NormalisationError
            ? e.message
            : "Ce code ne contient pas un numéro de téléphone"
        );
      }
    },
    [arreter, onNumero]
  );

  useEffect(() => {
    let annule = false;

    (async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        setEtat('sans-camera');
        return;
      }

      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          // Rear camera. facingMode is a hint, not a guarantee, but on a phone
          // it reliably avoids opening the selfie camera.
          video: { facingMode: { ideal: 'environment' } },
        });
      } catch (e) {
        if (annule) return;
        const nom = (e as Error).name;
        if (nom === 'NotAllowedError' || nom === 'SecurityError') setEtat('refuse');
        else if (nom === 'NotFoundError' || nom === 'DevicesNotFoundError') setEtat('sans-camera');
        else { setEtat('echec'); setDetail(nom); }
        return;
      }

      if (annule) { stream.getTracks().forEach((t) => t.stop()); return; }
      flux.current = stream;

      if (video.current) {
        video.current.srcObject = stream;
        try { await video.current.play(); } catch { /* autoplay policy; harmless */ }
      }

      // ---- pick a decoder ------------------------------------------------
      const Natif = (globalThis as unknown as { BarcodeDetector?: any }).BarcodeDetector;
      let lire: (() => Promise<string | null>) | null = null;

      if (Natif) {
        try {
          const formats: string[] = (await Natif.getSupportedFormats?.()) ?? [];
          if (formats.length === 0 || formats.includes('qr_code')) {
            const detecteur = new Natif({ formats: ['qr_code'] });
            lire = async () => {
              if (!video.current) return null;
              const trouve = await detecteur.detect(video.current);
              return trouve?.[0]?.rawValue ?? null;
            };
          }
        } catch {
          lire = null; // constructed but unusable; fall through to jsQR
        }
      }

      if (!lire) {
        try {
          const { default: jsQR } = await import('jsqr');
          const toile = document.createElement('canvas');
          const ctx = toile.getContext('2d', { willReadFrequently: true });
          if (!ctx) throw new Error('no 2d context');

          lire = async () => {
            const v = video.current;
            if (!v || !v.videoWidth) return null;
            // Downscale before decoding: full-resolution frames are slow on a
            // cheap phone and add nothing for a code held up close.
            const echelle = Math.min(1, 640 / v.videoWidth);
            toile.width = Math.round(v.videoWidth * echelle);
            toile.height = Math.round(v.videoHeight * echelle);
            ctx.drawImage(v, 0, 0, toile.width, toile.height);
            const image = ctx.getImageData(0, 0, toile.width, toile.height);
            return jsQR(image.data, image.width, image.height)?.data ?? null;
          };
        } catch {
          if (!annule) { arreter(); setEtat('sans-decodeur'); }
          return;
        }
      }

      if (annule) return;
      setEtat('scan');

      // ~5 frames a second. Faster gains nothing for a code being held still
      // and costs battery and heat on a cheap handset.
      boucle.current = window.setInterval(async () => {
        try {
          const valeur = await lire!();
          if (valeur) accepter(valeur);
        } catch {
          // A single dropped frame is not a failure. Keep going.
        }
      }, 200);
    })();

    return () => { annule = true; arreter(); };
  }, [accepter, arreter]);

  // ---- everything that is not "scanning" ends in the same offer ----------
  if (etat !== 'scan' && etat !== 'demarrage') {
    const messages: Record<string, string> = {
      refuse:
        "Vous avez refusé l'accès à la caméra. Vous pouvez l'autoriser dans les réglages du navigateur, ou simplement taper le numéro.",
      'sans-camera':
        "Aucune caméra disponible sur ce téléphone. Tapez le numéro du client.",
      'sans-decodeur':
        "Ce navigateur ne sait pas lire les codes QR. Tapez le numéro du client.",
      echec: "La caméra n'a pas démarré. Tapez le numéro du client.",
    };

    return (
      <div className="pile">
        <Message ton="info">{messages[etat]}</Message>
        {detail ? <p className="discret">({detail})</p> : null}
        <BoutonSecondaire onClick={onAbandon}>Taper le numéro</BoutonSecondaire>
      </div>
    );
  }

  return (
    <div className="pile">
      <div className="scanner">
        <video
          ref={video}
          className="scanner__video"
          playsInline
          muted
          // Poster-less; the frame fills in as soon as the camera opens.
          aria-label="Caméra"
        />
        <div className="scanner__cadre" aria-hidden="true" />
      </div>

      {etat === 'demarrage' ? (
        <p className="discret centre">Ouverture de la caméra…</p>
      ) : (
        <p className="discret centre">
          Placez le code du client dans le cadre.
        </p>
      )}

      {mauvaisCode ? <Message ton="erreur">{mauvaisCode}</Message> : null}

      {/* Typing stays one tap away at all times, not buried behind a failure. */}
      <BoutonDiscret onClick={onAbandon}>Taper le numéro à la place</BoutonDiscret>
    </div>
  );
}
