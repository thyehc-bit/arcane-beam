:root{
  --bg:#0b0f14;
  --gold:#d7b56d;
  --ink:#e9e2d0;
  --panel: rgba(12, 16, 22, .72);
  --danger:#ff5c5c;
  --ok:#7CFFB2;
}

*{ box-sizing:border-box; }
html,body{ height:100%; margin:0; background: radial-gradient(1200px 600px at 50% 20%, #1b2433 0%, var(--bg) 55%, #05070a 100%); color:var(--ink); font-family: ui-serif, Georgia, "Times New Roman", serif; }

.topbar{
  display:flex; justify-content:space-between; align-items:center;
  padding:12px 16px; border-bottom:1px solid rgba(215,181,109,.25);
  background: linear-gradient(to bottom, rgba(0,0,0,.55), rgba(0,0,0,0));
}
.brand{
  letter-spacing: .22em;
  color: var(--gold);
  font-weight: 700;
  text-shadow: 0 0 18px rgba(215,181,109,.25);
}
.hud{ display:flex; gap:14px; font-family: ui-monospace, Menlo, Consolas, monospace; font-size:14px; }
.hud-item{ padding:6px 10px; border:1px solid rgba(215,181,109,.22); border-radius:10px; background: rgba(0,0,0,.25); }

.stage{ display:flex; justify-content:center; padding:16px; }
.frame{
  position:relative;
  width:min(92vw, 980px);
  aspect-ratio: 16 / 9;
  border-radius:18px;
  overflow:hidden;
  border:1px solid rgba(215,181,109,.25);
  box-shadow: 0 20px 80px rgba(0,0,0,.55);
  background: rgba(0,0,0,.25);
}

#video{
  position:absolute; inset:0;
  width:100%; height:100%;
  object-fit:cover;
  transform: rotateY(180deg); /* selfie mirror */
  filter: contrast(1.05) saturate(1.05) brightness(.9);
}
#canvas{
  position:absolute; inset:0;
  width:100%; height:100%;
}

.overlay{
  position:absolute; inset:0;
  display:grid; place-items:center;
  pointer-events:none;
}
.panel{
  pointer-events:auto;
  width:min(560px, 92%);
  padding:18px 18px 14px;
  background: var(--panel);
  border:1px solid rgba(215,181,109,.28);
  border-radius:16px;
  backdrop-filter: blur(10px);
}
.title{ font-size:22px; color:var(--gold); letter-spacing:.08em; margin-bottom:8px; }
.desc{ opacity:.92; line-height:1.45; margin-bottom:12px; }
.row{ display:flex; gap:10px; flex-wrap:wrap; }
button{
  appearance:none; border:1px solid rgba(215,181,109,.35);
  background: rgba(0,0,0,.35);
  color: var(--ink);
  padding:10px 12px;
  border-radius:12px;
  cursor:pointer;
  font-weight:700;
}
button:disabled{ opacity:.45; cursor:not-allowed; }
button:hover:not(:disabled){ box-shadow: 0 0 22px rgba(215,181,109,.18); }
.hint{ margin-top:10px; font-size:13px; opacity:.9; font-family: ui-monospace, Menlo, Consolas, monospace; }

.footer{ padding:10px 16px; opacity:.78; font-size:12px; text-align:center; }

.bossbar{
  display:flex;
  flex-direction:column;
  gap:6px;
  min-width: 280px;
  padding: 8px 10px;
  border:1px solid rgba(215,181,109,.25);
  border-radius:12px;
  background: rgba(0,0,0,.28);
}
.bossname{
  font-size:12px;
  letter-spacing:.12em;
  color: var(--gold);
  text-transform: uppercase;
}
.bossmeter{
  height:10px;
  border-radius:999px;
  background: rgba(255,255,255,.08);
  overflow:hidden;
  border:1px solid rgba(215,181,109,.18);
}
.bossfill{
  height:100%;
  width:100%;
  background: linear-gradient(90deg, rgba(255,92,92,.9), rgba(215,181,109,.95));
  box-shadow: 0 0 18px rgba(255,92,92,.35);
}

