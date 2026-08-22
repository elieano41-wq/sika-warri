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

// NO ACTION HERE DELETES A USER.
//
// A purge_orphan_auth action existed briefly, to clear auth users left behind by
// a one-off data cleanup. It was removed because it could delete real accounts:
// it built its keep-list with .select('auth_user_id') and no range, and PostgREST
// caps rows at 1000 by default — so past 1000 accounts every real user beyond the
// cap would have looked like an orphan and been deleted.
//
// The lesson is not "add a range". It is that a permanent delete-users button in
// a support panel is the wrong shape for a one-off task, and this panel will one
// day be handed to someone else. Enforced by tests/24.

type Action =
  | 'reset_queue'
  | 'issue_reset'
  | 'reject_reset'
  | 'vendor_list'
  | 'verify_phone'
  | 'set_vendor_active';

interface Body {
  action?: Action;
  requestId?: string;
  vendorId?: string;
  targetId?: string;
  role?: 'vendor' | 'customer';
  method?: 'sms' | 'in_person';
  active?: boolean;
  note?: string;
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

    default:
      return fail('UNKNOWN_ACTION', 'Action inconnue', 400);
  }
}));
