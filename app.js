import { HandLandmarker, FilesetResolver } from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.0";

const ui = {
  score: document.getElementById("score"),
  combo: document.getElementById("combo"),
  streak: document.getElementById("streak"),
  hp: document.getElementById("hp"),
  hint: document.getElementById("hint"),
  btnStart: document.getElementById("btnStart"),
  btnPause: document.getElementById("btnPause"),
  btnReset: document.getElementById("btnReset"),
  bossbar: document.getElementById("bossbar"),
  bossname: document.getElementById("bossname"),
  bossfill: document.getElementById("bossfill"),
};

const video = document.getElementById("video");
const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");

// ---- GIF sprites (animated) ----
const monsterGifEl = document.getElementById("monsterGif");
const bossGifEl = document.getElementById("bossGif");

let monsterGifReady = false;
let bossGifReady = false;

monsterGifEl.addEventListener("load", () => { monsterGifReady = true; });
bossGifEl.addEventListener("load", () => { bossGifReady = true; });

// 若 GitHub Pages 快取造成更新不到，可加 querystring（可選）
// monsterGifEl.src = "./monster.gif?v=4";
// bossGifEl.src = "./boss.gif?v=4";


// ---- Image background (castle) ----
const castleImg = new Image();
castleImg.src = "./castle_bg.jpg?v=2";  // cache bust
let castleReady = false;

castleImg.onload = () => { 
  castleReady = true; 
  console.log("castle bg loaded:", castleImg.naturalWidth, castleImg.naturalHeight);
};
castleImg.onerror = () => {
  console.warn("Failed to load castle background image:", castleImg.src);
  castleReady = false;
};


// -------------------- MediaPipe --------------------
let landmarker = null;

// -------------------- Game State --------------------
let running = false;
let paused = false;

let score = 0;
let streak = 0;
let hp = 10;

let monsters = [];   // regular enemies (3D)
let boss = null;     // boss entity (3D)
let beams = [];      // spell beams (3D)
let particles = [];  // particles (2D after projection)

let lastSpawnMs = 0;
let spawnIntervalMs = 850;
let difficulty = 1;

const HAND_COOLDOWN_MS = 280;

// combo
let combo = 1.0;
let lastHitMs = 0;
const COMBO_DECAY_MS = 1400;  // if no hit, combo decays back to 1
const COMBO_STEP = 0.08;
const COMBO_MAX = 3.0;

// boss trigger
const BOSS_SCORE_STEP = 250;  // every 250 score -> boss
let nextBossAt = BOSS_SCORE_STEP;

// worldLandmarks palm push detection
const handState = {
  Left:  { lastCastMs: 0, lastZ: null, lastTs: 0 },
  Right: { lastCastMs: 0, lastZ: null, lastTs: 0 },
};

// Thresholds you can tune
const TH = {
  // "push" is mostly from z-velocity in world coordinates
  // NOTE: depending on model conventions, "towards camera" could be dz < 0 or dz > 0.
  // We use absolute speed + confirm with 2D area jump as safety.
  zVelAbs: 1.0,     // meters/sec-ish (tune)
  zVelSigned: 0.55, // meters/sec (tune)
  areaJump: 1.14,   // 2D size jump confirm
  // Beam cooldown is above
};

// -------------------- Pseudo-3D Camera --------------------
const cam = {
  fov: 520,         // bigger -> less perspective
  zNear: 0.25,
  zFar: 6.0,
  horizon: 0.55,    // screen vertical anchor
};

// ---- Castle background (procedural) ----
// ---- Castle background (multi-layer parallax) ----
const bg = {
  ready: false,
  stars: [],
  embers: [],
  flags: [],
  parallaxX: 0,
};

function initCastleBg(){
  // stars (upper sky)
  bg.stars = Array.from({ length: 220 }, () => ({
    x: Math.random(),
    y: Math.random() * 0.62,
    r: 0.4 + Math.random() * 1.8,
    a: 0.18 + Math.random() * 0.55,
    tw: Math.random() * Math.PI * 2,
    tws: 0.6 + Math.random() * 1.9
  }));

  // embers (floating sparks) in screen-space normalized
  bg.embers = Array.from({ length: 90 }, () => ({
    x: Math.random(),
    y: 0.55 + Math.random() * 0.55,
    vy: 0.03 + Math.random() * 0.08,
    vx: (Math.random() * 2 - 1) * 0.015,
    r: 0.6 + Math.random() * 1.6,
    a: 0.04 + Math.random() * 0.12,
    ph: Math.random() * Math.PI * 2
  }));

  // flags (hang from towers): store phases so each waves differently
  bg.flags = Array.from({ length: 5 }, () => ({
    ph: Math.random() * Math.PI * 2,
    sp: 0.9 + Math.random() * 0.9
  }));

  bg.ready = true;
}

function drawCastleBackdrop(nowMs){
  const W = canvas.width;
  const H = canvas.height;

  // --- Parallax driver from hands (0..1) ---
  let sumX = 0, n = 0;
  for(const k of ["Left","Right"]){
    const p = handState[k]?.lastPalm2D;
    if(p){ sumX += p.x; n++; }
  }
  const avgX = n ? (sumX/n) : 0.5;
  const target = (avgX - 0.5) * 70;            // px (左右視差幅度)
  bg.parallaxX = bg.parallaxX + (target - bg.parallaxX) * 0.06;

  const px = bg.parallaxX;

  // 1) 先略暗化 webcam，讓背景看得出來
  ctx.save();
  ctx.fillStyle = "rgba(0,0,0,0.22)";
  ctx.fillRect(0,0,W,H);

  // 2) 畫圖檔背景：cover 鋪滿 + 視差
  if(castleReady){
    const iw = castleImg.naturalWidth || 1920;
    const ih = castleImg.naturalHeight || 1080;

    // cover: 等比例鋪滿整個畫面
    const scale = Math.max(W/iw, H/ih);
    const dw = iw * scale;
    const dh = ih * scale;

    // 置中 + 視差（背景遠景：視差小）
    const x = (W - dw) * 0.5 + px * 0.25;
    const y = (H - dh) * 0.5;

    ctx.globalAlpha = 0.70; // 背景強度：0.55~0.85 可調
    ctx.drawImage(castleImg, x, y, dw, dh);
    ctx.globalAlpha = 1;
  } else {
    // 背景圖沒載到時的保底（避免白一片）
    const sky = ctx.createLinearGradient(0, 0, 0, H);
    sky.addColorStop(0, "rgba(18, 28, 50, 0.70)");
    sky.addColorStop(1, "rgba(0, 0, 0, 0.35)");
    ctx.fillStyle = sky;
    ctx.fillRect(0,0,W,H);
  }

  // 3) 加一層月光/薄霧（提升魔法氛圍）
  //const mx = W * 0.78 + px*0.15;
  //const my = H * 0.22;
  //const mg = ctx.createRadialGradient(mx, my, 10, mx, my, H*0.42);
  //mg.addColorStop(0, "rgba(255,245,220,0.16)");
  //mg.addColorStop(0.40, "rgba(215,181,109,0.10)");
  //mg.addColorStop(1, "rgba(0,0,0,0)");
  //ctx.fillStyle = mg;
  //ctx.fillRect(0,0,W,H);

  // 4) 前景拱門（近景視差大，強化 3D）
  //    這裡不使用 destination-out（更穩）
  ctx.save();
  ctx.translate(px * 0.70, 0);

  ctx.fillStyle = "rgba(0,0,0,0.36)";
  ctx.fillRect(0, 0, W, H);

  const cx = W*0.50, cy = H*0.68;
  const rx = W*0.45, ry = H*0.55;

  // 讓拱門內側相對亮一點，看起來像洞口
  //ctx.globalCompositeOperation = "lighter";
  //const hole = ctx.createRadialGradient(cx, cy, 10, cx, cy, Math.max(rx,ry));
  //hole.addColorStop(0, "rgba(0,0,0,0)");
  //hole.addColorStop(0.45, "rgba(0,0,0,0)");
  //hole.addColorStop(1, "rgba(0,0,0,0.18)");
  //ctx.fillStyle = hole;
  //ctx.beginPath();
  //ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI*2);
  //ctx.fill();

  //ctx.globalCompositeOperation = "source-over";
  //ctx.strokeStyle = "rgba(215,181,109,0.14)";
  //ctx.lineWidth = 3;
  //ctx.beginPath();
  //ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI*2);
  //ctx.stroke();

  // 簡單符文點綴
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  ctx.fillStyle = "rgba(215,181,109,0.06)";
  for(let i=0;i<18;i++){
    const t = i/18 * Math.PI*2;
    const x = cx + Math.cos(t)*rx;
    const y = cy + Math.sin(t)*ry;
    ctx.fillRect(x-2, y-8, 4, 16);
  }
  ctx.restore();

  ctx.restore(); // end arch

  // 5) 統一 vignette（防止看起來太平）
  const vg = ctx.createRadialGradient(W*0.5, H*0.55, 40, W*0.5, H*0.6, Math.max(W,H)*0.85);
  vg.addColorStop(0, "rgba(0,0,0,0)");
  vg.addColorStop(0.65, "rgba(0,0,0,0.08)");
  vg.addColorStop(1, "rgba(0,0,0,0.35)");
  ctx.fillStyle = vg;
  ctx.fillRect(0,0,W,H);

  ctx.restore();

  // 保險：避免 composite/alpha 殘留影響後續渲染
  ctx.globalCompositeOperation = "source-over";
  ctx.globalAlpha = 1;
}


function resizeToVideo(){
  const w = video.videoWidth || 1280;
  const h = video.videoHeight || 720;
  canvas.width = w;
  canvas.height = h;
}

function clamp(x,a,b){ return Math.max(a, Math.min(b, x)); }
function lerp(a,b,t){ return a + (b-a)*t; }

function project3D(p){
  // p: {x,y,z} in "scene" space. z>0 away from camera.
  const z = Math.max(cam.zNear, p.z);
  const s = cam.fov / (cam.fov + z * 260); // perspective scale
  const cx = canvas.width * 0.5;
  const cy = canvas.height * cam.horizon;

  return {
    x: cx + p.x * canvas.width * 0.55 * s,
    y: cy + p.y * canvas.height * 0.70 * s,
    s,
    z
  };
}

// -------------------- Hand helpers --------------------
function palmArea2D(landmarks){
  // width between index_mcp(5) and pinky_mcp(17)
  // height between wrist(0) and middle_mcp(9)
  const a = landmarks[5], b = landmarks[17], c = landmarks[0], d = landmarks[9];
  const w = Math.hypot(a.x-b.x, a.y-b.y);
  const h = Math.hypot(c.x-d.x, c.y-d.y);
  return w*h;
}

function palmZWorld(worldLandmarks){
  // average z of wrist + MCPs
  const idx = [0,5,9,13,17];
  let z = 0;
  for(const i of idx){ z += worldLandmarks[i].z; }
  return z/idx.length;
}

function palmXYWorld(worldLandmarks){
  // average x,y (world)
  const idx = [0,5,9,13,17];
  let x=0,y=0,z=0;
  for(const i of idx){ x += worldLandmarks[i].x; y += worldLandmarks[i].y; z += worldLandmarks[i].z; }
  return { x:x/idx.length, y:y/idx.length, z:z/idx.length };
}

// map MediaPipe world to our scene
function mapHandToScene(worldPalm){
  // worldPalm: meters-ish. We'll scale to a comfy range.
  // Also selfie mirror: we mirror X so it matches the mirrored video feel.
  const sx = -worldPalm.x * 2.2;       // mirror X
  const sy = -worldPalm.y * 2.2;       // invert Y so up is negative
  const sz = clamp(1.2 + (-worldPalm.z)*2.0, 0.35, 3.2); // convert depth to positive z
  return { x: sx, y: sy, z: sz };
}

// -------------------- Audio (no external files) --------------------
let audioCtx = null;

function ensureAudio(){
  if(!audioCtx){
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
}

function playTone({type="sine", f0=440, f1=880, dur=0.09, gain=0.08, noise=false}){
  ensureAudio();
  const t0 = audioCtx.currentTime;
  const t1 = t0 + dur;

  const out = audioCtx.createGain();
  out.gain.setValueAtTime(0.0001, t0);
  out.gain.exponentialRampToValueAtTime(gain, t0 + 0.01);
  out.gain.exponentialRampToValueAtTime(0.0001, t1);
  out.connect(audioCtx.destination);

  if(noise){
    const buf = audioCtx.createBuffer(1, Math.floor(audioCtx.sampleRate*dur), audioCtx.sampleRate);
    const data = buf.getChannelData(0);
    for(let i=0;i<data.length;i++) data[i] = (Math.random()*2-1) * 0.7;
    const src = audioCtx.createBufferSource();
    src.buffer = buf;

    const filt = audioCtx.createBiquadFilter();
    filt.type = "bandpass";
    filt.frequency.setValueAtTime(1200, t0);
    filt.Q.setValueAtTime(2.5, t0);

    src.connect(filt);
    filt.connect(out);
    src.start(t0);
    src.stop(t1);
    return;
  }

  const osc = audioCtx.createOscillator();
  osc.type = type;
  osc.frequency.setValueAtTime(f0, t0);
  osc.frequency.exponentialRampToValueAtTime(f1, t1);
  osc.connect(out);
  osc.start(t0);
  osc.stop(t1);
}

const sfx = {
  cast(){ playTone({type:"triangle", f0:520, f1:1100, dur:0.07, gain:0.07}); },
  hit(){ playTone({type:"sine", f0:720, f1:520, dur:0.08, gain:0.08}); playTone({noise:true, dur:0.06, gain:0.05}); },
  bossHit(){ playTone({type:"square", f0:180, f1:130, dur:0.12, gain:0.09}); },
  bossSpawn(){ playTone({type:"sawtooth", f0:90, f1:240, dur:0.22, gain:0.10}); },
  gameOver(){ playTone({type:"sawtooth", f0:220, f1:70, dur:0.35, gain:0.12}); playTone({noise:true, dur:0.18, gain:0.08}); }
};

// -------------------- Particles --------------------
// -------------------- Particles (colored) --------------------
function pick(palette){
  // palette: [{c:"rgba(...)", w: number}, ...]
  const total = palette.reduce((s,p)=>s+(p.w||1),0);
  let r = Math.random()*total;
  for(const p of palette){
    r -= (p.w||1);
    if(r <= 0) return p.c;
  }
  return palette[0].c;
}

const PALETTE_PURPLE_GOLD = [
  { c: "rgba(180, 120, 255, 1)", w: 3 }, // purple
  { c: "rgba(215, 181, 109, 1)", w: 3 }, // gold
  { c: "rgba(255, 245, 220, 1)", w: 1 }, // warm white
];

const PALETTE_ASH = [
  { c: "rgba(255, 80, 80, 1)",   w: 2 }, // red ember
  { c: "rgba(40, 40, 40, 1)",    w: 3 }, // dark ash
  { c: "rgba(90, 90, 90, 1)",    w: 2 }, // gray ash
  { c: "rgba(0, 0, 0, 1)",       w: 1 }, // black
];

function spawnParticles2D(x, y, count=22, power=1.0, palette=PALETTE_PURPLE_GOLD, opts={}){
  const {
    grav = 240,          // gravity strength baseline
    drag = 0.0015,       // damping
    ttlMin = 0.32,
    ttlMax = 0.60,
    speedMin = 60,
    speedMax = 260,
    sizeMin = 1.2,
    sizeMax = 3.2,
    alphaMin = 0.35,
    alphaMax = 0.90,
    streak = false,      // draw streak-like particles? (we keep circle but can extend later)
  } = opts;

  for(let i=0;i<count;i++){
    const a = Math.random()*Math.PI*2;
    const sp = (speedMin + Math.random()*(speedMax-speedMin)) * power;

    particles.push({
      x, y,
      vx: Math.cos(a)*sp,
      vy: Math.sin(a)*sp,
      life: 0,
      ttl: ttlMin + Math.random()*(ttlMax-ttlMin),
      r: sizeMin + Math.random()*(sizeMax-sizeMin),
      c: pick(palette),
      a0: alphaMin + Math.random()*(alphaMax-alphaMin),
      grav,
      drag,
      streak,
    });
  }
}

function spawnSparksPurpleGold(x,y,scale=1.0){
  spawnParticles2D(x,y, 46, scale, PALETTE_PURPLE_GOLD, {
    grav: 220,
    drag: 0.0012,
    ttlMin: 0.25,
    ttlMax: 0.55,
    speedMin: 110,
    speedMax: 420,
    sizeMin: 1.2,
    sizeMax: 3.8,
    alphaMin: 0.35,
    alphaMax: 0.95,
  });
}

function spawnAshBoss(x,y,scale=1.0){
  // more, heavier, slower -> ash 느낌
  spawnParticles2D(x,y, 140, scale, PALETTE_ASH, {
    grav: 520,
    drag: 0.0022,
    ttlMin: 0.55,
    ttlMax: 1.25,
    speedMin: 40,
    speedMax: 220,
    sizeMin: 1.6,
    sizeMax: 4.6,
    alphaMin: 0.18,
    alphaMax: 0.55,
  });
}

function updateParticles(dt){
  const alive = [];
  for(const p of particles){
    p.life += dt;

    // gravity + drag
    p.vy += (p.grav || 240) * dt * 0.35;
    p.x += p.vx * dt;
    p.y += p.vy * dt;

    const drag = p.drag ?? 0.0015;
    p.vx *= Math.pow(drag, dt);
    p.vy *= Math.pow(drag, dt);

    if(p.life < p.ttl) alive.push(p);
  }
  particles = alive;
}

function drawParticles(){
  ctx.save();
  ctx.globalCompositeOperation = "lighter";

  for(const p of particles){
    const t = p.life / p.ttl;
    const a = (1 - t) * (p.a0 ?? 0.6);

    // 把 rgba(...,1) 轉成 rgba(...,a)
    // 這裡簡單做：若是 rgba(..., 1) 結尾，就替換 alpha
    const color = p.c.replace(/rgba\(([^)]+),\s*1\)/, `rgba($1, ${a.toFixed(3)})`);

    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.r, 0, Math.PI*2);
    ctx.fill();
  }

  ctx.restore();
  ctx.globalCompositeOperation = "source-over";
}

// -------------------- Enemies (3D) --------------------
function spawnMonster(nowMs){
  // spawn far away
  const x = (Math.random()*2-1) * 0.85;
  const y = (Math.random()*2-1) * 0.20 - 0.12;
  const z = 4.8 + Math.random()*0.9;

  const speedZ = lerp(0.65, 1.15, Math.random()) * (1 + difficulty*0.08);
  const wob = Math.random()*Math.PI*2;

  monsters.push({
    type: "minion",
    x, y, z,
    r: lerp(0.12, 0.18, Math.random()),   // in scene units
    hp: 1,
    speedZ,
    wobble: wob,
  });
  lastSpawnMs = nowMs;
}

function updateMonsters(dt){
  const alive = [];
  for(const m of monsters){
    m.wobble += dt*(2.2 + difficulty*0.2);
    m.z -= m.speedZ * dt; // approach camera
    m.x += Math.sin(m.wobble)*dt*0.10;
    m.y += Math.cos(m.wobble*0.9)*dt*0.05;

    if(m.z < 0.55){
      hp -= 1;
      streak = 0;
      combo = 1.0;
    } else {
      alive.push(m);
    }
  }
  monsters = alive;
}

function spawnBoss(nowMs){
  boss = {
    type: "boss",
    name: "Wyrm of Ash",
    x: 0,
    y: -0.16,
    z: 5.2,
    r: 0.42,
    maxHp: 28 + Math.floor(difficulty*2),
    hp: 28 + Math.floor(difficulty*2),
    phase: 1,
    t: 0,
    speedZ: 0.22,
  };
  ui.bossbar.hidden = false;
  ui.bossname.textContent = `BOSS — ${boss.name}`;
  sfx.bossSpawn();
  lastSpawnMs = nowMs; // pause minion spawn rhythm a bit
}

function updateBoss(dt){
  if(!boss) return;

  boss.t += dt;
  // approach slowly then hover
  if(boss.z > 2.4) boss.z -= boss.speedZ * dt;
  boss.x = Math.sin(boss.t*0.9) * 0.35;
  boss.y = -0.12 + Math.cos(boss.t*0.7) * 0.10;

  // phase changes
  const hpRatio = boss.hp / boss.maxHp;
  boss.phase = hpRatio < 0.34 ? 3 : (hpRatio < 0.67 ? 2 : 1);

  // boss hits player if too close
  if(boss.z < 1.05){
    hp -= 2;
    boss.z = 2.2;
    streak = 0;
    combo = 1.0;
  }

  // update HUD bar
  const w = clamp(hpRatio, 0, 1) * 100;
  ui.bossfill.style.width = `${w}%`;

  if(boss.hp <= 0){
    // boss defeated -> big reward + next cycle
    score += Math.floor(120 * combo);
    streak += 2;
    combo = clamp(combo + 0.35, 1, COMBO_MAX);

    // particles burst at boss screen position
    const p = project3D(boss);
    spawnAshBoss(p.x, p.y, 1.25);       // 紅黑灰燼

    boss = null;
    ui.bossbar.hidden = true;

    difficulty += 1;
    nextBossAt += BOSS_SCORE_STEP;
  }
}

// -------------------- Beams (3D) --------------------
function castBeam3D(from3, nowMs){
  // choose target among monsters + boss
  let best = null;
  let bestD = 1e9;

  const candidates = [...monsters];
  if(boss) candidates.push(boss);

  for(const m of candidates){
    const dx = m.x - from3.x;
    const dy = m.y - from3.y;
    const dz = m.z - from3.z;
    const d = Math.hypot(dx,dy,dz);
    if(d < bestD){
      bestD = d;
      best = m;
    }
  }

  let to3 = { x: from3.x, y: from3.y - 0.25, z: from3.z + 1.8 };
  if(best){
    // aim slightly behind the target to look "piercing"
    to3 = { x: best.x, y: best.y, z: best.z + 0.08 };
  }

  beams.push({
    ax: from3.x, ay: from3.y, az: from3.z,
    bx: to3.x,   by: to3.y,   bz: to3.z,
    born: nowMs,
    ttl: 138,
  });

  // HIT logic: immediate hit for nearest target (arcade style)
  if(best){
    if(best.type === "boss"){
	best.hp -= 1;
	score += Math.floor(10 * combo);
	sfx.hit();

	const died = best.hp <= 0;
	const hp2 = project3D(best);

	if(died){
 	 // 怪物死亡：紫金火花爆裂
 	 spawnSparksPurpleGold(hp2.x, hp2.y, 1.0);
	} else {
  	// 沒死：小量火花（你要也可以留白）
 	 spawnParticles2D(hp2.x, hp2.y, 18, 0.9, PALETTE_PURPLE_GOLD, { ttlMin:0.18, ttlMax:0.35, speedMin:80, speedMax:220 });
	}
    }else{
      best.hp -= 1;
      score += Math.floor(10 * combo);
      sfx.hit();
    }

    // combo increase (hit window)
    streak += 1;
    combo = clamp(combo + COMBO_STEP, 1, COMBO_MAX);
    lastHitMs = nowMs;

    // particles at hit point in screen space
    const hp2 = project3D(best);
    spawnParticles2D(hp2.x, hp2.y, best.type==="boss" ? 34 : 24, best.type==="boss" ? 1.2 : 1.0);
  }else{
  best.hp -= 1;
  score += Math.floor(10 * combo);
  sfx.hit();

  const hp2 = project3D(best);
  const died = best.hp <= 0;

  if(died){
    // 小怪死亡：紫金火花爆裂
    spawnSparksPurpleGold(hp2.x, hp2.y, 1.0);
  }else{
    // 小怪未死：少量紫金火花
    spawnParticles2D(hp2.x, hp2.y, 18, 0.9, PALETTE_PURPLE_GOLD, {
      ttlMin: 0.18, ttlMax: 0.35, speedMin: 80, speedMax: 220
    });
  }
}


function updateBeams(nowMs){
  beams = beams.filter(b => (nowMs - b.born) < b.ttl);
}

function drawBeams(nowMs){
  ctx.save();

  // 讓光束用加亮混色（很關鍵：更像魔法光、會“發光”）
  ctx.globalCompositeOperation = "lighter";
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  for(const b of beams){
    const life = (nowMs - b.born)/b.ttl; // 0..1
    const alpha = Math.max(0, 1 - life);

    const a2 = project3D({x:b.ax,y:b.ay,z:b.az});
    const b2 = project3D({x:b.bx,y:b.by,z:b.bz});

    // 避免太遠的時候縮得過細：給一個下限
    const s = Math.max(a2.s, 0.75);

    // 讓光束有一點“呼吸”的脈動
    const pulse = 0.92 + 0.18 * Math.sin(nowMs/55 + b.ax*10);

    // === 你可以在這裡調整「粗細」 ===
    const OUTER_W1 = 76 * s * pulse;   // 外圈大光暈（最粗）
    const OUTER_W2 = 50 * s * pulse;   // 外圈小光暈
    const CORE_W   =  16 * s * pulse;   // 內核（最亮）
    const HOT_W    =  8 * s * pulse;   // 中間熱核（最白）

    // 讓光束本身沿著方向有些微漸層（更像能量）
    const grad = ctx.createLinearGradient(a2.x,a2.y,b2.x,b2.y);
    grad.addColorStop(0.00, `rgba(215,181,109,${0.10*alpha})`);
    grad.addColorStop(0.45, `rgba(255,245,220,${0.22*alpha})`);
    grad.addColorStop(1.00, `rgba(255,245,220,${0.14*alpha})`);

    // 1) 大光暈
    ctx.strokeStyle = `rgba(215,181,109,${0.22*alpha})`;
    ctx.lineWidth = OUTER_W1;
    ctx.beginPath(); ctx.moveTo(a2.x,a2.y); ctx.lineTo(b2.x,b2.y); ctx.stroke();

    // 2) 小光暈（帶點漸層）
    ctx.strokeStyle = grad;
    ctx.lineWidth = OUTER_W2;
    ctx.beginPath(); ctx.moveTo(a2.x,a2.y); ctx.lineTo(b2.x,b2.y); ctx.stroke();

    // 3) 亮核
    ctx.strokeStyle = `rgba(255,245,220,${0.92*alpha})`;
    ctx.lineWidth = CORE_W;
    ctx.beginPath(); ctx.moveTo(a2.x,a2.y); ctx.lineTo(b2.x,b2.y); ctx.stroke();

    // 4) 最亮熱核（很細但很亮，讓“光束”更有穿透感）
    ctx.strokeStyle = `rgba(255,255,255,${0.55*alpha})`;
    ctx.lineWidth = HOT_W;
    ctx.beginPath(); ctx.moveTo(a2.x,a2.y); ctx.lineTo(b2.x,b2.y); ctx.stroke();

    // 5) 能量火花：數量變多、範圍變大（更明顯）
    const sparkN = Math.floor(18 + 18*s);
    for(let i=0;i<sparkN;i++){
      const t = Math.random();
      const x = lerp(a2.x,b2.x,t) + (Math.random()-0.5)*18*s;
      const y = lerp(a2.y,b2.y,t) + (Math.random()-0.5)*18*s;
      const rr = (1.2 + Math.random()*3.6) * s;

      ctx.fillStyle = `rgba(255,245,220,${(0.35+Math.random()*0.55)*alpha})`;
      ctx.beginPath(); ctx.arc(x,y,rr,0,Math.PI*2); ctx.fill();
    }

    // 6) 起點/終點能量球（非常有感）
    const orbR = 10*s*pulse;
    ctx.fillStyle = `rgba(255,245,220,${0.35*alpha})`;
    ctx.beginPath(); ctx.arc(a2.x,a2.y,orbR,0,Math.PI*2); ctx.fill();
    ctx.beginPath(); ctx.arc(b2.x,b2.y,orbR*0.9,0,Math.PI*2); ctx.fill();
  }

  ctx.restore();

  // 保險：避免影響後續渲染
  ctx.globalCompositeOperation = "source-over";
  ctx.globalAlpha = 1;
}

// -------------------- Rendering (3D-ish) --------------------
function drawBackdrop(nowMs){
  // 先畫城堡背景（會疊在 webcam 上，保留手部可見）
  drawCastleBackdrop(nowMs);

  // 原本的 vignette / runes 繼續保留
  const g = ctx.createRadialGradient(
    canvas.width*0.5, canvas.height*0.35, 40,
    canvas.width*0.5, canvas.height*0.6, Math.max(canvas.width, canvas.height)*0.78
  );
  g.addColorStop(0, "rgba(215,181,109,0.10)");
  g.addColorStop(0.55, "rgba(0,0,0,0)");
  g.addColorStop(1, "rgba(0,0,0,0.45)");
  ctx.fillStyle = g;
  ctx.fillRect(0,0,canvas.width,canvas.height);

  // 你原本那段「地面符文圈」也可以留著（可選）
  ctx.save();
  ctx.globalAlpha = 0.16;
  ctx.strokeStyle = "rgba(215,181,109,0.45)";
  for(let i=0;i<6;i++){
    const y = canvas.height*(0.62 + i*0.07);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.ellipse(canvas.width*0.5, y, canvas.width*(0.12+i*0.06), canvas.height*(0.025+i*0.012), 0, 0, Math.PI*2);
    ctx.stroke();
  }
  ctx.restore();
}


function drawMonsterBody(p2, radiusPx, isBoss=false){
  ctx.save();
  ctx.translate(p2.x, p2.y);

  // shadow core
  ctx.beginPath();
  ctx.fillStyle = "rgba(0,0,0,0.55)";
  ctx.arc(0,0,radiusPx,0,Math.PI*2);
  ctx.fill();

  // horns / crown
  ctx.beginPath();
  ctx.fillStyle = "rgba(0,0,0,0.62)";
  const r = radiusPx;
  ctx.moveTo(-r*0.55, -r*0.05);
  ctx.lineTo(-r*1.10, -r*0.70);
  ctx.lineTo(-r*0.18, -r*0.60);
  ctx.closePath(); ctx.fill();

  ctx.beginPath();
  ctx.moveTo(r*0.55, -r*0.05);
  ctx.lineTo(r*1.10, -r*0.70);
  ctx.lineTo(r*0.18, -r*0.60);
  ctx.closePath(); ctx.fill();

  // glow core
  ctx.beginPath();
  ctx.fillStyle = isBoss ? "rgba(255,92,92,0.22)" : "rgba(215,181,109,0.22)";
  ctx.arc(0,0,r*0.52,0,Math.PI*2);
  ctx.fill();

  // rune ring
  ctx.strokeStyle = isBoss ? "rgba(255,92,92,0.55)" : "rgba(215,181,109,0.55)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(0,0,r*0.74,0,Math.PI*2);
  ctx.stroke();

  ctx.restore();
}

function drawEnemySprite(m, imgEl, isBoss=false){
  const p2 = project3D(m);
  const base = Math.min(canvas.width, canvas.height);

  // 原本你用 m.r * base * p2.s 當半徑；這裡把它變成 sprite 尺寸
  const radiusPx = m.r * base * p2.s * (isBoss ? 1.35 : 1.0);

  // 依照 GIF 原始比例縮放
  const iw = imgEl.naturalWidth || 256;
  const ih = imgEl.naturalHeight || 256;
  const aspect = iw / ih;

  // sprite 高度/寬度（可微調：想更大就把 2.6 改大）
  const h = radiusPx * (isBoss ? 3.2 : 2.6);
  const w = h * aspect;

  const x = p2.x - w/2;
  const y = p2.y - h/2;

  // 1) 先畫一圈淡淡的魔法光暈（讓 GIF 更融入）
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  ctx.fillStyle = isBoss ? "rgba(255,92,92,0.12)" : "rgba(215,181,109,0.10)";
  ctx.beginPath();
  ctx.arc(p2.x, p2.y, radiusPx * (isBoss ? 1.25 : 1.10), 0, Math.PI*2);
  ctx.fill();
  ctx.restore();

  // 2) 畫 GIF sprite 本體
  ctx.save();
  ctx.globalCompositeOperation = "source-over";
  ctx.globalAlpha = 0.95;
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(imgEl, x, y, w, h);
  ctx.restore();
}

function drawEnemies(){
  // draw farther first
  const list = [...monsters];
  if(boss) list.push(boss);
  list.sort((a,b)=> b.z - a.z);

  for(const m of list){
    if(m.type === "boss"){
      if(bossGifReady){
        drawEnemySprite(m, bossGifEl, true);
      }else{
        // fallback: 你原本的幾何怪物（保底）
        const p2 = project3D(m);
        const base = Math.min(canvas.width, canvas.height);
        const radiusPx = m.r * base * p2.s * 1.2;
        drawMonsterBody(p2, radiusPx, true);
      }
    }else{
      if(monsterGifReady){
        drawEnemySprite(m, monsterGifEl, false);
      }else{
        const p2 = project3D(m);
        const base = Math.min(canvas.width, canvas.height);
        const radiusPx = m.r * base * p2.s;
        drawMonsterBody(p2, radiusPx, false);
      }
    }
  }
}

// -------------------- Gesture Detection (world z push) --------------------
function tryDetectCast(handednessLabel, landmarks2D, worldLandmarks, nowMs){
  const st = handState[handednessLabel] || handState.Right;

  const area = palmArea2D(landmarks2D);

  if(!worldLandmarks){
    // fallback: if no worldLandmarks, do nothing (or you could keep the old 2D heuristic)
    return;
  }

  const z = palmZWorld(worldLandmarks);

  if(st.lastZ == null){
    st.lastZ = z;
    st.lastTs = nowMs;
    st.lastCastMs = 0;
    st.lastArea = area;
    return;
  }

  const dt = Math.max(0.001, (nowMs - st.lastTs)/1000);
  const dz = (z - st.lastZ);     // world z delta
  const zVel = dz / dt;          // world z velocity

  const areaRatio = area / (st.lastArea || area);
  const cooldownOK = (nowMs - st.lastCastMs) > HAND_COOLDOWN_MS;

  // Main rule:
  // 1) strong z velocity (signed OR absolute) AND 2) confirm by 2D area jump
  // Signed direction can vary across implementations; absolute makes it robust.
  const zStrong = (Math.abs(zVel) > TH.zVelAbs) || (zVel < -TH.zVelSigned) || (zVel > TH.zVelSigned);
  const forwardConfirm = areaRatio > TH.areaJump;

  if(cooldownOK && zStrong && forwardConfirm){
    st.lastCastMs = nowMs;

    const wp = palmXYWorld(worldLandmarks);
    const from3 = mapHandToScene(wp);
    castBeam3D(from3, nowMs);
  }

  st.lastZ = z;
  st.lastTs = nowMs;
  st.lastArea = area;
}

// -------------------- HUD / game flow --------------------
function syncHUD(nowMs){
  ui.score.textContent = String(score);
  ui.streak.textContent = String(streak);
  ui.hp.textContent = String(hp);

  // combo decay
  if(nowMs && (nowMs - lastHitMs) > COMBO_DECAY_MS){
    combo = lerp(combo, 1.0, 0.06);
    if(combo < 1.02) combo = 1.0;
  }
  ui.combo.textContent = `x${combo.toFixed(2)}`;
}

function setHint(msg){ ui.hint.textContent = msg; }

function resetGame(){
  score = 0;
  streak = 0;
  hp = 10;

  monsters = [];
  beams = [];
  particles = [];

  boss = null;
  ui.bossbar.hidden = true;

  lastSpawnMs = 0;
  spawnIntervalMs = 850;
  difficulty = 1;

  nextBossAt = BOSS_SCORE_STEP;

  for(const k of ["Left","Right"]){
    handState[k].lastCastMs = 0;
    handState[k].lastZ = null;
    handState[k].lastTs = 0;
    handState[k].lastArea = null;
  }

  combo = 1.0;
  lastHitMs = 0;

  syncHUD();
  setHint("重置完成。把手靠近鏡頭，『向前推進』施法！");
}

// -------------------- Main Loop --------------------
let lastFrameMs = 0;

async function loop(nowMs){
  if(!running) return;
  requestAnimationFrame(loop);
  if(paused) return;

  const dt = lastFrameMs ? (nowMs - lastFrameMs)/1000 : 1/60;
  lastFrameMs = nowMs;

  resizeToVideo();
  ctx.clearRect(0,0,canvas.width,canvas.height);

  // detections
  let detections = null;
  if(landmarker){
    detections = landmarker.detectForVideo(video, nowMs);
  }

  // spawn boss or monsters
  if(!boss && score >= nextBossAt){
    spawnBoss(nowMs);
  }

  // while boss alive, reduce minion spawns
  const spawnMul = boss ? 1.8 : 1.0;

  if(nowMs - lastSpawnMs > spawnIntervalMs * spawnMul){
    spawnMonster(nowMs);
    // ramp
    spawnIntervalMs = Math.max(420, spawnIntervalMs * 0.997);
  }

  updateMonsters(dt);
  updateBoss(dt);
  updateBeams(nowMs);
  updateParticles(dt);

  // gesture -> cast (use worldLandmarks z-velocity)
  if(detections?.landmarks?.length){
    const handed = detections.handednesses || [];
    const wlm = detections.worldLandmarks || []; // important
    for(let i=0;i<detections.landmarks.length;i++){
      const label = (handed[i]?.[0]?.categoryName) || "Right";
      const world = wlm[i]; // may be undefined
      tryDetectCast(label, detections.landmarks[i], world, nowMs);
    }
  }

  // render
  drawBackdrop(nowMs);
  drawEnemies();
  drawBeams(nowMs);
  drawParticles();

  // end condition
  if(hp <= 0){
    paused = true;
    ui.btnPause.disabled = true;
    setHint("☠️ 你倒下了…按 Reset 再來一次。");
    sfx.gameOver();
  } else {
    setHint("提示：『向鏡頭推進』(z 方向) + 手變大(靠近鏡頭) 會觸發施法。");
  }

  // combo decay + hud
  syncHUD(nowMs);
}

// -------------------- Setup: Camera + Landmarker --------------------
async function createLandmarker(){
  const vision = await FilesetResolver.forVisionTasks(
    "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.0/wasm"
  );

  landmarker = await HandLandmarker.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath: "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
      delegate: "GPU",
    },
    runningMode: "VIDEO",
    numHands: 2,
    minHandDetectionConfidence: 0.5,
    minTrackingConfidence: 0.5,
    minHandPresenceConfidence: 0.5,
  });
}

async function startCamera(){
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } },
    audio: false
  });
  video.srcObject = stream;

  await new Promise((res) => {
    video.onloadedmetadata = () => res();
  });
  await video.play();
  resizeToVideo();
}

// UI buttons
ui.btnStart.addEventListener("click", async () => {
  try{
    ui.btnStart.disabled = true;
    setHint("正在啟動相機與手部追蹤…（第一次會較慢）");

    await startCamera();
    await createLandmarker();

    running = true;
    paused = false;

    ui.btnPause.disabled = false;
    ui.btnReset.disabled = false;

    // unlock audio on user gesture
    ensureAudio();
    if(audioCtx.state === "suspended") await audioCtx.resume();

    document.querySelector(".overlay").style.pointerEvents = "none";
    document.querySelector(".overlay").style.opacity = "0";
    setTimeout(() => document.querySelector(".overlay").style.display = "none", 250);

    requestAnimationFrame(loop);
  }catch(e){
    console.error(e);
    ui.btnStart.disabled = false;
    setHint("啟動失敗：請確認允許相機，且使用 https 或 localhost。");
  }
});

ui.btnPause.addEventListener("click", async () => {
  paused = !paused;
  ui.btnPause.textContent = paused ? "Resume" : "Pause";
  if(!paused){
    ensureAudio();
    if(audioCtx.state === "suspended") await audioCtx.resume();
  }
});

ui.btnReset.addEventListener("click", async () => {
  paused = false;
  ui.btnPause.textContent = "Pause";
  ui.btnPause.disabled = false;
  ensureAudio();
  if(audioCtx.state === "suspended") await audioCtx.resume();
  resetGame();
});

// initial
syncHUD();
setHint("準備就緒。按 Start 後，把手伸到鏡頭前，『向前推進』施法。");
