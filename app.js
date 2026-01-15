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
  if(!bg.ready) initCastleBg();

  // --- Parallax driver from hands (0..1) ---
  let sumX = 0, n = 0;
  for(const k of ["Left","Right"]){
    const p = handState[k]?.lastPalm2D;
    if(p){ sumX += p.x; n++; }
  }
  const avgX = n ? (sumX/n) : 0.5;
  const target = (avgX - 0.5) * 60;            // px
  bg.parallaxX = bg.parallaxX + (target - bg.parallaxX) * 0.06;

  const px = bg.parallaxX;

  // Layer parallax multipliers (遠->近)
  const parSky = px * 0.10;
  const parMount = px * 0.18;
  const parCastle = px * 0.35;
  const parFore = px * 0.70;

  const W = canvas.width;
  const H = canvas.height;
  const horizonY = H * cam.horizon;

  // 0) dim webcam slightly so background reads
  ctx.save();
  ctx.fillStyle = "rgba(0,0,0,0.26)";
  ctx.fillRect(0,0,W,H);

  // 1) SKY gradient
  const sky = ctx.createLinearGradient(0, 0, 0, H);
  sky.addColorStop(0, "rgba(18, 28, 50, 0.70)");
  sky.addColorStop(0.45, "rgba(10, 14, 20, 0.45)");
  sky.addColorStop(1, "rgba(0, 0, 0, 0.25)");
  ctx.fillStyle = sky;
  ctx.fillRect(0,0,W,H);

  // 2) Moon + glow (far layer)
  const mx = W * 0.78 + parSky;
  const my = H * 0.22;
  const mg = ctx.createRadialGradient(mx, my, 12, mx, my, H*0.38);
  mg.addColorStop(0, "rgba(255,245,220,0.16)");
  mg.addColorStop(0.35, "rgba(215,181,109,0.10)");
  mg.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = mg;
  ctx.fillRect(0,0,W,H);

  ctx.beginPath();
  ctx.fillStyle = "rgba(255,245,220,0.12)";
  ctx.arc(mx, my, Math.min(W,H)*0.06, 0, Math.PI*2);
  ctx.fill();

  // 3) Stars (twinkle)
  for(const s of bg.stars){
    const tw = 0.55 + 0.45*Math.sin(nowMs/1000*s.tws + s.tw);
    const x = (s.x*W) + parSky;
    const y = (s.y*H);
    ctx.fillStyle = `rgba(255,245,220,${s.a*tw})`;
    ctx.beginPath();
    ctx.arc(x, y, s.r, 0, Math.PI*2);
    ctx.fill();
  }

  // Helper: draw a soft fog ellipse
  const fogEllipse = (x,y,rx,ry,a)=>{
    ctx.fillStyle = `rgba(255,245,220,${a})`;
    ctx.beginPath();
    ctx.ellipse(x,y,rx,ry,0,0,Math.PI*2);
    ctx.fill();
  };

  // 4) FAR MOUNTAINS (layer 1)
  ctx.save();
  ctx.fillStyle = "rgba(0,0,0,0.30)";
  ctx.beginPath();
  ctx.moveTo(-80 + parMount, horizonY + H*0.08);
  for(let i=0;i<=18;i++){
    const t = i/18;
    const x = t*W + parMount;
    const y = horizonY + H*(0.08 + 0.05*Math.sin(t*9.5 + nowMs/5000) + 0.02*Math.sin(t*21 + 1.3));
    ctx.lineTo(x,y);
  }
  ctx.lineTo(W+120 + parMount, H);
  ctx.lineTo(-120 + parMount, H);
  ctx.closePath();
  ctx.fill();
  ctx.restore();

  // 5) MID FOG bands (behind castle)
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  for(let i=0;i<5;i++){
    const y = horizonY + H*(0.16 + i*0.05) + 10*Math.sin(nowMs/2600 + i*0.7);
    fogEllipse(W*0.45 + parMount*(0.8+i*0.15), y, W*(0.45+i*0.06), 34+i*10, 0.010 + i*0.004);
  }
  ctx.restore();

  // 6) CASTLE silhouette (layer 2)
  const baseY = horizonY + H*0.11;
  const baseH = H*0.34;
  const castleW = W*0.64;
  const castleX = W*0.18 + parCastle;

  // main body
  ctx.fillStyle = "rgba(0,0,0,0.64)";
  ctx.fillRect(castleX, baseY, castleW, baseH);

  // towers helper
  const tower = (x, w, h) => {
    ctx.fillRect(x, baseY - h, w, h);
    const step = w/6;
    for(let i=0;i<6;i++){
      if(i%2===0) ctx.fillRect(x+i*step, baseY - h - 10, step, 10);
    }
  };

  const t1x = castleX + castleW*0.02;
  const t2x = castleX + castleW*0.22;
  const t3x = castleX + castleW*0.48;
  const t4x = castleX + castleW*0.72;

  tower(t1x, castleW*0.12, baseH*0.88);
  tower(t2x, castleW*0.16, baseH*1.05);
  tower(t3x, castleW*0.14, baseH*0.92);
  tower(t4x, castleW*0.18, baseH*1.10);

  // central spire
  ctx.beginPath();
  ctx.moveTo(castleX + castleW*0.38, baseY - baseH*1.18);
  ctx.lineTo(castleX + castleW*0.44, baseY - baseH*1.55);
  ctx.lineTo(castleX + castleW*0.50, baseY - baseH*1.18);
  ctx.closePath();
  ctx.fill();

  // arches (dark)
  ctx.fillStyle = "rgba(0,0,0,0.72)";
  for(let i=0;i<7;i++){
    const ax = castleX + castleW*(0.08 + i*0.12);
    const ay = baseY + baseH*0.52;
    const ar = castleW*0.035;
    ctx.beginPath();
    ctx.arc(ax, ay, ar, Math.PI, 0);
    ctx.lineTo(ax+ar, ay+ar*1.7);
    ctx.lineTo(ax-ar, ay+ar*1.7);
    ctx.closePath();
    ctx.fill();
  }

  // window glows
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  for(let i=0;i<36;i++){
    const wx = castleX + Math.random()*castleW;
    const wy = baseY - Math.random()*baseH*0.65 + baseH*0.22;
    const ww = 3 + Math.random()*6;
    const wh = 6 + Math.random()*10;
    ctx.fillStyle = "rgba(215,181,109,0.09)";
    ctx.fillRect(wx, wy, ww, wh);

    const gg = ctx.createRadialGradient(wx, wy, 2, wx, wy, 20);
    gg.addColorStop(0, "rgba(215,181,109,0.07)");
    gg.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = gg;
    ctx.fillRect(wx-20, wy-20, 40, 40);
  }
  ctx.restore();

  // 7) FLAGS (attached to tower tops; waves)
  const flagPoints = [
    { x: t1x + castleW*0.06, y: baseY - baseH*0.88 },
    { x: t2x + castleW*0.08, y: baseY - baseH*1.05 },
    { x: t3x + castleW*0.07, y: baseY - baseH*0.92 },
    { x: t4x + castleW*0.10, y: baseY - baseH*1.10 },
    { x: castleX + castleW*0.44, y: baseY - baseH*1.55 },
  ];

  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  for(let i=0;i<flagPoints.length;i++){
    const fp = flagPoints[i];
    const f = bg.flags[i % bg.flags.length];
    const wind = Math.sin(nowMs/600 * f.sp + f.ph);
    const wind2 = Math.sin(nowMs/280 * (0.7+f.sp*0.3) + f.ph*1.7);

    // pole
    ctx.strokeStyle = "rgba(215,181,109,0.10)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(fp.x, fp.y);
    ctx.lineTo(fp.x, fp.y + 34);
    ctx.stroke();

    // flag cloth (bezier wave)
    const len = 34;
    const h = 14;
    const dx = 10 + wind*10 + wind2*6;
    const dy = 2 + wind2*3;

    ctx.fillStyle = "rgba(255,92,92,0.10)";
    ctx.beginPath();
    ctx.moveTo(fp.x, fp.y);
    ctx.bezierCurveTo(fp.x+dx*0.4, fp.y+dy*0.2, fp.x+dx*0.8, fp.y+h*0.6, fp.x+dx, fp.y+h);
    ctx.bezierCurveTo(fp.x+dx*0.75, fp.y+h*1.05, fp.x+dx*0.35, fp.y+h*0.95, fp.x, fp.y+h*0.85);
    ctx.closePath();
    ctx.fill();

    // edge highlight
    ctx.strokeStyle = "rgba(215,181,109,0.10)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(fp.x, fp.y);
    ctx.bezierCurveTo(fp.x+dx*0.4, fp.y+dy*0.2, fp.x+dx*0.8, fp.y+h*0.6, fp.x+dx, fp.y+h);
    ctx.stroke();
  }
  ctx.restore();

  // 8) FRONT FOG (in front of castle)
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  for(let i=0;i<7;i++){
    const y = horizonY + H*(0.26 + i*0.045) + 12*Math.sin(nowMs/2200 + i*0.8);
    fogEllipse(W*0.52 + parCastle*(1.0+i*0.10), y, W*(0.52+i*0.07), 46+i*12, 0.012 + i*0.004);
  }
  ctx.restore();

  // 9) FOREGROUND ARCH (layer 3) — big parallax, adds depth
  ctx.save();
  ctx.translate(parFore, 0);

  const archY = horizonY + H*0.03;
  const archW = W*1.18;
  const archH = H*0.95;

  // stone frame
  ctx.fillStyle = "rgba(0,0,0,0.50)";
  ctx.fillRect(-W*0.09, archY, archW, archH);

  // inner opening (cutout) by drawing with destination-out
  ctx.globalCompositeOperation = "destination-out";
  ctx.beginPath();
  ctx.ellipse(W*0.50, H*0.68, W*0.45, H*0.55, 0, 0, Math.PI*2);
  ctx.fill();

  // back to normal and add subtle rune glow on arch
  ctx.globalCompositeOperation = "source-over";
  ctx.globalAlpha = 0.9;

  // arch edge glow
  ctx.strokeStyle = "rgba(215,181,109,0.12)";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.ellipse(W*0.50, H*0.68, W*0.45, H*0.55, 0, 0, Math.PI*2);
  ctx.stroke();

  // runes
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  ctx.fillStyle = "rgba(215,181,109,0.08)";
  for(let i=0;i<22;i++){
    const t = i/22 * Math.PI*2;
    const rx = W*0.45;
    const ry = H*0.55;
    const x = W*0.50 + Math.cos(t)*rx;
    const y = H*0.68 + Math.sin(t)*ry;
    const w = 4 + Math.random()*6;
    const h2 = 10 + Math.random()*16;
    ctx.fillRect(x - w/2, y - h2/2, w, h2);
  }
  ctx.restore();

  ctx.restore(); // end foreground arch layer

  // 10) Floating embers (foreground-ish, light)
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  for(const e of bg.embers){
    // drift
    const sway = Math.sin(nowMs/900 + e.ph) * 0.006;
    e.y -= e.vy * (1/60);
    e.x += (e.vx + sway) * (1/60);

    // wrap
    if(e.y < -0.05){ e.y = 1.05; e.x = Math.random(); }
    if(e.x < -0.05) e.x = 1.05;
    if(e.x > 1.05) e.x = -0.05;

    const ex = e.x*W + parFore*0.25;
    const ey = e.y*H;
    const tw = 0.6 + 0.4*Math.sin(nowMs/500 + e.ph);
    const a = e.a * tw;

    ctx.fillStyle = `rgba(255,245,220,${a})`;
    ctx.beginPath();
    ctx.arc(ex, ey, e.r, 0, Math.PI*2);
    ctx.fill();

    // tiny streak
    ctx.strokeStyle = `rgba(215,181,109,${a*0.7})`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(ex, ey);
    ctx.lineTo(ex + (Math.random()*2-1)*8, ey - 10 - Math.random()*18);
    ctx.stroke();
  }
  ctx.restore();

  // 11) Final subtle vignette to unify
  const vg = ctx.createRadialGradient(W*0.5, H*0.55, 40, W*0.5, H*0.6, Math.max(W,H)*0.85);
  vg.addColorStop(0, "rgba(0,0,0,0)");
  vg.addColorStop(0.65, "rgba(0,0,0,0.08)");
  vg.addColorStop(1, "rgba(0,0,0,0.35)");
  ctx.fillStyle = vg;
  ctx.fillRect(0,0,W,H);

  ctx.restore(); // end full backdrop
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
function spawnParticles2D(x,y,count=22, power=1.0){
  for(let i=0;i<count;i++){
    const a = Math.random()*Math.PI*2;
    const sp = (40 + Math.random()*220) * power;
    particles.push({
      x, y,
      vx: Math.cos(a)*sp,
      vy: Math.sin(a)*sp,
      life: 0,
      ttl: 0.32 + Math.random()*0.28,
      r: 1.2 + Math.random()*2.2,
    });
  }
}

function updateParticles(dt){
  const g = 240; // gravity-ish
  const alive = [];
  for(const p of particles){
    p.life += dt;
    p.vy += g*dt*0.35;
    p.x += p.vx*dt;
    p.y += p.vy*dt;
    p.vx *= Math.pow(0.0015, dt); // damp
    p.vy *= Math.pow(0.0015, dt);
    if(p.life < p.ttl) alive.push(p);
  }
  particles = alive;
}

function drawParticles(){
  for(const p of particles){
    const t = p.life / p.ttl;
    const a = 1 - t;
    ctx.fillStyle = `rgba(255,245,220,${0.75*a})`;
    ctx.beginPath();
    ctx.arc(p.x,p.y,p.r,0,Math.PI*2);
    ctx.fill();
  }
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
    spawnParticles2D(p.x, p.y, 120, 1.7);

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
    ttl: 120,
  });

  // HIT logic: immediate hit for nearest target (arcade style)
  if(best){
    if(best.type === "boss"){
      best.hp -= 1;
      score += Math.floor(6 * combo);
      sfx.bossHit();
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
  } else {
    streak = 0;
    combo = 1.0;
  }

  // cleanup dead minions
  monsters = monsters.filter(m => m.hp > 0);

  // cast sound
  sfx.cast();
}

function updateBeams(nowMs){
  beams = beams.filter(b => (nowMs - b.born) < b.ttl);
}

function drawBeams(nowMs){
  for(const b of beams){
    const life = (nowMs - b.born)/b.ttl; // 0..1
    const alpha = 1 - life;

    const a2 = project3D({x:b.ax,y:b.ay,z:b.az});
    const b2 = project3D({x:b.bx,y:b.by,z:b.bz});

    // outer glow
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = `rgba(215,181,109,${0.22*alpha})`;
    ctx.lineWidth = 18 * a2.s;
    ctx.beginPath(); ctx.moveTo(a2.x,a2.y); ctx.lineTo(b2.x,b2.y); ctx.stroke();

    // inner beam
    ctx.strokeStyle = `rgba(255,245,220,${0.88*alpha})`;
    ctx.lineWidth = 5 * a2.s;
    ctx.beginPath(); ctx.moveTo(a2.x,a2.y); ctx.lineTo(b2.x,b2.y); ctx.stroke();

    // sparkle along beam
    for(let i=0;i<10;i++){
      const t = Math.random();
      const x = lerp(a2.x,b2.x,t) + (Math.random()-0.5)*10;
      const y = lerp(a2.y,b2.y,t) + (Math.random()-0.5)*10;
      const rr = (1 + Math.random()*2.4) * a2.s;
      ctx.fillStyle = `rgba(255,245,220,${(0.45+Math.random()*0.45)*alpha})`;
      ctx.beginPath(); ctx.arc(x,y,rr,0,Math.PI*2); ctx.fill();
    }
  }
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

function drawEnemies(){
  // draw farther first
  const list = [...monsters];
  if(boss) list.push(boss);
  list.sort((a,b)=> b.z - a.z);

  for(const m of list){
    const p2 = project3D(m);
    const base = Math.min(canvas.width, canvas.height);
    const radiusPx = m.r * base * p2.s * (m.type==="boss" ? 1.2 : 1.0);
    drawMonsterBody(p2, radiusPx, m.type==="boss");
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
