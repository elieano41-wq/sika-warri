// Amendment B — app_current_user_id() must branch at MIGRATION time on whether
// the auth schema exists, never at query time on whether auth.uid() came back
// null.
//
// The attack this prevents. `app.current_user_id` is an unreserved GUC, and
// Postgres lets any role set one of those on its own session. If the function
// read auth.uid() and fell back to the GUC whenever it was null, then on
// Supabase any authenticated caller could issue
//
//     set app.current_user_id = '<some other vendor uuid>'
//
// and every RLS policy in 0006 would hand them that vendor's ledger. The whole
// of test 1 would still pass while the isolation it proves was worthless.
//
// Proving this on a bare container takes a trick: CI has no auth schema, so the
// Supabase branch would normally go untested. We synthesise one, re-run the
// migration, and assert the compiled body. That exercises the real branch on
// the real migration file rather than trusting a comment.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import { connect, actAsAdmin, randomUUID } from './helpers/db';

let db: pg.Client;
let migration0002: string;

const MIGRATION = path.join(
  process.cwd(),
  'supabase',
  'migrations',
  '0002_identity.sql'
);

async function bodyOf(client: pg.Client): Promise<string> {
  const { rows } = await client.query(
    `select pg_get_functiondef(p.oid) as def
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'app_current_user_id'`
  );
  return rows[0].def as string;
}

async function backend(client: pg.Client): Promise<string> {
  const { rows } = await client.query('select public.app_identity_backend() as b');
  return rows[0].b as string;
}

beforeAll(async () => {
  db = await connect();
  await actAsAdmin(db);
  migration0002 = await readFile(MIGRATION, 'utf8');
});

afterAll(async () => {
  // Always leave the database on the stock-Postgres branch, whatever happened,
  // or every later test file inherits a null identity and fails confusingly.
  await actAsAdmin(db);
  await db.query('drop schema if exists auth cascade');
  await db.query(migration0002);
  await db.end();
});

describe('amendment B — identity wrapper cannot be impersonated', () => {
  it('on stock Postgres, resolves identity from the session GUC', async () => {
    expect(await backend(db)).toBe('setting');

    const who = randomUUID();
    await db.query('select set_config($1, $2, false)', ['app.current_user_id', who]);
    const { rows } = await db.query('select public.app_current_user_id() as id');
    expect(rows[0].id).toBe(who);
  });

  it('on stock Postgres, the body contains no reference to auth.uid', async () => {
    expect(await bodyOf(db)).not.toMatch(/auth\.uid/);
  });

  describe('with an auth schema present', () => {
    beforeAll(async () => {
      await actAsAdmin(db);
      // Stand in for Supabase's auth.uid(). Returning null is the realistic
      // hostile case: an unauthenticated or expired request, exactly when a
      // runtime fallback would kick in and be exploitable.
      await db.query('create schema if not exists auth');
      await db.query(
        `create or replace function auth.uid() returns uuid
           language sql stable as $$ select null::uuid $$`
      );

      // Supabase grants `authenticated` access to the auth schema. Without
      // mirroring that, the last test in this block fails with "permission
      // denied for schema auth" — which looks like the policy denying access
      // but is really the fixture being unrealistic, and would mask whether
      // the impersonation guard works at all.
      await db.query('grant usage on schema auth to authenticated, anon');
      await db.query('grant execute on function auth.uid() to authenticated, anon');

      await db.query(migration0002); // re-run: it must now take the auth branch
    });

    it('takes the auth branch', async () => {
      expect(await backend(db)).toBe('auth');
    });

    it('compiles NO current_setting path into the function at all', async () => {
      const def = await bodyOf(db);
      expect(def).toMatch(/auth\.uid/);
      // Unreachable is not enough — it must be absent. Nothing to re-enable by
      // accident in a later edit.
      expect(def).not.toMatch(/current_setting/);
      expect(def).not.toMatch(/app\.current_user_id/);
    });

    it('IGNORES app.current_user_id — the impersonation attempt fails', async () => {
      const victim = randomUUID();
      await db.query('select set_config($1, $2, false)', [
        'app.current_user_id',
        victim,
      ]);

      const { rows } = await db.query('select public.app_current_user_id() as id');

      // This assertion is the point of the whole file. The GUC is set to a
      // valid uuid and the function still returns null, because it never reads
      // it. A runtime fallback would return `victim` here.
      expect(rows[0].id).toBeNull();
      expect(rows[0].id).not.toBe(victim);
    });

    it('so RLS yields nothing rather than another user\'s rows', async () => {
      // End to end: with a spoofed GUC and the auth branch live, the policies
      // resolve to null and disclose nothing.
      await db.query('select set_config($1, $2, false)', [
        'app.current_user_id',
        randomUUID(),
      ]);
      await db.query('set role authenticated');

      const { rows } = await db.query('select count(*)::integer as n from public.vendors');
      expect(rows[0].n).toBe(0);

      await actAsAdmin(db);
    });
  });
});
