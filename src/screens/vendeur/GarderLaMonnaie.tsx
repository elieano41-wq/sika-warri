import { useState } from 'react';
import * as api from '../../lib/api';
import type { Session, VendorProfile } from '../../lib/api';
import {
  Clavier, Entete, Message, Cadran, Montant, BoutonPrimaire, BoutonSecondaire, BoutonDiscret,
} from '../../components/ui';
import { appendDigit, removeDigit, formatPhoneLocal } from '../../lib/format';
import { SaisieClient } from '../../components/SaisieClient';

/**
 * Garder la monnaie — the vendor records change they could not give.
 *
 * This is the screen used dozens of times a day, at speed, one-handed. Three
 * steps, each showing exactly one large number: whose it is, how much, and a
 * receipt code to read out. Nothing else competes for the eye.
 *
 * Copy rules (spec section 6): "monnaie gardée", never "portefeuille", never
 * "solde", never "dépôt". Sika Warri holds nothing — the cash stays in this
 * vendor's till and the record is a debt they owe.
 */
type Etape = 'numero' | 'montant' | 'fait';

export function GarderLaMonnaie({
  session,
  vendeur,
  onTermine,
}: {
  session: Session;
  vendeur: VendorProfile;
  onTermine: () => void;
}) {
  const [etape, setEtape] = useState<Etape>('numero');
  const [numero, setNumero] = useState('');
  const [montant, setMontant] = useState(0);
  const [clientId, setClientId] = useState<string | null>(null);
  const [etiquetteClient, setEtiquetteClient] = useState<string | null>(null);
  const [dejaChez, setDejaChez] = useState<number | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const [occupe, setOccupe] = useState(false);
  const [recu, setRecu] = useState<{ code: string; nouveau: number } | null>(null);

  const plafond = vendeur.maxBalancePerCustomer;

  async function chercherClient(msisdn: string) {
    setNumero(msisdn);
    setErreur(null);
    setOccupe(true);
    try {
      const r = await api.lookupCustomer(
        session.accessToken,
        vendeur.id,
        vendeur.authUserId,
        msisdn
      );

      if (!r.exists || !r.customerId) {
        // Creating a customer inline is a Phase 1 requirement but needs a
        // registration path this screen does not own yet. Say so plainly rather
        // than failing obscurely.
        setErreur(
          "Ce numéro n'est pas encore enregistré. Le client doit s'inscrire avant de garder sa monnaie."
        );
        return;
      }

      setClientId(r.customerId);
      setEtiquetteClient(r.yourLabel);

      // What they already hold HERE. Never a total across shops.
      const dejaLa = await api.balanceWith(session.accessToken, vendeur.id, r.customerId);
      setDejaChez(dejaLa);
      setEtape('montant');
    } catch (e) {
      setErreur((e as api.ApiError).message);
    } finally {
      setOccupe(false);
    }
  }

  async function enregistrer() {
    if (!clientId || montant <= 0) return;
    setErreur(null);
    setOccupe(true);
    try {
      const entree = await api.recordCredit(session.accessToken, {
        vendorId: vendeur.id,
        customerId: clientId,
        actorUserId: vendeur.authUserId,
        amountCfa: montant,
        // Client-generated so a retry on a dropped response cannot double the
        // entry. Same key, same entry, every time.
        idempotencyKey: crypto.randomUUID(),
      });

      const code = await api.receiptCode(session.accessToken, entree.id);
      const nouveau = await api.balanceWith(session.accessToken, vendeur.id, clientId);
      setRecu({ code, nouveau });
      setEtape('fait');
    } catch (e) {
      setErreur((e as api.ApiError).message);
    } finally {
      setOccupe(false);
    }
  }

  function recommencer() {
    setEtape('numero');
    setNumero('');
    setMontant(0);
    setClientId(null);
    setEtiquetteClient(null);
    setDejaChez(null);
    setRecu(null);
    setErreur(null);
  }

  // Depasse le plafond: shown before the vendor commits, not after the server
  // refuses. A refusal mid-transaction in front of a customer is the thing to
  // avoid.
  const total = (dejaChez ?? 0) + montant;
  const depasse = total > plafond;

  // Identifying the customer is its own screen, shared with "Utiliser la
  // monnaie", offering scan and typing as equal options.
  if (etape === 'numero') {
    return (
      <SaisieClient
        titre="Garder la monnaie"
        sousTitre={vendeur.businessName}
        erreur={erreur}
        occupe={occupe}
        onNumero={chercherClient}
        onRetour={onTermine}
      />
    );
  }

  return (
    <div className="ecran">
      <Entete
        sousTitre={vendeur.businessName}
        action={<BoutonDiscret onClick={onTermine}>Retour</BoutonDiscret>}
      />

      <div className="ecran__corps">
        {etape === 'montant' && (
          <>
            <h1>Combien ?</h1>
            <p className="discret">
              {etiquetteClient ? `${etiquetteClient} · ` : ''}
              {formatPhoneLocal(numero)}
            </p>

            <Cadran etiquette="Monnaie à garder">
              <Montant value={montant} taille="geant" />
            </Cadran>

            {dejaChez !== null && dejaChez > 0 ? (
              <p className="discret centre">
                Déjà gardée chez vous : <Montant value={dejaChez} /> · après :{' '}
                <Montant value={total} />
              </p>
            ) : null}

            {depasse ? (
              <Message ton="erreur">
                Plafond dépassé. Ce client ne peut pas garder plus de{' '}
                <Montant value={plafond} /> chez vous.
              </Message>
            ) : null}

            {erreur ? <Message ton="erreur">{erreur}</Message> : null}

            <Clavier
              onDigit={(d) => { setErreur(null); setMontant(appendDigit(montant, d)); }}
              onEffacer={() => setMontant(removeDigit(montant))}
              onToutEffacer={() => setMontant(0)}
            />
          </>
        )}

        {etape === 'fait' && recu && (
          <>
            <h1>Monnaie gardée</h1>

            {/* Le carnet: the record as it would appear in the paper cahier. */}
            <article className="carnet">
              <div>
                <div className="carnet__boutique">{vendeur.businessName}</div>
                <div className="carnet__quartier">{formatPhoneLocal(numero)}</div>
              </div>
              <div className="carnet__etiquette">Monnaie du client chez vous</div>
              <Montant value={recu.nouveau} taille="geant" />
            </article>

            <Cadran etiquette="Code du reçu — à noter par le client">
              <span className="montant montant--geant">{recu.code}</span>
            </Cadran>

            <p className="discret centre">
              La monnaie reste chez vous. Le client peut l'utiliser ou demander
              son remboursement en espèces à tout moment.
            </p>
          </>
        )}
      </div>

      <div className="ecran__pied pile">
        {etape === 'montant' && (
          <>
            <BoutonPrimaire onClick={enregistrer} disabled={montant <= 0 || depasse || occupe}>
              {occupe ? 'Enregistrement…' : 'Garder la monnaie'}
            </BoutonPrimaire>
            <BoutonDiscret onClick={() => setEtape('numero')}>Changer de client</BoutonDiscret>
          </>
        )}

        {etape === 'fait' && (
          <>
            <BoutonPrimaire onClick={recommencer}>Nouveau client</BoutonPrimaire>
            <BoutonSecondaire onClick={onTermine}>Terminer</BoutonSecondaire>
          </>
        )}
      </div>
    </div>
  );
}
