// supabase/functions/gamify/index.ts
//
// Gamificação server-side (service_role) — o cliente NUNCA se autoconcede badge.
// O cliente chama com o JWT do usuário (Authorization: Bearer <access_token>) e
// uma ação; a função registra atividade/leitura, recalcula tudo a partir das
// tabelas e concede os badges que faltam.
//
// Body: { action: "visit" | "read" | "sync" }
// Resp: { stats:{...}, awarded:[badge_code...] }
//
// Catálogo (badges.code): primeiro_dia, leitor_iniciante(10), devorador_sagas(50),
// enciclopedia_z(150), streak_7, streak_30, curioso, colecionador(save 10),
// joia_rara(like 10), recrutador(1), sensei(5), lenda_zw(20).

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function bearer(req: Request): string {
  return (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  const json = (b: unknown, s = 200) =>
    new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } });
  if (!SUPABASE_URL || !SERVICE) return json({ error: 'env' }, 500);

  const svc = createClient(SUPABASE_URL, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } });
  try {
    const { data: { user }, error: uerr } = await svc.auth.getUser(bearer(req));
    if (uerr || !user) return json({ error: 'auth' }, 401);
    const uid = user.id;
    const action = String((await req.json().catch(() => ({})))?.action ?? 'sync');
    const today = new Date().toISOString().slice(0, 10);

    // garante a linha do dia (conta como "dia de uso") e incrementa leituras
    const { data: actRow } = await svc.from('user_activity').select('reads').eq('user_id', uid).eq('day', today).maybeSingle();
    let reads = actRow?.reads ?? 0;
    if (action === 'read') reads += 1;
    await svc.from('user_activity').upsert({ user_id: uid, day: today, reads });

    // estatísticas
    const { data: days } = await svc.from('user_activity').select('day,reads').eq('user_id', uid);
    const totalReads = (days ?? []).reduce((a, d) => a + (d.reads ?? 0), 0);
    const totalDays = (days ?? []).length;
    const daySet = new Set((days ?? []).map((d) => d.day));
    let streak = 0;
    const cur = new Date(today + 'T00:00:00Z');
    while (daySet.has(cur.toISOString().slice(0, 10))) { streak++; cur.setUTCDate(cur.getUTCDate() - 1); }

    const { data: inters } = await svc.from('content_interactions').select('source_type,kind').eq('user_id', uid);
    const likes = (inters ?? []).filter((i) => i.kind === 'like').length;
    const saves = (inters ?? []).filter((i) => i.kind === 'save').length;
    const curioInter = (inters ?? []).filter((i) => i.source_type === 'curiosity').length;
    const { count: refCount } = await svc.from('referrals').select('*', { count: 'exact', head: true }).eq('referrer_id', uid);
    const refs = refCount ?? 0;

    const conds: Record<string, boolean> = {
      primeiro_dia: totalDays >= 1,
      leitor_iniciante: totalReads >= 10,
      devorador_sagas: totalReads >= 50,
      enciclopedia_z: totalReads >= 150,
      streak_7: streak >= 7,
      streak_30: streak >= 30,
      curioso: curioInter >= 10,
      colecionador: saves >= 10,
      joia_rara: likes >= 10,
      recrutador: refs >= 1,
      sensei: refs >= 5,
      lenda_zw: refs >= 20,
    };
    const { data: have } = await svc.from('user_badges').select('badge_code').eq('user_id', uid);
    const haveSet = new Set((have ?? []).map((b) => b.badge_code));
    const toAward = Object.entries(conds).filter(([c, ok]) => ok && !haveSet.has(c)).map(([c]) => ({ user_id: uid, badge_code: c }));
    if (toAward.length) await svc.from('user_badges').insert(toAward); // service_role ignora RLS

    return json({ stats: { totalReads, totalDays, streak, likes, saves, refs }, awarded: toAward.map((b) => b.badge_code) });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
