# ZW Project — plano técnico (v0.1)

Jogo de fã baseado nas **Regras de Luta Z Warriors 5.0**. Web primeiro, app depois.
Sem fins comerciais. Donos da ideia/regras: clã Z Warriors (Clebler). Devs: Filipe, Rafael.

---

## 1. O que o jogo é (e por que isso define a tech)

ZW é um **PvP por turnos com juiz**, não um jogo de ação. Cada turno:

1. Os dois lutadores mandam **em segredo** uma ação + um número de velocidade (1–10).
2. Maior velocidade = ação **ativa**; menor = **inativa** (não gasta KI).
3. Empate entre dois golpes → **choque de KI** (lance secreto; maior vence e anula o outro; empate = os dois acertam).
4. Defesas/esquivas/rebates são exceção: resolvem **vencendo OU empatando**.
5. Há **T.E.** (turnos de carga), **concentração de KI**, **níveis/SSJ**, **fusões** e **lutas em equipe**.

**Consequência técnica decisiva:** não há aleatoriedade. Velocidade e KI são escolhas dos jogadores.
Logo a **resolução do turno é 100% determinística** — dois clientes com as mesmas submissões
calculam exatamente o mesmo resultado. Isso significa:

- O "juiz" pode ser **o próprio código** (motor de regras).
- Para 3 amigos que confiam entre si, **nem precisa de servidor autoritativo** na demo: basta trocar
  as submissões entre os clientes e cada um resolve igual.
- O multiplayer vira **passar mensagens** (submeti / revelei / choque de KI). Trivial.

O trabalho difícil **não é rede** — é o **motor de regras** (replicar fielmente o juiz humano).

---

## 2. Decisão de stack

### Fase 0 — protótipo de teste (AGORA) → `index.html`
Web puro, um arquivo só. Sem build, sem npm: abre e joga.
- **Motor** = TypeScript/JS puro, determinístico, portável.
- **Rede** = `Transport` abstrato. Hoje tem 2 implementações:
  - `LocalTransport` (BroadcastChannel) → testar em 2 abas, instantâneo, zero setup.
  - `SupabaseTransport` (Realtime broadcast) → joga pela internet; entra sozinho quando você cola as chaves.
- Sem login: nick + código de sala (como os jogos de demo de Supabase fazem).

**Por que web puro e não já o Expo:** o que precisamos testar primeiro é se **as regras são divertidas e
corretas**. Web puro chega nisso em minutos. E não é trabalho jogado fora: **o motor é o mesmo TS** que
vai pro app — é só portar a UI.

### Fase 1+ — app de verdade (depois que as regras estiverem boas)
Aproveitar o **núcleo** do stack lumaro (ótimo pra "web agora, app depois"):

**Mantém:**
- Expo ~54 + React Native 0.81 + React 19 → mesmo código vira web (RN Web) **e** app iOS/Android.
- Expo Router · TypeScript strict.
- NativeWind + Tailwind + tailwind-variants (tema).
- TanStack Query 5 (estado de servidor) · Zod (validação de payloads de turno).
- Supabase (Auth + Postgres + Realtime + Edge Functions).
- i18next (PT/EN) · reanimated/gesture-handler (animações de aura/golpe) · confetti (vitória).
- EAS (build/submit/update) · ESLint/Prettier · Playwright (testes da UI/engine).

**Descarta (é da vida de blog/CMS do lumaro, não do jogo):**
- WordPress REST · `deploy.js`/FTP · Pexels.
- Edge Functions de conteúdo: `ingest-rss`, `ingest-knowledge`, `generate-post`, `portal-chat`, `publish-wp`, `post-image`.
- RAG / Vercel AI / pgvector · lottie do chat · charts (opcional: dá pra reusar pro "poder de luta").

**Fica em dúvida (decidir depois):** Gluestack UI — útil se quiser componentes prontos; dá pra viver só
com NativeWind. Mantém por ora, sem obrigação.

### Sobre "game servers" dedicados (pesquisa)
Avaliei **Colyseus** (Node/TS, ótimo p/ salas e turnos), **Nakama** (Go, completo: matchmaking, chat,
leaderboards — curva mais íngreme) e **PartyKit** (Cloudflare Durable Objects, edge).
**Veredito:** para ZW (turnos, determinístico, poucos jogadores) **Supabase Realtime basta e sobra** —
menos intermediários, e você já tem Supabase no stack. Só vale migrar pra Colyseus/Nakama se um dia
quiser **servidor autoritativo anti-cheat** ou **torneios/lobby massivo**. Não é o caso da demo.

### Anti-cheat (quando importar)
Hoje a resolução é no cliente (confiável entre amigos). Quando abrir pra estranhos, mover a função
`resolveTurn` para uma **Edge Function** do Supabase (mesma TS, sem reescrever) e guardar as submissões
secretas no Postgres até os dois enviarem. O motor não muda — só onde ele roda.

---

## 3. O que já está implementado no `index.html` (v0.1)

- Loop completo de turno 1×1: submissão secreta → revelação → resolução → narração do juiz.
- Comparação de velocidade, ação ativa/inativa (inativa não gasta KI).
- **Choque de KI** no empate de golpes (lance secreto dos dois lados).
- **Concentração de KI** (+10), com vulnerabilidade.
- **Defesa Simples** (metade do dano, resolve vencendo/empatando).
- **Shunkanido** (esquiva + bônus de velocidade no próximo turno).
- **Barrier** (bloqueio total), **Regeneration** (+15 HP), **Kaioken** (+5 dano permanente).
- Soco/Chute sempre disponíveis (fora dos 5).
- Todos os **golpes de T.E.=1** da tabela (dano/KI corretos). Limite de KI nível 0 = 100.
- Velocidade não repete até zerar (e reseta 1–10).
- Condição de vitória (HP ≤ 0) e duplo K.O.
- Multiplayer local (2 abas) **funcionando**; Supabase pronto para plugar.

### Simplificações conscientes (a revisar com você)
- Exijo número de velocidade para **toda** ação (no original, várias habilidades não pedem número).
- Util (cura/buff/concentrar) resolve vencendo/empatando; concentrar sempre resolve.
- Sem T.E.>1, sem fusão, sem níveis/transformação, sem equipe, sem rebater golpe ainda.

---

## 4. Roadmap (ordem sugerida)

1. **Golpes de carga (T.E.>1):** estado "carregando" por N turnos, defesa simples no turno do meio,
   Genki Dama / Cho Genki Dama / Death Ball / Power Ball. (Alto valor — golpes icônicos.)
2. **Resto das habilidades** como dados + handlers: Tayoken, Galatica Donut, Energy Kiushu, Psicokinesys,
   Regeneration/Super, Kaioken (variantes ×N), Body Change, etc.
3. **Níveis/Evolução + transformação:** bônus de HP/KI/veloc/dano por nível, +1 no número de transformação,
   golpes adicionais (6 no nv3, 7 no nv4), limites de KI por nível.
4. **Persistência:** tabela `players` (nick, vitórias, nível, Zenny) no Postgres + RLS. Contagem de vitórias → evolução.
5. **Equipe (2×2 / 2×1)** e o papel de **juiz humano** opcional (ação diversa/narração).
6. **Port pro Expo** (UI nova, **mesmo motor**), tema NativeWind, animações de aura.
7. **Suíte de testes do motor** (Playwright/Vitest): cada regra do RZW vira um caso de teste — é o que garante
   "fidelidade ao juiz".

---

## 5. Para jogar pela internet (Filipe × Rafael × Clebler)

1. Criar projeto grátis no Supabase → pegar **Project URL** + **publishable/anon key** (a pública, do client).
2. Em `index.html`, preencher `CONFIG.supabaseUrl` e `CONFIG.supabaseAnonKey`.
3. Habilitar Realtime (Broadcast/Presence já vêm ligados) e liberar o padrão de canal `zw-*`.
4. Hospedar o arquivo (Vercel/Netlify/GitHub Pages) e mandar o link. Mesma sala = mesma luta.
   > Obs.: dentro deste sandbox de chat o carregamento do supabase-js por CDN pode ser bloqueado;
   > rode o arquivo no navegador normal / hospedado para o modo online.

---

## 6. O que eu preciso de você (quando voltar do jogo)

1. **Chaves do Supabase** (ou crio a estrutura e você só pluga).
2. **Confirmar as simplificações** da seção 3 — principalmente: habilidades sem número de velocidade
   devem mesmo dispensar o número? E concentrar deve sempre resolver mesmo perdendo no número?
3. **Prioridade de conteúdo:** quais golpes/habilidades/transformações você quer ver funcionando primeiro
   pra demo com o Clebler?
4. **Começamos já em nível 0** (sem SSJ) na demo, certo? Ou quer um modo "sandbox" pra testar SSJ4?

---

## 7. Repo

`index.html` + este `ZW-PLAN.md` são a semente. Eu não tenho como dar `git push` (não entro com
credenciais), então é só commitar:

```bash
git add index.html ZW-PLAN.md
git commit -m "feat: protótipo jogável v0.1 (motor de turno 1x1 + multiplayer local/Supabase)"
git push
```

A partir daí, o Claude Code pode refatorar o `index.html` num projeto modular (`/engine`, `/net`, `/ui`)
e seguir o roadmap.
