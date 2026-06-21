# Stack para jogo multijogador online — análise

> Documento de decisão. A stack colada originalmente é do projeto **Lumaro**
> (app de conteúdo/IA + WordPress). Aqui separamos o que **aproveita** para um
> jogo multijogador do que **descarta**, e definimos o backend de tempo real.

## 1. O ponto mais importante: a Vercel NÃO hospeda o servidor do jogo

As Serverless Functions da Vercel **não suportam WebSocket** — cada invocação
termina depois de responder, então não existe processo persistente para manter
a conexão aberta nem para "ser dono" do estado autoritativo de uma sala/partida.

**Conclusão de arquitetura:**

- **Vercel** = hospeda o *cliente web* (landing, lobby, Next.js/Vite). ✅
- **Servidor de tempo real** = vive **fora** da Vercel (BaaS de realtime ou
  container dedicado). ✅

## 2. Aproveita vs. descarta da stack Lumaro

| Aproveita (serve para o jogo) | Descarta (era específico do Lumaro) |
|---|---|
| React 19 / React Native / Expo Router | Deploy de tema WordPress via FTP (`deploy.js`) |
| TypeScript strict | Edge Functions de conteúdo: ingest-rss, generate-post, publish-wp |
| NativeWind + Tailwind + tailwind-variants | RAG / pipeline de IA de conteúdo |
| TanStack Query (+ persister) | WordPress REST / imagens Pexels |
| Zod (validação de mensagens de rede também!) | Vercel AI SDK (a não ser que tenha NPC com IA) |
| Reanimated / Gesture Handler / Skia | i18next pode ficar, mas não é prioridade |
| Supabase (auth, perfis, leaderboard, persistência) | lottie/confetti são cosméticos (manter se quiser) |

## 3. Backend de tempo real — opções (todas TS-friendly)

| Opção | Modelo | Quando usar | Hospedagem |
|---|---|---|---|
| **Colyseus** | Servidor autoritativo em Node/TS, salas com estado | **Recomendado** para o time TS. Controle total, schema binário, prediction/reconciliation | Colyseus Cloud, Railway, Render, Fly.io |
| **Nakama** | BaaS open-source (Go) "baterias inclusas" | Quer matchmaking + leaderboard + chat + auth prontos sem montar | Heroic Cloud, self-host (Docker) |
| **PartyKit (Cloudflare)** | Durable Objects, sala = 1 objeto stateful no edge | Realtime mais leve, baixa latência global, serverless de verdade | Cloudflare |
| **Photon (Fusion/Quantum)** | BaaS líder p/ ação rápida | Ação competitiva pesada (FPS, fighting); ecossistema Unity | Exit Games (gerenciado) |
| **Supabase Realtime / Ably / Pusher** | Pub/sub, sem estado autoritativo | **Só turn-based** (xadrez, cartas, quiz) | Gerenciado |

## 4. Recomendação por gênero (decisão que falta confirmar)

O "melhor" depende do tipo de jogo:

- **Turn-based** (cartas, tabuleiro, quiz, palavras): **Supabase Realtime**
  (já está na stack) ou Ably. Simples, barato, sem servidor de tick.
- **Realtime casual / .io / co-op (2–8 players)**: **Colyseus** (TS, autoritativo,
  encaixa no time) — recomendação padrão.
- **Ação competitiva pesada (baixa latência, anti-cheat forte)**: **Photon** ou
  Nakama + servidor dedicado.

## 5. Stack recomendada (default: realtime casual, web + mobile)

```
Cliente:    React / React Native (Expo) + Expo Router
            NativeWind + Tailwind + tailwind-variants
            TanStack Query · Zod · Reanimated
Realtime:   Colyseus (Node/TS, autoritativo, schema binário)
Auth/Dados: Supabase (auth, perfis, leaderboard, histórico)
Web host:   Vercel (cliente/landing)  ← só o front
Game host:  Railway / Fly.io / Colyseus Cloud  ← o servidor
Protocolo:  WebSocket + serialização binária (msgpack/protobuf)
            tick 20–60Hz · client-side prediction · server reconciliation
```

## Próximo passo

Definir o **gênero do jogo** para travar Colyseus vs. Supabase-Realtime vs. Photon.
