// engine/engine.test.mjs
//
// Trava o comportamento ATUAL da Arena (o que index.html já faz). Se algum
// número mudar, estes testes quebram — é a garantia de "nada muda" ao migrar
// o motor pra stack do portal. Rode: node --test engine/
//
// Sem dependências (node:test embutido).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newFighter, createState, resolveTurn, moveByName } from './engine.mjs';

const KHH = moveByName('Kame Hame Ha');        // dano 18, ki 20
const FINAL = moveByName('Final Flash');        // dano 20, ki 30

test('luta normal: quem tem velocidade maior acerta; o golpe do mais lento falha mas gasta KI', () => {
  const state = createState(newFighter('Goku'), newFighter('Vegeta'));
  const r = resolveTurn(
    state,
    { moveId: KHH.id, speed: 9 },   // Goku (p1) mais rápido
    { moveId: FINAL.id, speed: 2 }, // Vegeta (p2) mais lento, mas gasta KI
  );
  assert.equal(r.needBid, undefined);
  assert.equal(r.state.p1.ki, 30);   // 50 - 20 (KHH)
  assert.equal(r.state.p1.hp, 50);   // não tomou dano
  assert.equal(r.state.p2.hp, 32);   // 50 - 18 (KHH)
  assert.equal(r.state.p2.ki, 20);   // 50 - 30 (Final Flash gasta KI mesmo perdendo)
  assert.equal(r.state.turn, 2);
  assert.equal(r.state.over, false);
  // velocidade usada sai da lista (e a lista não zerou ainda)
  assert.ok(!r.state.p1.speeds.includes(9));
  assert.equal(r.state.p1.speeds.length, 9);
  assert.ok(r.events.some(e => e.t === 'dmg' && /18 de dano/.test(e.x)));
});

test('defesa simples reduz o dano pela metade no empate de velocidade', () => {
  const state = createState(newFighter('Goku'), newFighter('Vegeta'));
  const r = resolveTurn(
    state,
    { moveId: KHH.id, speed: 5 },     // ataque
    { moveId: 'defesa', speed: 5 },   // defesa simples, empate → defende
  );
  assert.equal(r.state.p2.hp, 41);   // 50 - floor(18/2)=9
  assert.equal(r.state.p1.ki, 30);   // gastou KI do KHH
  assert.ok(r.events.some(e => /dano pela metade/.test(e.x)));
});

test('choque de KI: empate de dois ataques pede bid; maior investida vence e anula o outro', () => {
  const state = createState(newFighter('Goku'), newFighter('Vegeta'));
  const sub = [{ moveId: KHH.id, speed: 7 }, { moveId: FINAL.id, speed: 7 }];

  // sem bids → precisa resolver o choque
  const need = resolveTurn(state, sub[0], sub[1]);
  assert.equal(need.needBid, true);
  assert.equal(need.state, undefined);

  // com bids: Goku investe 10, Vegeta 5 → Goku vence o choque
  const r = resolveTurn(state, sub[0], sub[1], { a: 10, b: 5 });
  assert.equal(r.state.p1.ki, 20);   // 50 - 20 (KHH) - 10 (bid)
  assert.equal(r.state.p2.ki, 15);   // 50 - 30 (Final) - 5 (bid)
  assert.equal(r.state.p2.hp, 32);   // tomou o KHH de 18; golpe do Vegeta anulado
  assert.equal(r.state.p1.hp, 50);
});

test('transformação (SSJ): subir de nível soma HP/KI e aumenta o cap, velocidade e dano', () => {
  const state = createState(newFighter('Goku', 4), newFighter('Vegeta'));
  const r = resolveTurn(
    state,
    { moveId: 'transformar', speed: 9 }, // ganha o número → transforma
    { moveId: 'soco', speed: 2 },
  );
  const g = r.state.p1;
  assert.equal(g.level, 1);
  assert.equal(g.hp, 130);          // 50 + 80
  assert.equal(g.maxHp, 130);
  assert.equal(g.kiCap, 220);       // LVL_CAP[1]
  assert.equal(g.ki, 130);          // clamp(50 + 80, cap 220)
  assert.equal(g.effects.lvlSpeed, 1);
  assert.equal(g.effects.lvlDano, 5);
  assert.ok(r.events.some(e => /SSJ/.test(e.x)));
});

test('pós-transformação: o bônus de dano do nível entra nos golpes seguintes', () => {
  let state = createState(newFighter('Goku', 4), newFighter('Vegeta'));
  state = resolveTurn(state, { moveId: 'transformar', speed: 9 }, { moveId: 'soco', speed: 2 }).state;
  const r = resolveTurn(state, { moveId: KHH.id, speed: 9 }, { moveId: 'soco', speed: 2 });
  assert.equal(r.state.p2.hp, 27);   // 50 - (18 + 5 de bônus SSJ) = 27
});

test('transformação falha se for mais lento (não gasta o número à toa)', () => {
  const state = createState(newFighter('Goku', 4), newFighter('Vegeta'));
  const r = resolveTurn(
    state,
    { moveId: 'transformar', speed: 2 }, // mais lento
    { moveId: 'soco', speed: 9 },
  );
  assert.equal(r.state.p1.level, 0);   // não transformou
  assert.equal(r.state.p1.hp, 49);     // levou o soco do mais rápido (1 de dano)
});
