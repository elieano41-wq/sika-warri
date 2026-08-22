// POST /admin — the operator's panel.
//
// One function, several actions, because the gate must be identical for all of
// them. Every action calls a definer function that checks is_admin() in SQL, so
// the check happens where the data is, not where the UI is. There is no hidden
// URL and no client-side flag: a non-admin calling this gets the same refusal as
// a stranger.
//
// The temporary reset code is generated HERE, by a CSPRNG, and returned exactly
// once. The operator cannot choose it, cannot reuse one, and cannot look it up
// afterwards — only its salted hash is stored.

import {
  handler, json, fail, readJson, requireCaller, serviceClient,
} from '../_runtime/runtime.ts';
import { genererCode, genererSel, hacherCode } from '../_shared/tempcode.ts';

type Action =
  | 'reset_queue'
  | 'issue_reset'
  | 'reject_reset'
  | 'vendor_list'
  | 'verify_phone'
  | 'set_vendor_active'
  | 'purge_orphan_auth';

interface Body {
  action?: Action;
  requestId?: string;
  vendorId?: string;
  targetId?: string;
  role?: 'vendor' | 'customer';
  method?: 'sms' | 'in_person';
  active?: boolean;
  note?: string;
  /** purge_orphan_auth: defaults to a preview. Pass false to actually delete. */
  dryRun?: boolean;
}

Deno.serve(handler(async (req) => {
  const caller = await requireCaller(req);
  const body = await readJson<Body>(req);
  const db = serviceClient();

  // The admin check lives in each RPC below, in SQL. Nothing is decided here.
  const actor = caller.authUserId;

  switch (body.action) {
    // ---- the reset queue, with identity context in one call ---------------
    case 'reset_queue': {
      const { data, error } = await db.rpc('admin_reset_queue', {
        p_actor_user_id: actor,
      });
      if (error) throw error;
      return json({ ok: true, requests: data ?? [] });
    }

    // ---- issue a temporary code ------------------------------------------
    case 'issue_reset': {
      if (!body.requestId) return fail('REQUEST_ID_REQUIRED', 'Demande non précisée');

      // Generated here, never supplied. admin_issue_pin_reset takes only the
      // hash and salt, so there is no parameter through which an operator could
      // impose a code of their choosing.
      const code = genererCode();
      const sel = genererSel();
      const hash = await hacherCode(code, sel);

      const { data, error } = await db.rpc('admin_issue_pin_reset', {
        p_request_id: body.requestId,
        p_code_hash: hash,
        p_code_salt: sel,
        p_actor_user_id: actor,
      });
      if (error) throw error;

      const grant = Array.isArray(data) ? data[0] : data;

      return json({
        ok: true,
        // The only time this value exists in readable form anywhere. Not
        // recoverable afterwards, by anyone, including the operator.
        code,
        expiresAt: grant?.expires_at ?? null,
        role: grant?.target_role ?? null,
        message: 'Lisez ce code au téléphone. Il ne sera plus affiché.',
      });
    }

    case 'reject_reset': {
      if (!body.requestId) return fail('REQUEST_ID_REQUIRED', 'Demande non précisée');
      const { error } = await db.rpc('admin_reject_pin_reset', {
        p_request_id: body.requestId,
        p_actor_user_id: actor,
        p_note: body.note ?? null,
      });
      if (error) throw error;
      return json({ ok: true });
    }

    // ---- vendors ----------------------------------------------------------
    case 'vendor_list': {
      const { data, error } = await db.rpc('admin_vendor_list', {
        p_actor_user_id: actor,
      });
      if (error) throw error;
      return json({ ok: true, vendors: data ?? [] });
    }

    case 'verify_phone': {
      if (!body.targetId || !body.role) {
        return fail('TARGET_REQUIRED', 'Cible non précisée');
      }
      const { data, error } = await db.rpc('admin_verify_phone', {
        p_role: body.role,
        p_target_id: body.targetId,
        // in_person is the default and the strong one: the operator called the
        // number and watched it ring. SMS is only meaningful once a provider
        // exists.
        p_method: body.method ?? 'in_person',
        p_actor_user_id: actor,
      });
      if (error) throw error;
      return json({ ok: true, verifiedAt: data });
    }

    case 'set_vendor_active': {
      if (!body.vendorId || typeof body.active !== 'boolean') {
        return fail('VENDOR_REQUIRED', 'Commerçant non précisé');
      }
      const { data, error } = await db.rpc('admin_set_vendor_active', {
        p_vendor_id: body.vendorId,
        p_active: body.active,
        p_actor_user_id: actor,
      });
      if (error) throw error;
      return json({ ok: true, active: data });
    }

    // ---- remove auth users with no profile row --------------------------
    //
    // Deleting the vendor/customer row leaves the Supabase Auth user behind.
    // Those are harmless — no profile means no login — but they accumulate and
    // they block the phone number from being re-registered, because createUser
    // reports "already exists" while nothing exists to log in against.
    //
    // Lives here rather than in a local script because the service key exists
    // only in this function's secrets. Two guards, both required:
    //   * the address must match the synthetic pattern this app creates;
    //   * there must be NO vendor or customer row for that auth user.
    // A real account fails the second test, so a live user cannot be deleted
    // even if the first were somehow wrong.
    case 'purge_orphan_auth': {
      const { data: verif, error: verifErr } = await db.rpc('admin_is_caller', {
        p_actor_user_id: actor,
      });
      if (verifErr) throw verifErr;
      if (verif !== true) return fail('ADMIN_ONLY', 'Opération non autorisée', 403);

      const garder = new Set<string>();
      for (const table of ['vendors', 'customers'] as const) {
        const { data } = await db.from(table).select('auth_user_id');
        for (const r of data ?? []) if (r.auth_user_id) garder.add(r.auth_user_id);
      }

      let page = 1;
      let examines = 0;
      let supprimes = 0;
      const echecs: string[] = [];
      const apercu = body.dryRun !== false;

      // Paginate: an unbounded listUsers() silently truncates.
      for (;;) {
        const { data, error } = await db.auth.admin.listUsers({ page, perPage: 200 });
        if (error) throw error;
        const lot = data?.users ?? [];
        if (lot.length === 0) break;

        for (const u of lot) {
          examines += 1;
          const synthetique = (u.email ?? '').endsWith('@id.sikawarri.app');
          if (!synthetique) continue;
          if (garder.has(u.id)) continue;

          if (apercu) { supprimes += 1; continue; }

          const { error: delErr } = await db.auth.admin.deleteUser(u.id);
          if (delErr) echecs.push(u.email ?? u.id);
          else supprimes += 1;
        }

        if (lot.length < 200) break;
        page += 1;
      }

      return json({
        ok: true,
        dryRun: apercu,
        examined: examines,
        withProfile: garder.size,
        orphansRemoved: supprimes,
        failures: echecs,
      });
    }

    default:
      return fail('UNKNOWN_ACTION', 'Action inconnue', 400);
  }
}));
