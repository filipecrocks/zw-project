// supabase/functions/referral/index.ts
//
// Referidos server-side (service_role). O novo usuário chama com seu JWT e o
// código do amigo. Anti-abuso: não pode indicar a si mesmo, cada conta conta
// uma vez (referred_id é único + checagem de referred_by), código tem que existir.
// Credita zenny (referrer +100, novo +50), seta referred_by e concede os badges
// de referido ao referrer.
//
// Body: { code }
// Resp: { ok, reason?, credited? }

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const REWARD_REFERRER = 100;
const REWARD_NEW = 50;

function bearer(req: Request): string {
  return (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  const json = (b: unknown, s = 200) =>
    new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } });
  if (!SUPABASE_URL || !SERVICE) return json({ ok: false, reason: 'env' }, 500);

  const svc = createClient(SUPABASE_URL, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } });
  try {
    const { data: { user }, error: uerr } = await svc.auth.getUser(bearer(req));
    if (uerr || !user) return json({ ok: false, reason: 'auth' }, 401);
    const uid = user.id;
    const code = String((await req.json().catch(() => ({})))?.code ?? '').trim().toUpperCase();
    if (!code) return json({ ok: false, reason: 'no_code' });

    // já foi referido? (uma vez só)
    const { data: me } = await svc.from('profiles').select('zenny,referred_by').eq('id', uid).maybeSingle();
    if (!me) return json({ ok: false, reason: 'no_profile' });
    if (me.referred_by) return json({ ok: false, reason: 'already' });
    const { data: prev } = await svc.from('referrals').select('id').eq('referred_id', uid).maybeSingle();
    if (prev) return json({ ok: false, reason: 'already' });

    // achar o referrer pelo código
    const { data: ref } = await svc.from('profiles').select('id,zenny').eq('referral_code', code).maybeSingle();
    if (!ref) return json({ ok: false, reason: 'invalid_code' });
    if (ref.id === uid) return json({ ok: false, reason: 'self' });

    // registrar (referred_id único garante 1x; se corrida, falha aqui)
    const { error: insErr } = await svc.from('referrals').insert({ referrer_id: ref.id, referred_id: uid, code });
    if (insErr) return json({ ok: false, reason: 'dup' });

    // creditar zenny + referred_by
    await svc.from('profiles').update({ referred_by: ref.id, zenny: (me.zenny ?? 0) + REWARD_NEW }).eq('id', uid);
    await svc.from('profiles').update({ zenny: (ref.zenny ?? 0) + REWARD_REFERRER }).eq('id', ref.id);

    // badges de referido pro referrer
    const { count } = await svc.from('referrals').select('*', { count: 'exact', head: true }).eq('referrer_id', ref.id);
    const n = count ?? 1;
    const earn: string[] = [];
    if (n >= 1) earn.push('recrutador');
    if (n >= 5) earn.push('sensei');
    if (n >= 20) earn.push('lenda_zw');
    if (earn.length) {
      const { data: have } = await svc.from('user_badges').select('badge_code').eq('user_id', ref.id);
      const haveSet = new Set((have ?? []).map((b) => b.badge_code));
      const rows = earn.filter((c) => !haveSet.has(c)).map((c) => ({ user_id: ref.id, badge_code: c }));
      if (rows.length) await svc.from('user_badges').insert(rows);
    }

    return json({ ok: true, credited: REWARD_NEW });
  } catch (e) {
    return json({ ok: false, reason: e instanceof Error ? e.message : String(e) }, 500);
  }
});
