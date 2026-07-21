// engine/engine.mjs
//
// MOTOR DE REGRAS DA ARENA ZW — puro, determinístico, SEM interface.
// Extraído fielmente de index.html (a Arena que já roda em /arena). Mesmo
// comportamento, byte a byte — travado por engine.test.mjs.
//
// Usado por: (1) a Arena atual (quando migrarmos o index.html pra importar isto)
// e (2) a nova Arena na stack do portal (Expo/RN). Nada de DOM/rede aqui.
//
// API principal:
//   newFighter(name, maxLevel) -> fighter
//   createState(p1, p2)        -> { p1, p2, turn, over, winner }
//   resolveTurn(state, subA, subB, bids?) -> { state, events, needBid? }
//     sub = { moveId, speed, xbonus? }    "A"=p1, "B"=p2 (clientes calculam igual)
//
// Determinístico: sem Math.random — dois clientes com as mesmas submissões
// chegam ao mesmo resultado (base do multiplayer por mensagens).

/* ============ DADOS DE GOLPES (RZW 5.0) ============ */
export const GOLPES = [
  // nome, dano, ki, te
  ["Ashikara Kame Hame Ha",12,14,1],["Big Bang Attack",18,20,1],["Burning Attack",16,18,1],
  ["Cho Kame Hame Ha",26,40,1],["Daichiretsuzan",20,30,1],["Dodonpa",6,6,1],
  ["Dragon Fist",100,130,1],["Dragon Thunder",70,90,1],["Energy Spartor",6,6,1],
  ["Eraser Cannon",16,18,1],["Eye Beam",8,8,1],["Final Flash",20,30,1],["Galick Ho",16,18,1],
  ["Kame Hame Ha",18,20,1],["Kienzan",12,14,1],["Kikoha",8,10,1],["Kikoho",14,16,1],
  ["Makankosappo",16,18,1],["Masenko",14,16,1],["Riogafuufuken",8,10,1],["Solar Attack",50,75,1],
  ["Super Dodonpa",10,12,1],["Strange Fire",40,60,1],["Super Kame Hame Ha",80,100,1],
  // carga (referência — desabilitados em v0.1)
  ["Barekutsuhama",20,10,2],["Chame Saikoda",45,30,2],["Crasher Ball",36,24,2],
  ["Death Ball",90,36,3],["Genki Dama",70,30,3],["Honoo",26,12,2],["Power Ball (7 esferas)",300,200,3],
  ["Revenge Death Ball",180,150,2],
];

// monta lista de moves "draftáveis" + livres + habilidades
export const MOVES = {};
function reg(m){ MOVES[m.id]=m; return m; }
let _id=0; const nid=()=>"m"+(_id++);

GOLPES.forEach(([name,dano,ki,te])=>{
  reg({id:nid(),name,kind:"golpe",dano,ki,te,charge:te>1});
});

// golpes sempre disponíveis
export const SOCO = reg({id:"soco",name:"Soco",kind:"golpe",dano:1,ki:0,te:1,free:true});
export const CHUTE= reg({id:"chute",name:"Chute",kind:"golpe",dano:1,ki:0,te:1,free:true});

// habilidades (draftáveis) — handlers customizados
reg({id:"shunkanido",name:"Shunkanido",kind:"esquiva",ki:10,te:1,
  desc:"Esquiva de 1 ataque (vence/empata) e +1 de velocidade no próximo turno."});
reg({id:"barrier",name:"Barrier",kind:"defesa",ki:15,te:1,
  desc:"Bloqueia 1 técnica por inteiro (vence/empata). Não toma dano nenhum."});
reg({id:"regeneration",name:"Regeneration",kind:"cura",ki:15,te:1,hp:15,
  desc:"+15 HP (vence/empata)."});
reg({id:"kaioken",name:"Kaioken",kind:"buff",ki:15,te:1,
  desc:"+5 em todos os danos até o fim da luta (vence/empata)."});

// habilidades sempre disponíveis (livres)
export const CONCENTRAR = reg({id:"concentrar",name:"Carregar KI",kind:"concentra",ki:0,te:1,free:true,
  desc:"+10 KI · não usa velocidade · mas fica sem defesa o turno todo"});
export const DEFESA = reg({id:"defesa",name:"Defesa Simples",kind:"defesa_simples",ki:0,te:1,free:true,
  desc:"Metade do dano recebido (vence/empata)."});
export const TRANSFORMAR = reg({id:"transformar",name:"Transformar ▲",kind:"transforma",ki:0,te:1,free:true,
  desc:"Sobe 1 nível (+1 no seu número) · ganha HP, KI, velocidade e dano"});

export const DRAFTABLE = Object.values(MOVES).filter(m=>!m.free);
export const KI_CAP = 100;   // nível 0
export const PICK_COUNT = 3; // golpes escolhidos no início (demo)
// --- níveis / transformações (RZW: HP e KI somam entre níveis; velocidade e dano são os do nível atual) ---
export const LVL_HP  = {1:80, 2:100, 3:110, 4:130};
export const LVL_KI  = {1:80, 2:90,  3:100, 4:110};
export const LVL_VEL = {0:0, 1:1, 2:2, 3:3, 4:4};
export const LVL_DANO= {0:0, 1:5, 2:10, 3:15, 4:20};
export const LVL_CAP = {0:100, 1:220, 2:320, 3:430, 4:99999};
export const LVL_NAME= {0:"Base", 1:"SSJ", 2:"SSJ2", 3:"SSJ3", 4:"SSJ4"};
export const TURN_SECONDS = 30; // tempo pra escolher ação + velocidade
export const BID_SECONDS  = 20; // tempo pra resolver o choque de KI
export const NO_SPEED = new Set(["concentrar"]); // ações que NÃO exigem número de velocidade

/* ============ ENGINE (puro / determinístico) ============ */
export function newFighter(name, maxLevel){
  return { name, hp:50, maxHp:50, ki:50, speeds:[1,2,3,4,5,6,7,8,9,10],
           level:0, maxLevel:(maxLevel||0), kiCap:100,
           moves:[], effects:{ kaioken:false, speedBonusNext:0, lvlSpeed:0, lvlDano:0 } };
}

/** Estado inicial de uma luta. p1 = "A", p2 = "B". */
export function createState(p1, p2){
  return { p1, p2, turn:1, over:false, winner:null };
}

function clampF(f,v){ return Math.max(0, Math.min(f.kiCap||KI_CAP, v)); }
function dmgOf(move, fighter){
  let d = move.dano||0;
  if(move.kind==="golpe" && d>0){
    if(fighter.effects.kaioken) d += 5;
    d += (fighter.effects.lvlDano||0);
  }
  return d;
}
function classify(move){
  if(["golpe"].includes(move.kind)) return "ATAQUE";
  if(["defesa","defesa_simples"].includes(move.kind)) return "DEFESA";
  if(move.kind==="esquiva") return "ESQUIVA";
  if(move.kind==="cura"||move.kind==="buff"||move.kind==="concentra") return "UTIL";
  return "UTIL";
}

// sub = { moveId, speed, xbonus? }
function effSpeed(sub, f){ return sub.speed + (sub.xbonus||0) + (f.effects.lvlSpeed||0) + (f.effects.speedBonusNext||0); }

export function resolveTurn(state, subA, subB, bids){
  // clona
  const S = JSON.parse(JSON.stringify(state));
  const a=S.p1, b=S.p2;
  const mA=MOVES[subA.moveId], mB=MOVES[subB.moveId];
  const ev=[];
  const sa=effSpeed(subA,a), sb=effSpeed(subB,b);

  // consumir bônus de velocidade (foi usado este turno)
  a.effects.speedBonusNext=0; b.effects.speedBonusNext=0;

  const cA=classify(mA), cB=classify(mB);
  const aWins = sa>sb, bWins = sb>sa, tie = sa===sb;

  // ---- choque de KI (dois ataques empatados) ----
  if(tie && cA==="ATAQUE" && cB==="ATAQUE"){
    if(!bids) return { needBid:true };
    const bidA=Math.max(0,Math.min(bids.a||0, a.ki - (mA.ki||0)));
    const bidB=Math.max(0,Math.min(bids.b||0, b.ki - (mB.ki||0)));
    a.ki=clampF(a, a.ki-(mA.ki||0)-bidA);
    b.ki=clampF(b, b.ki-(mB.ki||0)-bidB);
    ev.push({t:"info",x:`Choque de KI! ${a.name} investe ${bidA} · ${b.name} investe ${bidB}.`});
    if(bidA>bidB){ apply(b,a,mA,ev); ev.push({t:"info",x:`O golpe de ${b.name} foi anulado.`}); }
    else if(bidB>bidA){ apply(a,b,mB,ev); ev.push({t:"info",x:`O golpe de ${a.name} foi anulado.`}); }
    else { apply(b,a,mA,ev); apply(a,b,mB,ev); ev.push({t:"info",x:`KI empatou — os dois golpes acertam!`}); }
    finishTurn(S,subA,subB,ev); return { state:S, events:ev };
  }

  // ---- resolução padrão ----
  // defesas/esquivas resolvem com vencer OU empatar (exceção da regra)
  const aDefends = (cA==="DEFESA"||cA==="ESQUIVA") && (sa>=sb);
  const bDefends = (cB==="DEFESA"||cB==="ESQUIVA") && (sb>=sa);

  // ações de A
  resolveSide(a,b,subA,mA,cA,aWins||tie, bDefends?mB:null, ev);
  // ações de B
  resolveSide(b,a,subB,mB,cB,bWins||tie, aDefends?mA:null, ev);

  finishTurn(S,subA,subB,ev);
  return { state:S, events:ev };
}

function resolveSide(self, foe, sub, move, cls, qualifies, foeDef, ev){
  // ATAQUE: precisa vencer estrito (empate vira choque, já tratado).
  if(cls==="ATAQUE"){
    if((self.ki) < (move.ki||0)){ ev.push({t:"info",x:`${self.name} não tinha KI pra ${move.name}.`}); return; }
    self.ki=clampF(self, self.ki-(move.ki||0));  // regra do juiz: todo golpe gasta KI SEMPRE, mesmo perdendo/errando
    if(!qualifies){ ev.push({t:"info",x:`${self.name} foi mais lento — ${move.name} não saiu, mas gastou ${move.ki||0} de KI.`}); return; }
    // defesa do oponente?
    if(foeDef && foeDef.kind==="barrier"){ ev.push({t:"info",x:`${foe.name} ergue o Barrier e absorve o ${move.name} por inteiro!`}); return; }
    if(foeDef && foeDef.kind==="esquiva"){ ev.push({t:"info",x:`${foe.name} usa Shunkanido e some — o ${move.name} passa direto!`}); foe.effects.speedBonusNext=1; return; }
    let d=dmgOf(move,self);
    if(foeDef && (foeDef.kind==="defesa"||foeDef.kind==="defesa_simples")){ d=Math.floor(d/2); ev.push({t:"info",x:`${foe.name} se defende — dano pela metade.`}); }
    foe.hp=Math.max(0,foe.hp-d);
    ev.push({t:"dmg",x:`${self.name} acerta ${move.name} em ${foe.name} — ${d} de dano!`});
    return;
  }
  // ações não-ataque resolvem com vencer/empatar (concentrar sempre resolve)
  if(cls==="UTIL"){
    if(move.kind==="transforma"){
      if(!qualifies){ ev.push({t:"info",x:`${self.name} tentou se transformar mas foi mais lento.`}); return; }
      if((self.level||0) >= (self.maxLevel||0)){ ev.push({t:"info",x:`${self.name} já está no nível máximo.`}); return; }
      const L = self.level = (self.level||0)+1;
      self.hp += (LVL_HP[L]||0);
      self.maxHp = (self.maxHp||50) + (LVL_HP[L]||0);
      self.kiCap = LVL_CAP[L] || self.kiCap;
      self.ki = clampF(self, self.ki + (LVL_KI[L]||0));
      self.effects.lvlSpeed = LVL_VEL[L]||0;   // não soma: é o valor do nível atual
      self.effects.lvlDano  = LVL_DANO[L]||0;
      ev.push({t:"heal",x:`${self.name} explode em ${LVL_NAME[L]}! +${LVL_HP[L]} HP, +${LVL_KI[L]} KI, velocidade +${LVL_VEL[L]}, dano +${LVL_DANO[L]}.`});
      return;
    }
    if(move.kind==="concentra"){ const before=self.ki; self.ki=clampF(self, self.ki+10); ev.push({t:"info",x:`${self.name} concentra KI (+${self.ki-before}). Fica vulnerável.`}); return; }
    if(!qualifies){ ev.push({t:"info",x:`${self.name} foi mais lento e não conseguiu usar ${move.name}.`}); return; }
    if(self.ki<(move.ki||0)){ ev.push({t:"info",x:`${self.name} sem KI pra ${move.name}.`}); return; }
    self.ki=clampF(self, self.ki-(move.ki||0));
    if(move.kind==="cura"){ self.hp+=move.hp; ev.push({t:"heal",x:`${self.name} usa Regeneration (+${move.hp} HP).`}); }
    if(move.kind==="buff"){ self.effects.kaioken=true; ev.push({t:"info",x:`${self.name} ativa Kaioken! +5 em todos os danos.`}); }
    return;
  }
  // DEFESA/ESQUIVA sem ataque pra defender
  if(cls==="DEFESA"||cls==="ESQUIVA"){
    if(qualifies){
      if(self.ki<(move.ki||0)){ ev.push({t:"info",x:`${self.name} sem KI pra ${move.name}.`}); return; }
      self.ki=clampF(self, self.ki-(move.ki||0));
      if(move.kind==="esquiva"){ self.effects.speedBonusNext=1; ev.push({t:"info",x:`${self.name} usa Shunkanido (+1 de velocidade no próximo turno).`}); }
      else ev.push({t:"info",x:`${self.name} fica em guarda (${move.name}).`});
    } else {
      ev.push({t:"info",x:`${self.name} tentou ${move.name} mas perdeu no número.`});
    }
  }
}

function apply(target, attacker, move, ev){
  if(attacker.ki<(move.ki||0)){ ev.push({t:"info",x:`${attacker.name} sem KI pra ${move.name}.`}); return; }
  const d=dmgOf(move,attacker);
  target.hp=Math.max(0,target.hp-d);
  ev.push({t:"dmg",x:`${attacker.name} acerta ${move.name} em ${target.name} — ${d} de dano!`});
}

function finishTurn(S,subA,subB){
  consumeSpeed(S.p1,subA.speed); consumeSpeed(S.p2,subB.speed);
  S.turn=(S.turn||1)+1;
  S.over = S.p1.hp<=0 || S.p2.hp<=0;
  if(S.over){
    if(S.p1.hp<=0 && S.p2.hp<=0) S.winner="empate";
    else S.winner = S.p1.hp<=0 ? "p2" : "p1";
  }
}
function consumeSpeed(f,n){ f.speeds=f.speeds.filter(x=>x!==n); if(f.speeds.length===0) f.speeds=[1,2,3,4,5,6,7,8,9,10]; }

/** Helper de teste/UI: acha um move pelo nome exato. */
export function moveByName(name){ return Object.values(MOVES).find(m=>m.name===name); }
