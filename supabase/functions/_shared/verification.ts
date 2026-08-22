// Phone verification: the plumbing, off by default.
//
// ============================================================================
// AMENDMENT E. The flags exist so that turning verification on is a
// configuration change rather than a code change — and so that the code paths
// that would need it are written and reviewed NOW, while the reasoning is fresh,
// rather than bolted on the week someone decides to enable it.
//
// Both default to FALSE, and false is the honest default today: SMS costs money
// this product does not have, and an unverified phone number is a known,
// documented limitation rather than an oversight. See README, "Known gaps".
// ============================================================================
//
// WHAT VERIFICATION WOULD AND WOULD NOT BUY:
//
//   It WOULD stop a vendor pre-loading debts against phone numbers belonging to
//   people who have never heard of Sika Warri — currently the largest hole in
//   the debt register, because a claim nobody can see is a claim nobody can
//   dispute.
//
//   It WOULD NOT stop a vendor fabricating a debt against a customer standing in
//   front of them, which is a different problem solved by the two-device
//   handshake.
//
// The asymmetry between the two flags is deliberate. A VENDOR is a business
// taking on other people's money and is worth verifying before they can record
// anything. A CUSTOMER is someone who was handed a receipt; requiring them to
// receive an SMS before they can dispute a claim made against them would make
// the dispute path depend on the thing most likely to fail.

/** Is a vendor required to verify their phone before recording entries? */
export function vendorVerificationRequired(
  env: Record<string, string | undefined>
): boolean {
  return estVrai(env.SIKA_REQUIRE_VENDOR_SMS_VERIFICATION);
}

/** Is a customer required to verify their phone before registering? */
export function customerVerificationRequired(
  env: Record<string, string | undefined>
): boolean {
  return estVrai(env.SIKA_REQUIRE_CUSTOMER_SMS_VERIFICATION);
}

/**
 * Only an explicit, unambiguous "true" enables a flag.
 *
 * Everything else is false, including "1", "yes", "on" and "TRUE " with a stray
 * space — because a flag that gates whether people can use the product should
 * fail CLOSED to the current behaviour, and a typo in a dashboard field should
 * not silently lock out every vendor in the country.
 *
 * The inverse also matters: an unset variable is false, so a project that has
 * never heard of these flags behaves exactly as it does today.
 */
function estVrai(valeur: string | undefined): boolean {
  return valeur?.trim().toLowerCase() === 'true';
}

/**
 * Whether a profile counts as verified.
 *
 * Deliberately reads the column rather than trusting a caller's word: the flag
 * says whether verification is REQUIRED, this says whether it HAPPENED, and
 * conflating the two is how a feature flag turns into a bypass.
 */
export function estVerifie(profil: { phone_verified_at?: string | null }): boolean {
  return Boolean(profil.phone_verified_at);
}

/**
 * The refusal, when a flag is on and a profile is not verified.
 *
 * Returns null when the action may proceed. Written as a message rather than a
 * boolean so the caller cannot accidentally invert it, and so the French wording
 * lives beside the rule it enforces.
 */
export function blocageVerification(
  role: 'vendor' | 'customer',
  env: Record<string, string | undefined>,
  profil: { phone_verified_at?: string | null }
): { code: string; message: string } | null {
  const requis =
    role === 'vendor'
      ? vendorVerificationRequired(env)
      : customerVerificationRequired(env);

  if (!requis || estVerifie(profil)) return null;

  return role === 'vendor'
    ? {
        code: 'VENDOR_NOT_VERIFIED',
        message:
          'Votre numéro doit être vérifié avant d’enregistrer de la monnaie. ' +
          'Contactez le support Sika Warri.',
      }
    : {
        code: 'CUSTOMER_NOT_VERIFIED',
        message:
          'Votre numéro doit être vérifié. Vous allez recevoir un SMS avec un code.',
      };
}
