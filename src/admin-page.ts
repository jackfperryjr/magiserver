// The /admin metrics dashboard — a single self-contained HTML page served by the
// server. It's a thin viewer: it asks for the admin key, remembers it in this
// browser (localStorage), then polls /admin/stats?key=… every few seconds and
// renders the live session table. The real gate is server-side (MAGILOOM_ADMIN_TOKEN
// checked on /admin/stats); this page just holds the key and draws the data.
//
// Kept as a string constant (no build step, no external assets) so it ships with the
// server and stays same-origin with the data it fetches. Palette mirrors the
// magiloom.com landing page for a consistent look.

export const ADMIN_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>Magiloom · Server Metrics</title>
<link href="https://fonts.googleapis.com/css2?family=VT323&family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet" />
<style>
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
  :root{
    --bg:#17133a;--panel:#1e1948;--card:#221c50;--border:#322c60;--border-hi:#544e96;
    --accent:#9a95ff;--accent-dim:#281f5c;--text:#c8c4e8;--bright:#f0eeff;--dim:#645d8e;
    --muted:#8b86cc;--green:#38d838;--red:#dd1818;--amber:#ffab5e;
  }
  body{background:var(--bg);color:var(--text);font-family:'Inter',system-ui,sans-serif;font-size:14px;line-height:1.5;min-height:100vh}
  a{color:var(--accent);text-decoration:none}
  .wrap{max-width:1000px;margin:0 auto;padding:32px 24px}
  h1{font-family:'VT323',monospace;font-size:34px;letter-spacing:.1em;color:var(--accent);text-shadow:0 0 14px rgba(139,134,248,.3)}
  .sub{color:var(--dim);font-size:12px;font-family:'JetBrains Mono',monospace;margin-top:2px}
  .head{display:flex;align-items:flex-end;justify-content:space-between;flex-wrap:wrap;gap:12px;margin-bottom:28px}
  .status{font-size:12px;font-family:'JetBrains Mono',monospace;color:var(--dim)}
  .status b{color:var(--green)}
  .status.err b{color:var(--red)}

  /* login gate */
  .gate{max-width:360px;margin:14vh auto 0;background:var(--card);border:1px solid var(--border);border-radius:12px;padding:28px}
  .gate h1{font-size:28px;margin-bottom:4px}
  .gate p{color:var(--muted);font-size:13px;margin:8px 0 18px}
  .gate input{width:100%;background:var(--panel);border:1px solid var(--border-hi);border-radius:8px;padding:11px 13px;color:var(--bright);font-size:14px;font-family:'JetBrains Mono',monospace;margin-bottom:12px}
  .gate input:focus{outline:none;border-color:var(--accent)}
  .gate button{width:100%;background:#605dd2;border:none;border-radius:8px;padding:11px;color:#fff;font-weight:600;font-size:14px;cursor:pointer;transition:background .15s}
  .gate button:hover{background:#706de0}
  .gate .err{color:var(--red);font-size:12px;min-height:16px;margin-top:8px}
  .gate .hint{color:var(--dim);font-size:11px;margin-top:14px;line-height:1.5}

  /* tiles */
  .tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:14px;margin-bottom:24px}
  .tile{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:18px 20px}
  .tile .k{font-size:11px;text-transform:uppercase;letter-spacing:.09em;color:var(--muted);font-weight:600}
  .tile .v{font-family:'VT323',monospace;font-size:42px;line-height:1;color:var(--bright);margin-top:8px}
  .tile .v.accent{color:var(--accent)}
  .tile .v.green{color:var(--green)}

  /* table */
  .card{background:var(--card);border:1px solid var(--border);border-radius:10px;overflow:hidden}
  .card-h{padding:14px 18px;border-bottom:1px solid var(--border);font-size:12px;text-transform:uppercase;letter-spacing:.09em;color:var(--muted);font-weight:600}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th{text-align:left;padding:10px 18px;font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--dim);font-weight:600;border-bottom:1px solid var(--border)}
  td{padding:11px 18px;border-bottom:1px solid var(--border)}
  tr:last-child td{border-bottom:none}
  .char{font-weight:600;color:var(--bright);font-family:'JetBrains Mono',monospace}
  .char.anon{color:var(--dim);font-style:italic;font-weight:400}
  .dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:7px;vertical-align:middle}
  .dot.on{background:var(--green);box-shadow:0 0 6px var(--green)}
  .dot.off{background:var(--dim)}
  .badge{display:inline-block;padding:2px 8px;border-radius:100px;font-size:11px;font-weight:600}
  .badge.paid{background:rgba(255,171,94,.14);color:var(--amber)}
  .badge.detached{background:var(--accent-dim);color:var(--muted)}
  .empty{padding:34px 18px;text-align:center;color:var(--dim);font-style:italic}
  .foot{margin-top:20px;font-size:11px;color:var(--dim);font-family:'JetBrains Mono',monospace;display:flex;justify-content:space-between;flex-wrap:wrap;gap:10px}
  .foot a{color:var(--dim)}
  .signout{background:none;border:1px solid var(--border-hi);border-radius:6px;color:var(--muted);padding:4px 10px;font-size:11px;cursor:pointer}
  .signout:hover{border-color:var(--accent);color:var(--accent)}
</style>
</head>
<body>

<div id="gate" class="gate" style="display:none">
  <h1>MAGILOOM</h1>
  <p>Server metrics — sign in with your Magiloom admin account.</p>
  <input id="email" type="email" placeholder="Email" autocomplete="username" />
  <input id="pass" type="password" placeholder="Password" autocomplete="current-password" />
  <button id="go">Sign in</button>
  <div id="gateErr" class="err"></div>
  <div class="hint">First time? Signing in with an authorized email creates your admin account (min. 8-character password).</div>
</div>

<div id="dash" class="wrap" style="display:none">
  <div class="head">
    <div>
      <h1>Server Metrics</h1>
      <div class="sub">magiloom · live sessions</div>
    </div>
    <div style="text-align:right">
      <div id="status" class="status">connecting…</div>
      <button id="signout" class="signout" style="margin-top:8px">Sign out</button>
    </div>
  </div>

  <div class="tiles">
    <div class="tile"><div class="k">Playing now</div><div id="t-online" class="v green">–</div></div>
    <div class="tile"><div class="k">Game sessions</div><div id="t-playing" class="v accent">–</div></div>
    <div class="tile"><div class="k">Connections</div><div id="t-conn" class="v">–</div></div>
    <div class="tile"><div class="k">Sessions held</div><div id="t-total" class="v">–</div></div>
    <div class="tile"><div class="k">Lich ports</div><div id="t-lich" class="v">–</div></div>
    <div class="tile"><div class="k">Uptime</div><div id="t-uptime" class="v" style="font-size:28px">–</div></div>
  </div>

  <div class="card">
    <div class="card-h">Sessions</div>
    <table>
      <thead><tr><th>Character</th><th>Game</th><th>Clients</th><th>Connected for</th><th>Flags</th></tr></thead>
      <tbody id="rows"></tbody>
    </table>
  </div>

  <div class="foot">
    <span id="foot-push">push: –</span>
    <a href="/health" target="_blank">/health</a>
  </div>
</div>

<script>
(function(){
  var TOKEN_LS = 'magiloom-admin-token';
  var gate = document.getElementById('gate'), dash = document.getElementById('dash');
  var emailInput = document.getElementById('email'), passInput = document.getElementById('pass');
  var gateErr = document.getElementById('gateErr');
  var timer = null;

  function showGate(msg){
    if(timer){clearInterval(timer);timer=null;}
    gate.style.display='block'; dash.style.display='none';
    gateErr.textContent = msg || '';
    emailInput.focus();
  }
  function showDash(){ gate.style.display='none'; dash.style.display='block'; }

  function fmtDur(ms){
    if(ms<0)ms=0; var s=Math.floor(ms/1000);
    var d=Math.floor(s/86400); s-=d*86400;
    var h=Math.floor(s/3600); s-=h*3600;
    var m=Math.floor(s/60); s-=m*60;
    if(d)return d+'d '+h+'h';
    if(h)return h+'h '+m+'m';
    if(m)return m+'m '+s+'s';
    return s+'s';
  }
  function esc(t){var d=document.createElement('div');d.textContent=t;return d.innerHTML;}

  function render(d){
    document.getElementById('t-online').textContent = d.online;
    document.getElementById('t-playing').textContent = d.playing;
    document.getElementById('t-conn').textContent = d.connections;
    document.getElementById('t-total').textContent = d.totalSessions;
    document.getElementById('t-lich').textContent = d.lichPortsInUse;
    document.getElementById('t-uptime').textContent = fmtDur(d.uptimeSec*1000);
    document.getElementById('foot-push').textContent = 'push: ' + (d.push ? 'ready' : 'off');
    var st = document.getElementById('status');
    st.className='status'; st.innerHTML='live · <b>updated ' + new Date().toLocaleTimeString() + '</b>';

    var rows = document.getElementById('rows');
    if(!d.sessions.length){ rows.innerHTML='<tr><td colspan="5" class="empty">No active sessions.</td></tr>'; return; }
    var now = d.now || Date.now();
    rows.innerHTML = d.sessions.map(function(s){
      var name = s.charName ? '<span class="char">'+esc(s.charName)+'</span>' : '<span class="char anon">(logging in…)</span>';
      var dot = '<span class="dot '+(s.gameConnected?'on':'off')+'"></span>'+(s.gameConnected?'connected':'idle');
      var flags = '';
      if(s.paid) flags += '<span class="badge paid">watch</span> ';
      if(s.detached) flags += '<span class="badge detached">detached</span>';
      return '<tr><td>'+name+'</td><td>'+dot+'</td><td>'+s.clients+'</td><td>'+fmtDur(now-s.connectedAt)+'</td><td>'+(flags||'—')+'</td></tr>';
    }).join('');
  }

  function poll(){
    var token = localStorage.getItem(TOKEN_LS);
    if(!token){ showGate(); return; }
    fetch('/admin/stats',{ headers:{ 'Authorization':'Bearer '+token } })
      .then(function(r){
        if(r.status===401||r.status===403){ localStorage.removeItem(TOKEN_LS); showGate('Session expired — sign in again.'); throw new Error('auth'); }
        if(!r.ok) throw new Error('http '+r.status);
        return r.json();
      })
      .then(render)
      .catch(function(e){
        if(String(e.message)==='auth')return;
        var st=document.getElementById('status'); st.className='status err'; st.innerHTML='<b>offline</b> · retrying…';
      });
  }

  function start(){ showDash(); poll(); if(timer)clearInterval(timer); timer=setInterval(poll,4000); }

  function login(){
    var email=emailInput.value.trim(), pass=passInput.value;
    if(!email||!pass){ gateErr.textContent='Enter your email and password.'; return; }
    gateErr.textContent='Signing in…';
    fetch('/admin/login',{ method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({email:email,password:pass}) })
      .then(function(r){ return r.json().then(function(d){ return {ok:r.ok,d:d}; }); })
      .then(function(res){
        if(res.d && res.d.ok && res.d.token){ localStorage.setItem(TOKEN_LS,res.d.token); passInput.value=''; start(); }
        else { gateErr.textContent=(res.d && res.d.error) || 'Sign in failed.'; }
      })
      .catch(function(){ gateErr.textContent='Server unreachable.'; });
  }

  document.getElementById('go').onclick=login;
  passInput.addEventListener('keydown',function(e){ if(e.key==='Enter')login(); });
  emailInput.addEventListener('keydown',function(e){ if(e.key==='Enter')passInput.focus(); });
  document.getElementById('signout').onclick=function(){ localStorage.removeItem(TOKEN_LS); showGate(); };

  if(localStorage.getItem(TOKEN_LS)) start(); else showGate();
})();
</script>
</body>
</html>`
