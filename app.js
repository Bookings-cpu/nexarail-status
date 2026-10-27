// NexaRail wallet & network dashboard.
// Security model: every string that comes from the chain (monikers, addresses, memos,
// logs) is untrusted and goes through esc() or textContent — never raw innerHTML.
// Wallet code (CosmJS) is self-hosted and pinned under vendor/, loaded only when needed.

// ---------- config ----------
// Endpoints are tried in order with automatic failover. Adding a host here also
// requires adding it to connect-src in app.html's Content-Security-Policy.
const ENDPOINTS = [
  { rpc: "https://5-161-72-48.nip.io/rpc/", rest: "https://5-161-72-48.nip.io", ws: "wss://5-161-72-48.nip.io/rpc/websocket" },
];
const CHAIN_ID = "nexarail-mainnet-2";
const DENOM = "unxrl", PREFIX = "nxr", GAS_PRICE = "0.001unxrl", GAS_ADJ = 1.4;
const VAULT_KEY = "nexarail_vault_v1", EXT_KEY = "nexarail_ext";
const KDF_ITER = 600000, KDF_ITER_V1 = 200000, MIN_PASS = 10;
const AUTOLOCK_MS = 15 * 60 * 1000;
const EXPLORER = "explorer/#/nexarail";
const VENDOR = "./vendor/cosmos-0.32.4.js";

const chainInfo = {
  chainId: CHAIN_ID, chainName: "NexaRail", rpc: ENDPOINTS[0].rpc, rest: ENDPOINTS[0].rest, bip44: { coinType: 118 },
  bech32Config: { bech32PrefixAccAddr:"nxr", bech32PrefixAccPub:"nxrpub", bech32PrefixValAddr:"nxrvaloper", bech32PrefixValPub:"nxrvaloperpub", bech32PrefixConsAddr:"nxrvalcons", bech32PrefixConsPub:"nxrvalconspub" },
  currencies: [{ coinDenom:"NXRL", coinMinimalDenom:DENOM, coinDecimals:6 }],
  feeCurrencies: [{ coinDenom:"NXRL", coinMinimalDenom:DENOM, coinDecimals:6, gasPriceStep:{ low:0.001, average:0.001, high:0.01 } }],
  stakeCurrency: { coinDenom:"NXRL", coinMinimalDenom:DENOM, coinDecimals:6 },
  features: [],
};
const WALLETS = {
  keplr: { name:"Keplr", get:() => window.keplr },
  leap: { name:"Leap", get:() => window.leap },
  cosmostation: { name:"Cosmostation", get:() => window.cosmostation?.providers?.keplr },
};

// ---------- utils ----------
const $ = id => document.getElementById(id);
const ESC = { "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" };
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ESC[c]);
const fmt = n => new Intl.NumberFormat("en-US").format(n);
const short = a => a ? a.slice(0, 10) + "…" + a.slice(-6) : "—";
const big = v => { try { return BigInt(String(v ?? "0").split(".")[0] || "0"); } catch { return 0n; } };
function fmtU(u, maxFrac = 6){
  const b = big(u), neg = b < 0n, a = neg ? -b : b;
  const frac = (a % 1000000n).toString().padStart(6, "0").slice(0, maxFrac).replace(/0+$/, "");
  return (neg ? "-" : "") + (a / 1000000n).toLocaleString("en-US") + (frac ? "." + frac : "");
}
const fmtShort = u => { const n = Number(big(u)) / 1e6; return n >= 1e6 ? (n/1e6).toFixed(2) + "M" : n >= 1e3 ? (n/1e3).toFixed(1) + "K" : n.toFixed(2); };
function ago(ms){ const s = Math.max(0, (Date.now() - ms) / 1000);
  return s < 60 ? Math.round(s) + "s" : s < 3600 ? Math.round(s/60) + "m" : s < 86400 ? Math.round(s/3600) + "h" : Math.round(s/86400) + "d"; }
function parseAmount(input){
  const s = String(input).trim().replace(/,/g, "");
  if (!/^\d+(\.\d{1,6})?$/.test(s)) throw new Error("Enter a valid amount (up to 6 decimal places)");
  const [whole, frac = ""] = s.split(".");
  const v = BigInt(whole) * 1000000n + BigInt((frac + "000000").slice(0, 6));
  if (v <= 0n) throw new Error("Amount must be greater than zero");
  return v;
}
const uToInput = u => fmtU(u).replace(/,/g, "");
const store = {
  get(k){ try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v){ try { localStorage.setItem(k, v); return true; } catch { return false; } },
  del(k){ try { localStorage.removeItem(k); } catch {} },
};
const txLink = h => `${EXPLORER}/tx/${encodeURIComponent(h)}`;
const blockLink = h => `${EXPLORER}/block/${encodeURIComponent(h)}`;
const valLink = op => `${EXPLORER}/staking/${encodeURIComponent(op)}`;

// ---------- network layer with failover ----------
let epIdx = 0;
const ep = () => ENDPOINTS[epIdx];
async function getJSON(kind, path, { timeout = 8000 } = {}){
  let lastErr;
  for (let i = 0; i < ENDPOINTS.length; i++){
    const e = ENDPOINTS[(epIdx + i) % ENDPOINTS.length];
    try {
      const r = await fetch(e[kind] + path, { cache: "no-store", signal: AbortSignal.timeout(timeout) });
      if (r.status === 429) throw new Error("Rate limited by the RPC — slowing down");
      if (r.status >= 500) throw new Error("RPC error " + r.status);
      const d = await r.json();
      if (i) epIdx = (epIdx + i) % ENDPOINTS.length;
      return d;
    } catch (err) { lastErr = err; }
  }
  throw lastErr;
}
const rpc = p => getJSON("rpc", p);
const rest = p => getJSON("rest", p);

// ---------- toasts ----------
function toast(text, kind = "", ms = 4500, link){
  const el = document.createElement("div"); el.className = "toast " + kind; el.textContent = text;
  if (link){ el.append(" "); const a = document.createElement("a"); a.href = link.href; a.target = "_blank"; a.rel = "noopener"; a.textContent = link.text; el.append(a); }
  $("toasts").append(el); setTimeout(() => el.remove(), ms);
}

// ---------- identicons & colours ----------
function hashStr(s){ let h = 2166136261; for (const c of s){ h ^= c.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; } return h; }
const hueFor = s => hashStr(s) % 360;
function drawIdenticon(canvas, seed){
  const ctx = canvas.getContext("2d"), W = canvas.width, N = 5, cell = W / N;
  let h = hashStr(seed); const rnd = () => { h ^= h << 13; h >>>= 0; h ^= h >>> 17; h ^= h << 5; h >>>= 0; return h / 4294967296; };
  const hue = Math.floor(rnd() * 360), c1 = `hsl(${hue} 85% 60%)`, c2 = `hsl(${(hue+150)%360} 80% 55%)`;
  ctx.fillStyle = `hsl(${hue} 40% 14%)`; ctx.fillRect(0, 0, W, W);
  for (let y = 0; y < N; y++){ const row = [rnd(), rnd(), rnd()];
    for (let x = 0; x < N; x++){ const v = row[x < 3 ? x : N-1-x];
      if (v > .4){ ctx.fillStyle = v > .7 ? c1 : c2; ctx.fillRect(x*cell, y*cell, cell+.5, cell+.5); } } }
}
const dot = name => { const hue = hueFor(name); return `<i class="vdot" style="color:hsl(${hue} 80% 60%);background:hsl(${hue} 80% 60%)"></i>`; };

// =====================================================================
// LIVE CHAIN FEED — WebSocket NewBlockHeader with polling fallback
// =====================================================================
const MAXB = 30;
let blocks = [];            // newest first: {height, proposer, txs, timeMs}
let consMap = {};           // proposer hex -> moniker
let lastArrival = 0, netState = "", catchingUp = false, renderedTop = 0, rpcDown = false;
let ws = null, wsBackoff = 2000, pollTimer = null, polling = false;

function setLive(state){
  if (state === netState) return; netState = state;
  const el = $("pulse-live"), map = {
    live: ["LIVE", "var(--gold)", "#1a1200"], syncing: ["SYNC", "#f59e0b", "#1a1200"],
    slow: ["DELAYED", "#f59e0b", "#1a1200"], stalled: ["STALLED", "var(--red)", "#fff"], offline: ["OFFLINE", "#4b5563", "#fff"] };
  const [t, bg, fg] = map[state]; el.textContent = t; el.style.background = bg; el.style.color = fg;
  const b = $("net-banner");
  if (state === "offline"){ b.className = "banner show bad"; b.textContent = "Can't reach the NexaRail RPC right now. Retrying automatically — your funds are unaffected."; }
  else if (state === "stalled"){ b.className = "banner show bad"; b.textContent = "No new block for over a minute. The network may be halted or the RPC node is behind."; }
  else if (state === "slow"){ b.className = "banner show"; b.textContent = "Blocks are arriving slower than usual."; }
  else b.className = "banner";
}
function updateHealth(){
  if (rpcDown) return setLive("offline");
  if (!blocks.length) return;
  const age = Date.now() - Math.max(lastArrival, blocks[0].timeMs);
  setLive(catchingUp ? "syncing" : age > 60000 ? "stalled" : age > 20000 ? "slow" : "live");
}

function addBlocks(list){
  let added = false;
  for (const b of list.sort((a, b) => a.height - b.height)){
    if (blocks.length && b.height <= blocks[0].height) continue;
    blocks.unshift(b); added = true;
  }
  if (!added) return;
  blocks = blocks.slice(0, MAXB); lastArrival = Date.now();
  const he = $("tb-height"); he.textContent = fmt(blocks[0].height); he.classList.add("flash"); setTimeout(() => he.classList.remove("flash"), 450);
  const c = $("pulse-core"); c.classList.remove("beat"); void c.offsetWidth; c.classList.add("beat");
  renderBlocks(); renderCadence(); updateHealth();
}
const metaToBlock = m => ({ height: Number(m.header.height), proposer: m.header.proposer_address, txs: Number(m.num_txs ?? 0), timeMs: new Date(m.header.time).getTime() });

async function backfill(toHeight){
  const top = blocks.length ? blocks[0].height : toHeight - 20;
  if (toHeight <= top) return;
  const min = Math.max(top + 1, toHeight - 19);
  const d = await rpc(`blockchain?minHeight=${min}&maxHeight=${toHeight}`);
  addBlocks((d.result?.block_metas || []).map(metaToBlock));
}
async function syncStatus(){
  const d = await rpc("status"); const si = d.result.sync_info;
  catchingUp = !!si.catching_up;
  await backfill(Number(si.latest_block_height));
  rpcDown = false; updateHealth();
}

function renderCadence(){
  const times = blocks.map(b => b.timeMs);
  const data = []; for (let i = times.length - 1; i > 0; i--) data.push((times[i-1] - times[i]) / 1000);
  const svg = $("cad-chart"); if (data.length < 2){ svg.innerHTML = ""; return; }
  const W = 300, H = 92, pad = 4, min = Math.min(...data), max = Math.max(...data), span = Math.max(.2, max - min);
  const pts = data.map((v, i) => [pad + i * (W - 2*pad) / (data.length - 1), H - pad - ((v - min) / span) * (H - 2*pad)]);
  const line = pts.map((p, i) => (i ? "L" : "M") + p[0].toFixed(1) + " " + p[1].toFixed(1)).join(" ");
  const last = pts[pts.length - 1];
  svg.innerHTML = `<path d="${line} L${last[0].toFixed(1)} ${H} L${pts[0][0].toFixed(1)} ${H} Z" fill="url(#areaGrad)"/><path d="${line}" fill="none" stroke="#f5c451" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/><circle cx="${last[0].toFixed(1)}" cy="${last[1].toFixed(1)}" r="3.5" fill="#f5c451"/>`;
  const avg = data.reduce((a, b) => a + b, 0) / data.length;
  $("cad-avg").innerHTML = avg.toFixed(2) + "<small>s avg</small>";
  $("cad-min").textContent = min.toFixed(2) + "s"; $("cad-max").textContent = max.toFixed(2) + "s";
  $("cad-bpm").textContent = (60 / avg).toFixed(1); $("tb-blocktime").textContent = avg.toFixed(1) + "s";
  document.querySelectorAll(".js-blocktime").forEach(e => e.textContent = avg.toFixed(1));
}
function renderBlocks(){
  if (!blocks.length) return;
  const fresh = blocks[0].height !== renderedTop && renderedTop !== 0; renderedTop = blocks[0].height;
  $("blocks").innerHTML = blocks.slice(0, 9).map((b, i) => {
    const name = consMap[b.proposer] || (b.proposer.slice(0, 8) + "…");
    return `<div class="blk ${i === 0 && fresh ? "new" : ""}"><a class="h xl" style="border:0" href="${blockLink(b.height)}" target="_blank" rel="noopener">#${fmt(b.height)}</a><span class="p">${dot(name)}<span>${esc(name)}</span></span><span class="t">${b.txs}</span><span class="a" data-t="${b.timeMs}">${ago(b.timeMs)}</span></div>`;
  }).join("");
}
setInterval(() => { document.querySelectorAll(".blk .a").forEach(a => { a.textContent = ago(Number(a.dataset.t)); }); updateHealth(); }, 1000);

function openWS(){
  if (ws || document.hidden) return;
  let opened = false;
  try { ws = new WebSocket(ep().ws); } catch { ws = null; return startPolling(); }
  const to = setTimeout(() => { if (!opened) ws?.close(); }, 6000);
  ws.onopen = () => { opened = true; rpcDown = false; clearTimeout(to); wsBackoff = 2000; stopPolling(); $("blk-meta").textContent = "streaming";
    ws.send(JSON.stringify({ jsonrpc: "2.0", method: "subscribe", id: 1, params: { query: "tm.event='NewBlockHeader'" } })); };
  ws.onmessage = ev => { try {
    const v = JSON.parse(ev.data).result?.data?.value; if (!v?.header) return;
    const b = { height: Number(v.header.height), proposer: v.header.proposer_address, txs: Number(v.num_txs ?? 0), timeMs: new Date(v.header.time).getTime() };
    if (blocks.length && b.height > blocks[0].height + 1) backfill(b.height - 1).then(() => addBlocks([b])).catch(() => addBlocks([b]));
    else addBlocks([b]);
  } catch {} };
  ws.onclose = () => { clearTimeout(to); ws = null; if (document.hidden) return;
    startPolling(); setTimeout(openWS, wsBackoff); wsBackoff = Math.min(wsBackoff * 2, 60000); };
  ws.onerror = () => ws?.close();
}
function startPolling(){
  if (polling) return; polling = true; $("blk-meta").textContent = "polling";
  const loop = async () => {
    if (!polling) return;
    try { await syncStatus(); } catch { rpcDown = true; updateHealth(); }
    if (polling) pollTimer = setTimeout(loop, 2000);
  };
  loop();
}
function stopPolling(){ polling = false; clearTimeout(pollTimer); }
document.addEventListener("visibilitychange", () => {
  if (document.hidden){ stopPolling(); ws?.close(); ws = null; }
  else { syncStatus().catch(() => { rpcDown = true; updateHealth(); }).finally(openWS); refreshAccount(); }
});

// =====================================================================
// NETWORK STATS + VALIDATORS
// =====================================================================
let validators = [], valByOp = {}, totalPower = 0, aprPct = null, unbondDays = 21;

async function consAddrFromPubkey(b64){
  const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(hash.slice(0, 20)).map(b => b.toString(16).padStart(2, "0")).join("").toUpperCase();
}
function valRow(v){
  const pct = totalPower ? Number(v.tokens) / totalPower * 100 : 0, name = v.description.moniker;
  const mine = delegations.some(d => d.op === v.operator_address);
  return `<div class="val click" role="button" tabindex="0" data-act="stake-open" data-arg="${esc(v.operator_address)}" title="Stake with ${esc(name)}"><span class="n">${dot(name)}<span>${esc(name)}</span>${mine ? '<span class="mine">YOU</span>' : ""}</span><span class="bar"><i style="width:${pct.toFixed(2)}%"></i></span><span class="pct">${pct < 0.1 ? "&lt;0.1" : pct.toFixed(1)}%</span><span class="com">${(Number(v.commission.commission_rates.rate) * 100).toFixed(0)}%</span></div>`;
}
function renderValidators(){
  if (!validators.length) return;
  $("vals").innerHTML = validators.map(valRow).join("");
  const q = $("val-search").value.trim().toLowerCase();
  const list = q ? validators.filter(v => v.description.moniker.toLowerCase().includes(q) || v.operator_address.includes(q)) : validators;
  $("vals-full").innerHTML = list.length ? list.map(valRow).join("") : '<div class="empty">No validator matches that search</div>';
}
async function refreshValidators(){
  try {
    const d = await rest("/cosmos/staking/v1beta1/validators?status=BOND_STATUS_BONDED&pagination.limit=300");
    validators = (d.validators || []).sort((a, b) => Number(b.tokens) - Number(a.tokens));
    totalPower = validators.reduce((a, v) => a + Number(v.tokens), 0);
    valByOp = Object.fromEntries(validators.map(v => [v.operator_address, v]));
    // Nakamoto coefficient: fewest validators that together hold >1/3 of power (can halt the chain).
    let acc = 0, nak = 0; for (const v of validators){ acc += Number(v.tokens); nak++; if (acc > totalPower / 3) break; }
    $("tb-validators").textContent = validators.length; $("val-meta").textContent = validators.length + " active →";
    $("val-meta-2").textContent = `${validators.length} active · sorted by voting power · Nakamoto coefficient ${nak} · click a validator to stake`;
    renderValidators();
    const m = {}; await Promise.all(validators.map(async v => { try { m[await consAddrFromPubkey(v.consensus_pubkey.key)] = v.description.moniker; } catch {} }));
    consMap = m; renderBlocks();
  } catch { if (!validators.length) $("vals").innerHTML = '<div class="empty">Validators unavailable — retrying</div>'; }
}
async function refreshNetwork(){
  const get = p => rest(p).catch(() => null);
  const [pool, supply, cp, params, prov, dist] = await Promise.all([
    get("/cosmos/staking/v1beta1/pool"), get("/cosmos/bank/v1beta1/supply/by_denom?denom=unxrl"),
    get("/cosmos/distribution/v1beta1/community_pool"), get("/cosmos/staking/v1beta1/params"),
    get("/cosmos/mint/v1beta1/annual_provisions"), get("/cosmos/distribution/v1beta1/params")]);
  if (pool && supply){
    const bonded = Number(pool.pool.bonded_tokens), total = Number(supply.amount.amount), pct = total ? bonded / total * 100 : 0;
    $("kv-supply").textContent = fmtShort(total) + " NXRL"; $("kv-bonded").textContent = fmtShort(bonded) + " NXRL";
    $("donut-pct").textContent = pct.toFixed(1) + "%";
    $("donut-arc").style.strokeDashoffset = (2 * Math.PI * 50 * (1 - Math.max(.02, pct / 100))).toFixed(2);
    if (prov && dist && bonded){
      aprPct = Number(prov.annual_provisions) * (1 - Number(dist.params.community_tax)) / bonded * 100;
      $("kv-apr").textContent = "~" + aprPct.toFixed(1) + "%"; $("st-apr").textContent = "~" + aprPct.toFixed(1) + "%";
    }
  }
  const cpAmt = (cp?.pool || []).find(x => x.denom === DENOM); if (cpAmt) $("kv-pool").textContent = fmtShort(cpAmt.amount) + " NXRL";
  if (params){ unbondDays = Math.round(parseInt(params.params.unbonding_time) / 86400); $("kv-unbond").textContent = unbondDays + " days"; }
}

// =====================================================================
// WALLET SESSION
// =====================================================================
let libP = null;
const lib = () => (libP ??= import(VENDOR).catch(() => { libP = null; throw new Error("Couldn't load wallet code — check your connection and try again"); }));
const S = { client: null, addr: null, signer: null, isLocal: false, ext: null, balance: 0n };
let delegations = [], rewardsByOp = {}, totalRewards = 0n;

async function activateSigner(signer, address, label, { isLocal = false, ext = null } = {}){
  const { SigningStargateClient, GasPrice } = await lib();
  S.client = await SigningStargateClient.connectWithSigner(ep().rpc, signer, { gasPrice: GasPrice.fromString(GAS_PRICE) });
  Object.assign(S, { addr: address, signer, isLocal, ext });
  ["hero-identicon", "tb-identicon", "sb-identicon"].forEach(id => drawIdenticon($(id), address));
  $("my-address").textContent = short(address); $("my-address").title = address;
  $("tb-addr").textContent = short(address); $("sb-addr").textContent = short(address); $("receive-address").textContent = address;
  $("conn-label").textContent = label; $("save-device-link").style.display = isLocal ? "inline" : "none";
  const saved = readVault(); if (isLocal && saved?.addr === address){ $("save-device-link").textContent = "Saved to this device ✓"; $("save-device-link").disabled = true; }
  else { $("save-device-link").textContent = "Save to this device"; $("save-device-link").disabled = false; }
  $("acct-explorer").href = `${EXPLORER}/account/${address}`;
  $("hero-onboard").style.display = "none"; $("hero-balance").style.display = "flex";
  $("acct").style.display = "flex"; $("sb-wallet").style.display = "block"; $("overview-activity-wrap").style.display = "block";
  document.querySelectorAll(".locked[data-nav]").forEach(e => e.classList.remove("locked"));
  const { QRCode } = await lib();
  QRCode.toCanvas($("receive-qr"), address, { width: 196, margin: 1, color: { dark: "#07090d", light: "#ffffff" } });
  lastActivity = Date.now();
  route(); refreshAccount(); loadActivity();
}
function disconnect(reason){
  Object.assign(S, { client: null, addr: null, signer: null, isLocal: false, ext: null, balance: 0n });
  delegations = []; rewardsByOp = {}; totalRewards = 0n; store.del(EXT_KEY);
  $("hero-onboard").style.display = "block"; $("hero-balance").style.display = "none";
  $("acct").style.display = "none"; $("sb-wallet").style.display = "none"; $("overview-activity-wrap").style.display = "none";
  document.querySelectorAll("[data-nav=receive],[data-nav=send],[data-nav=staking],[data-nav=activity]").forEach(e => { if (e.classList.contains("navitem") || e.closest(".bottomnav")) e.classList.add("locked"); });
  ["activity-list-preview", "activity-list-send", "activity-list-full"].forEach(id => $(id).innerHTML = '<div class="empty">—</div>');
  document.querySelectorAll(".modal-backdrop.show").forEach(m => m.classList.remove("show"));
  go("overview"); checkSavedWallet(); renderValidators();
  if (reason) toast(reason);
}

async function refreshAccount(){
  if (!S.addr || document.hidden) return;
  const a = S.addr;
  const [bal, dels, rws, unb] = await Promise.all([
    rest(`/cosmos/bank/v1beta1/balances/${a}`).catch(() => null),
    rest(`/cosmos/staking/v1beta1/delegations/${a}`).catch(() => null),
    rest(`/cosmos/distribution/v1beta1/delegators/${a}/rewards`).catch(() => null),
    rest(`/cosmos/staking/v1beta1/delegators/${a}/unbonding_delegations`).catch(() => null)]);
  if (a !== S.addr) return;
  if (bal){
    S.balance = big((bal.balances || []).find(b => b.denom === DENOM)?.amount);
    const t = fmtU(S.balance);
    $("my-balance").innerHTML = esc(t) + '<span class="denom">NXRL</span>';
    $("send-balance-hint").textContent = t; $("tb-bal").textContent = t + " NXRL"; $("sb-bal").textContent = t + " NXRL";
  }
  if (dels){
    delegations = (dels.delegation_responses || []).map(d => ({ op: d.delegation.validator_address, amount: big(d.balance.amount) })).filter(d => d.amount > 0n);
    rewardsByOp = Object.fromEntries((rws?.rewards || []).map(r => [r.validator_address, big((r.reward || []).find(c => c.denom === DENOM)?.amount)]));
    totalRewards = big((rws?.total || []).find(c => c.denom === DENOM)?.amount);
    renderStaking(unb?.unbonding_responses || []); renderValidators();
  }
}
setInterval(refreshAccount, 20000);

// ---------- staking UI ----------
function renderStaking(unbondings){
  const staked = delegations.reduce((a, d) => a + d.amount, 0n);
  $("st-staked").innerHTML = esc(fmtU(staked, 2)) + "<small>NXRL</small>";
  $("st-count").textContent = delegations.length ? `across ${delegations.length} validator${delegations.length > 1 ? "s" : ""}` : "Not staking yet";
  $("st-rewards").innerHTML = esc(fmtU(totalRewards, 4)) + "<small>NXRL</small>";
  $("claim-all-btn").style.display = totalRewards > 0n ? "" : "none";
  $("hero-staked").textContent = staked > 0n ? `Staked ${fmtU(staked, 2)} NXRL · ` : "";
  $("delegations").innerHTML = !delegations.length
    ? `<div class="empty">You're not staking yet. Pick a validator from the <button class="link" data-nav="network" style="color:var(--gold)">validator list</button> to start earning ~${aprPct ? aprPct.toFixed(0) : "—"}% a year.</div>`
    : `<table class="tx-table"><thead><tr><th>Validator</th><th class="r">Staked</th><th class="r hide-sm">Rewards</th><th class="r">Actions</th></tr></thead><tbody>` +
      delegations.sort((a, b) => (b.amount > a.amount) - (b.amount < a.amount)).map(d => {
        const v = valByOp[d.op], name = v?.description.moniker || short(d.op);
        return `<tr><td><span class="tx-dir">${dot(name)}<a class="xl" href="${valLink(d.op)}" target="_blank" rel="noopener">${esc(name)}</a>${v ? "" : ' <span class="pill warn">INACTIVE</span>'}</span></td><td class="r tx-amt">${esc(fmtU(d.amount, 2))}</td><td class="r tx-amt reward hide-sm">${esc(fmtU(rewardsByOp[d.op] || 0n, 4))}</td><td class="r"><div class="row-actions"><button class="ghost btn-sm" data-act="stake-open" data-arg="${esc(d.op)}">Stake</button><button class="ghost btn-sm" data-act="unstake-open" data-arg="${esc(d.op)}">Unstake</button></div></td></tr>`;
      }).join("") + "</tbody></table>";
  const rows = unbondings.flatMap(u => u.entries.map(e => ({ op: u.validator_address, amount: big(e.balance), done: new Date(e.completion_time) })));
  $("unbonding-wrap").style.display = rows.length ? "" : "none";
  $("unbond-meta").textContent = rows.length ? `${unbondDays}-day unbonding period` : "";
  $("unbondings").innerHTML = rows.length ? `<table class="tx-table"><thead><tr><th>Validator</th><th class="r">Amount</th><th class="r">Available</th></tr></thead><tbody>` +
    rows.sort((a, b) => a.done - b.done).map(r => `<tr><td>${esc(valByOp[r.op]?.description.moniker || short(r.op))}</td><td class="r tx-amt">${esc(fmtU(r.amount, 2))}</td><td class="r tx-h" title="${esc(r.done.toLocaleString())}">${esc(r.done.toLocaleDateString(undefined, { month: "short", day: "numeric" }))} · in ${Math.max(0, Math.ceil((r.done - Date.now()) / 86400000))}d</td></tr>`).join("") + "</tbody></table>" : "";
}

// ---------- tx plumbing ----------
async function estimateFee(msgs, memo = ""){
  const { GasPrice, calculateFee } = await lib();
  const gas = await S.client.simulate(S.addr, msgs, memo);
  return calculateFee(Math.ceil(gas * GAS_ADJ), GasPrice.fromString(GAS_PRICE));
}
const feeU = fee => big(fee.amount[0]?.amount);
async function broadcast(msgs, fee, memo = ""){
  const res = await S.client.signAndBroadcast(S.addr, msgs, fee, memo);
  if (res.code) throw new Error(`Rejected on-chain (code ${res.code}): ${res.rawLog || ""}`);
  toast(`Confirmed in block #${fmt(res.height)}.`, "ok", 9000, { href: txLink(res.transactionHash), text: "View transaction ↗" });
  setTimeout(() => { refreshAccount(); loadActivity(); }, 600);
  return res;
}
const niceErr = e => {
  const m = String(e?.message || e);
  if (/insufficient funds|smaller than/i.test(m)) return "Not enough NXRL to cover this amount plus the network fee.";
  if (/Request rejected|rejected by user/i.test(m)) return "You rejected the request in your wallet.";
  if (/Failed to fetch|NetworkError|timeout/i.test(m)) return "Couldn't reach the network. Check your connection and try again.";
  return m;
};
const msgSend = (to, amt) => ({ typeUrl: "/cosmos.bank.v1beta1.MsgSend", value: { fromAddress: S.addr, toAddress: to, amount: [{ denom: DENOM, amount: amt.toString() }] } });

// ---------- address validation ----------
async function checkAddress(a){
  if (!a) return { ok: false, msg: "" };
  try {
    const { fromBech32 } = await lib(); const { prefix, data } = fromBech32(a);
    if (prefix !== PREFIX) return { ok: false, msg: prefix === "nxrvaloper" ? "That's a validator address. To stake, use the Staking tab." : `Wrong network: this is a "${prefix}" address, not NexaRail (nxr1…).` };
    if (data.length !== 20 && data.length !== 32) return { ok: false, msg: "Address has the wrong length." };
    return { ok: true, self: a === S.addr };
  } catch { return { ok: false, msg: "Not a valid address — check for typos (the checksum doesn't match)." }; }
}

// ---------- send ----------
let pendingSend = null;
$("send-to").addEventListener("input", async e => {
  const a = e.target.value.trim(), r = await checkAddress(a), h = $("send-to-hint");
  if (a !== $("send-to").value.trim()) return;
  h.style.color = r.ok ? (r.self ? "#fbbf24" : "var(--green)") : "var(--red)";
  h.textContent = !a ? "" : r.ok ? (r.self ? "⚠ This is your own address." : "✓ Valid NexaRail address") : r.msg;
});
async function sendReserve(){
  try { return feeU(await estimateFee([msgSend(S.addr, 1n)])) * 2n; } catch { return 2000n; }
}
async function reviewSend(){
  const st = $("send-status"), btn = $("review-btn"); st.className = "status-box";
  const to = $("send-to").value.trim(), memo = $("send-memo").value.trim();
  try {
    if (!S.client) throw new Error("Wallet not connected");
    const chk = await checkAddress(to); if (!chk.ok) throw new Error(chk.msg || "Enter a recipient address");
    const amt = parseAmount($("send-amount").value);
    if (amt > S.balance) throw new Error(`You only have ${fmtU(S.balance)} NXRL.`);
    btn.disabled = true; btn.textContent = "Estimating fee…";
    const msg = msgSend(to, amt), fee = await estimateFee([msg], memo);
    if (amt + feeU(fee) > S.balance) throw new Error(`Amount plus fee (${fmtU(feeU(fee))} NXRL) exceeds your balance. Try MAX.`);
    pendingSend = { msg, fee, memo };
    $("rv-from").textContent = S.addr; $("rv-to").textContent = to + (chk.self ? "  (yourself)" : "");
    $("rv-amount").textContent = fmtU(amt) + " NXRL"; $("rv-fee").textContent = fmtU(feeU(fee)) + " NXRL";
    $("rv-memo-row").style.display = memo ? "flex" : "none"; $("rv-memo").textContent = memo;
    $("send-form-step").style.display = "none"; $("send-review-step").style.display = "block"; $("confirm-send-btn").focus();
  } catch (e){ st.className = "status-box bad"; st.textContent = niceErr(e); }
  finally { btn.disabled = false; btn.textContent = "Review transfer"; }
}
function cancelReview(){ pendingSend = null; $("send-form-step").style.display = "block"; $("send-review-step").style.display = "none"; $("confirm-status").className = "status-box"; }
async function confirmSend(){
  const st = $("confirm-status"), btn = $("confirm-send-btn"); if (!pendingSend) return;
  try {
    btn.disabled = true; st.className = "status-box pending"; st.textContent = S.isLocal ? "Signing and broadcasting…" : "Approve the transaction in your wallet…";
    const { msg, fee, memo } = pendingSend; const res = await broadcast([msg], fee, memo);
    st.className = "status-box ok"; st.innerHTML = `Sent in block #${fmt(res.height)}. <a class="xl" href="${txLink(res.transactionHash)}" target="_blank" rel="noopener">View transaction ↗</a>`;
    ["send-amount", "send-memo", "send-to"].forEach(id => $(id).value = ""); $("send-to-hint").textContent = ""; pendingSend = null;
  } catch (e){ st.className = "status-box bad"; st.textContent = niceErr(e); }
  finally { btn.disabled = false; }
}
$("send-form-step").addEventListener("submit", e => { e.preventDefault(); reviewSend(); });

// ---------- stake / unstake modal ----------
let stakeCtx = null;   // {mode, op, fee?, amt?}
function openStake(op, mode){
  if (!S.addr){ toast("Connect or create a wallet first to stake."); go("overview"); return; }
  const v = valByOp[op]; const name = v?.description.moniker || short(op);
  const del = delegations.find(d => d.op === op)?.amount || 0n;
  stakeCtx = { mode, op, avail: mode === "delegate" ? S.balance : del };
  $("sk-title").textContent = mode === "delegate" ? "Stake NXRL" : "Unstake NXRL";
  $("sk-sub").textContent = mode === "delegate"
    ? `Rewards accrue every block. Unstaking later takes ${unbondDays} days.`
    : `Unstaked NXRL is locked for ${unbondDays} days and earns no rewards in that time.`;
  $("sk-val").textContent = name; $("sk-com").textContent = v ? (Number(v.commission.commission_rates.rate) * 100).toFixed(0) + "%" : "—";
  $("sk-avail-k").textContent = mode === "delegate" ? "Available" : "Currently staked";
  $("sk-avail").textContent = fmtU(stakeCtx.avail) + " NXRL";
  const share = v && totalPower ? Number(v.tokens) / totalPower * 100 : 0;
  $("sk-warn").textContent = mode === "delegate" && share > 10 ? `Heads up: this validator already holds ${share.toFixed(1)}% of voting power. Spreading stake across smaller validators keeps NexaRail decentralised.` : "";
  $("sk-amount").value = ""; $("sk-fee").textContent = "Fee shown before signing"; $("sk-btn").textContent = "Review"; $("sk-status").className = "status-box";
  openModal("stake-modal");
}
const stakeMsg = amt => ({ typeUrl: stakeCtx.mode === "delegate" ? "/cosmos.staking.v1beta1.MsgDelegate" : "/cosmos.staking.v1beta1.MsgUndelegate",
  value: { delegatorAddress: S.addr, validatorAddress: stakeCtx.op, amount: { denom: DENOM, amount: amt.toString() } } });
$("sk-amount").addEventListener("input", () => { if (stakeCtx){ stakeCtx.fee = null; $("sk-btn").textContent = "Review"; $("sk-fee").textContent = "Fee shown before signing"; } });
$("stake-form").addEventListener("submit", async e => {
  e.preventDefault(); const st = $("sk-status"), btn = $("sk-btn"); st.className = "status-box";
  try {
    const amt = parseAmount($("sk-amount").value);
    if (amt > stakeCtx.avail) throw new Error(`Maximum is ${fmtU(stakeCtx.avail)} NXRL.`);
    btn.disabled = true;
    if (!stakeCtx.fee || stakeCtx.amt !== amt){
      btn.textContent = "Estimating…"; const fee = await estimateFee([stakeMsg(amt)]);
      if (stakeCtx.mode === "delegate" && amt + feeU(fee) > S.balance) throw new Error("Leave a little NXRL for the network fee — try MAX.");
      Object.assign(stakeCtx, { fee, amt }); $("sk-fee").textContent = `Network fee ${fmtU(feeU(fee))} NXRL`; btn.textContent = "Confirm & sign"; return;
    }
    btn.textContent = "Signing…"; st.className = "status-box pending"; st.textContent = S.isLocal ? "Broadcasting…" : "Approve in your wallet…";
    await broadcast([stakeMsg(amt)], stakeCtx.fee); closeModal("stake-modal");
  } catch (err){ st.className = "status-box bad"; st.textContent = niceErr(err); btn.textContent = stakeCtx?.fee ? "Confirm & sign" : "Review"; }
  finally { btn.disabled = false; }
});
async function stakeMax(){
  if (!stakeCtx) return;
  const v = stakeCtx.mode === "delegate" ? stakeCtx.avail - (await sendReserve()) * 2n : stakeCtx.avail;
  $("sk-amount").value = v > 0n ? uToInput(v) : "0"; $("sk-amount").dispatchEvent(new Event("input"));
}

// ---------- claim rewards ----------
let claimCtx = null;
async function openClaim(){
  const ops = delegations.filter(d => (rewardsByOp[d.op] || 0n) > 0n).map(d => d.op);
  if (!ops.length){ toast("No rewards to claim yet."); return; }
  const msgs = ops.map(op => ({ typeUrl: "/cosmos.distribution.v1beta1.MsgWithdrawDelegatorReward", value: { delegatorAddress: S.addr, validatorAddress: op } }));
  claimCtx = { msgs, fee: null };
  $("cl-amt").textContent = fmtU(totalRewards) + " NXRL"; $("cl-n").textContent = ops.length; $("cl-fee").textContent = "estimating…";
  $("cl-btn").disabled = true; $("cl-status").className = "status-box"; openModal("claim-modal");
  try { claimCtx.fee = await estimateFee(msgs); $("cl-fee").textContent = fmtU(feeU(claimCtx.fee)) + " NXRL"; $("cl-btn").disabled = false;
    if (feeU(claimCtx.fee) >= totalRewards) $("cl-fee").textContent += " (more than the rewards!)"; }
  catch (e){ $("cl-fee").textContent = "—"; $("cl-status").className = "status-box bad"; $("cl-status").textContent = niceErr(e); }
}
async function confirmClaim(){
  const st = $("cl-status"), btn = $("cl-btn"); if (!claimCtx?.fee) return;
  try { btn.disabled = true; st.className = "status-box pending"; st.textContent = S.isLocal ? "Broadcasting…" : "Approve in your wallet…";
    await broadcast(claimCtx.msgs, claimCtx.fee); closeModal("claim-modal"); }
  catch (e){ st.className = "status-box bad"; st.textContent = niceErr(e); btn.disabled = false; }
}

// ---------- activity ----------
const T = m => (m?.["@type"] || "").split(".").pop();
function classify(tx, me){
  const msgs = tx.tx?.body?.messages || [], m = msgs[0] || {}, t = T(m), failed = tx.code !== 0;
  const events = (tx.logs || []).flatMap(l => l.events || []);
  const attrSum = (type, key, filterKey, filterVal) => events.filter(e => e.type === type).reduce((acc, e) => {
    const at = Object.fromEntries((e.attributes || []).map(a => [a.key, a.value]));
    if (filterKey && at[filterKey] !== filterVal) return acc;
    return acc + (String(at[key] || "").split(",").map(c => c.match(/^(\d+)unxrl$/)).filter(Boolean).reduce((s, x) => s + BigInt(x[1]), 0n));
  }, 0n);
  const amt = c => big((Array.isArray(c) ? c : [c]).find(x => x?.denom === DENOM)?.amount);
  const mon = op => valByOp[op]?.description.moniker || short(op);
  let r;
  if (t === "MsgSend") r = m.from_address === me ? { kind: "out", label: "Sent", who: m.to_address, amount: amt(m.amount), sign: "-" } : { kind: "in", label: "Received", who: m.from_address, amount: amt(m.amount), sign: "+" };
  else if (t === "MsgMultiSend") r = { kind: "in", label: "Received", who: m.inputs?.[0]?.address, amount: amt((m.outputs || []).find(o => o.address === me)?.coins), sign: "+" };
  else if (t === "MsgDelegate") r = { kind: "stake", label: "Staked", who: mon(m.validator_address), amount: amt(m.amount), sign: "" };
  else if (t === "MsgUndelegate") r = { kind: "stake", label: "Unstaked", who: mon(m.validator_address), amount: amt(m.amount), sign: "" };
  else if (t === "MsgBeginRedelegate") r = { kind: "stake", label: "Redelegated", who: mon(m.validator_dst_address), amount: amt(m.amount), sign: "" };
  else if (t === "MsgWithdrawDelegatorReward") r = { kind: "reward", label: "Claimed rewards", who: msgs.length > 1 ? `${msgs.length} validators` : mon(m.validator_address), amount: attrSum("withdraw_rewards", "amount", "delegator", me), sign: "+" };
  else r = { kind: "other", label: t.replace(/^Msg/, "") || "Transaction", who: "", amount: null, sign: "" };
  return { ...r, failed, hash: tx.txhash, height: tx.height, time: new Date(tx.timestamp).getTime() };
}
const ICONS = {
  out: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 19V5M5 12l7-7 7 7"/></svg>',
  in: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 5v14M5 12l7 7 7-7"/></svg>',
  stake: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 2l9 5-9 5-9-5 9-5z"/></svg>',
  reward: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6"/></svg>',
  other: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="3"/></svg>' };
function renderTxTable(rows){
  if (!rows.length) return '<div class="empty">No transactions yet. Your sends, receives and staking will show up here.</div>';
  return `<table class="tx-table"><thead><tr><th>Type</th><th class="hide-sm">Details</th><th class="r">Amount</th><th class="r">When</th></tr></thead><tbody>` +
    rows.map(t => `<tr><td><span class="tx-dir"><span class="tx-icon ${t.kind}">${ICONS[t.kind]}</span>${esc(t.label)}${t.failed ? ' <span class="pill warn">FAILED</span>' : ""}</span></td><td class="tx-cp hide-sm" title="${esc(t.who)}">${esc(t.who && t.who.startsWith(PREFIX + "1") ? short(t.who) : t.who)}</td><td class="r tx-amt ${t.kind}">${t.amount === null ? "—" : esc(t.sign + fmtU(t.amount, 4)) + " NXRL"}</td><td class="r tx-h"><a class="xl" href="${txLink(t.hash)}" target="_blank" rel="noopener" title="${esc(new Date(t.time).toLocaleString())} · block ${esc(t.height)}">${ago(t.time)} ago ↗</a></td></tr>`).join("") + "</tbody></table>";
}
async function loadActivity(){
  const me = S.addr; if (!me) return;
  const q = ev => rest(`/cosmos/tx/v1beta1/txs?events=${encodeURIComponent(ev)}&order_by=2&pagination.limit=25`).then(d => d.tx_responses || []);
  try {
    const [s, r] = await Promise.all([q(`message.sender='${me}'`), q(`transfer.recipient='${me}'`)]);
    if (me !== S.addr) return;
    const by = new Map(); [...s, ...r].forEach(t => by.set(t.txhash, t));
    const rows = [...by.values()].map(t => classify(t, me)).sort((a, b) => Number(b.height) - Number(a.height));
    $("activity-list-preview").innerHTML = renderTxTable(rows.slice(0, 5));
    $("activity-list-send").innerHTML = renderTxTable(rows.filter(t => t.kind === "in" || t.kind === "out").slice(0, 5));
    $("activity-list-full").innerHTML = renderTxTable(rows.slice(0, 40));
  } catch { ["activity-list-preview", "activity-list-send", "activity-list-full"].forEach(id => $(id).innerHTML = '<div class="empty">Activity unavailable right now — retrying shortly.</div>'); setTimeout(loadActivity, 15000); }
}

// =====================================================================
// CONNECT / CREATE / IMPORT
// =====================================================================
async function connectExtension(key, silent = false){
  const err = $("connect-error"); err.className = "status-box"; const w = WALLETS[key], p = w.get();
  if (!p){ if (!silent){ err.className = "status-box bad"; err.textContent = `${w.name} extension not detected. Install it, then reload this page.`; } return; }
  try {
    await lib();
    if (!silent) await p.experimentalSuggestChain(chainInfo);
    await p.enable(CHAIN_ID);
    const s = p.getOfflineSigner(CHAIN_ID), a = await s.getAccounts();
    await activateSigner(s, a[0].address, w.name, { ext: key }); store.set(EXT_KEY, key);
  } catch (e){ if (!silent){ err.className = "status-box bad"; err.textContent = "Connection failed: " + niceErr(e); } }
}
window.addEventListener("keplr_keystorechange", () => { if (S.ext) connectExtension(S.ext, true); });

let newWallet = null, verifyIdx = [];
async function createWallet(){
  const btn = document.querySelector("[data-act=create]"); btn.disabled = true; btn.textContent = "Generating…";
  try {
    const { DirectSecp256k1HdWallet } = await lib();
    newWallet = await DirectSecp256k1HdWallet.generate(24, { prefix: PREFIX });
    $("mnemonic-grid").innerHTML = newWallet.mnemonic.split(" ").map((x, i) => `<div class="mnemonic-word"><span class="n">${i + 1}</span>${esc(x)}</div>`).join("");
    $("mnemonic-confirm").checked = false; $("mnemonic-continue").disabled = true;
    $("mm-step-show").style.display = ""; $("mm-step-verify").style.display = "none"; openModal("mnemonic-modal");
  } catch (e){ const err = $("connect-error"); err.className = "status-box bad"; err.textContent = niceErr(e); }
  finally { btn.disabled = false; btn.textContent = "Create wallet"; }
}
function mnemonicNext(){
  const pool = [...Array(24).keys()], r = crypto.getRandomValues(new Uint32Array(3));
  verifyIdx = [...r].map(x => pool.splice(x % pool.length, 1)[0]).sort((a, b) => a - b);
  $("verify-grid").innerHTML = verifyIdx.map(i => `<div><label for="vw-${i}">Word #${i + 1}</label><input type="text" id="vw-${i}" autocomplete="off" autocapitalize="off" spellcheck="false"></div>`).join("");
  $("verify-error").className = "status-box";
  $("mm-step-show").style.display = "none"; $("mm-step-verify").style.display = ""; $(`vw-${verifyIdx[0]}`).focus();
}
$("mm-step-verify").addEventListener("submit", async e => {
  e.preventDefault(); const words = newWallet.mnemonic.split(" ");
  if (!verifyIdx.every(i => $(`vw-${i}`).value.trim().toLowerCase() === words[i])){
    const er = $("verify-error"); er.className = "status-box bad"; er.textContent = "Those words don't match. Check your written copy, or tap “Show again”."; return; }
  const w = newWallet; newWallet = null; clearMnemonicUI(); closeModal("mnemonic-modal", true);
  try { const a = await w.getAccounts(); await activateSigner(w, a[0].address, "Local wallet", { isLocal: true });
    toast("Wallet created. Tip: save it to this device so you don't need the phrase each visit.", "ok", 7000); }
  catch (err){ const ce = $("connect-error"); ce.className = "status-box bad"; ce.textContent = "Could not connect to the network: " + niceErr(err); }
});
function clearMnemonicUI(){ $("mnemonic-grid").innerHTML = ""; $("verify-grid").innerHTML = ""; }

let seedLength = 12;
function setSeedLength(n){ seedLength = n; document.querySelectorAll(".seed-toggle button").forEach(b => b.classList.toggle("active", Number(b.dataset.arg) === n)); renderSeedGrid(); }
function renderSeedGrid(){
  const grid = $("seed-grid"), existing = Array.from(grid.querySelectorAll("input")).map(i => i.value); grid.innerHTML = "";
  for (let i = 0; i < seedLength; i++){
    const box = document.createElement("div"); box.className = "seed-box";
    const n = document.createElement("span"); n.className = "n"; n.textContent = i + 1;
    const inp = document.createElement("input"); Object.assign(inp, { type: "password", autocomplete: "off", autocapitalize: "off", spellcheck: false, value: existing[i] || "" });
    inp.setAttribute("aria-label", `Word ${i + 1}`);
    inp.addEventListener("focus", () => inp.type = "text"); inp.addEventListener("blur", () => inp.type = "password");
    box.append(n, inp); grid.append(box);
  }
  const inputs = Array.from(grid.querySelectorAll("input"));
  inputs.forEach((input, i) => {
    input.addEventListener("paste", e => { const words = (e.clipboardData || window.clipboardData).getData("text").trim().split(/\s+/);
      if (words.length > 1){ e.preventDefault();
        if (i === 0 && (words.length === 12 || words.length === 24) && words.length !== seedLength){ setSeedLength(words.length); return fillSeed(words); }
        fillSeed(words, i); } });
    input.addEventListener("keydown", e => { if (e.key === " " || e.key === "Enter"){ e.preventDefault(); inputs[i + 1]?.focus(); if (e.key === "Enter" && !inputs[i + 1]) importWallet(); }
      else if (e.key === "Backspace" && !input.value) inputs[i - 1]?.focus(); });
  });
}
function fillSeed(words, start = 0){ const inputs = Array.from($("seed-grid").querySelectorAll("input"));
  words.forEach((w, j) => { if (inputs[start + j]) inputs[start + j].value = w.toLowerCase(); }); inputs[Math.min(start + words.length, inputs.length - 1)].focus(); }
async function importWallet(){
  const err = $("import-error"); err.className = "status-box";
  const inputs = Array.from(document.querySelectorAll("#seed-grid input")), words = inputs.map(i => i.value.trim().toLowerCase());
  try {
    if (words.some(w => !w)) throw new Error(`Fill in all ${seedLength} words`);
    const { DirectSecp256k1HdWallet } = await lib();
    const w = await DirectSecp256k1HdWallet.fromMnemonic(words.join(" "), { prefix: PREFIX }).catch(() => { throw new Error("That phrase isn't valid — check each word's spelling and order."); });
    const a = await w.getAccounts(); inputs.forEach(i => i.value = "");
    await activateSigner(w, a[0].address, "Local wallet", { isLocal: true });
  } catch (e){ err.className = "status-box bad"; err.textContent = niceErr(e); }
}

// =====================================================================
// ENCRYPTED DEVICE VAULT (AES-256-GCM, PBKDF2-SHA256)
// =====================================================================
const b64 = b => btoa(String.fromCharCode(...b)), unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
async function deriveKey(pass, salt, iterations){
  const km = await crypto.subtle.importKey("raw", new TextEncoder().encode(pass), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", salt, iterations, hash: "SHA-256" }, km, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}
function readVault(){ try { return JSON.parse(store.get(VAULT_KEY) || "null"); } catch { return null; } }
async function writeVault(mnemonic, pass, addr){
  const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(pass, salt, KDF_ITER);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(mnemonic));
  if (!store.set(VAULT_KEY, JSON.stringify({ v: 2, kdf: "PBKDF2-SHA256", iter: KDF_ITER, salt: b64(salt), iv: b64(iv), data: b64(new Uint8Array(ct)), addr })))
    throw new Error("This browser blocked local storage (private mode?)");
}
function pwScore(p){ let s = 0; if (p.length >= MIN_PASS) s++; if (p.length >= 14) s++; if (/[a-z]/.test(p) && /[A-Z]/.test(p)) s++; if (/\d/.test(p)) s++; if (/[^A-Za-z0-9]/.test(p)) s++; return s; }
$("save-passphrase").addEventListener("input", e => { const s = pwScore(e.target.value), m = $("pw-meter");
  m.style.width = (s / 5 * 100) + "%"; m.style.background = s < 2 ? "var(--red)" : s < 4 ? "#f59e0b" : "var(--green)"; });
$("save-device-form").addEventListener("submit", async e => {
  e.preventDefault(); const err = $("save-device-error"), p1 = $("save-passphrase").value, p2 = $("save-passphrase2").value; err.className = "status-box";
  try {
    if (p1.length < MIN_PASS) throw new Error(`Use at least ${MIN_PASS} characters.`);
    if (p1 !== p2) throw new Error("Passphrases don't match.");
    if (!S.signer?.mnemonic) throw new Error("Only locally created or imported wallets can be saved.");
    err.className = "status-box pending"; err.textContent = "Encrypting…";
    await writeVault(S.signer.mnemonic, p1, S.addr);
    closeModal("save-device-modal"); $("save-device-link").textContent = "Saved to this device ✓"; $("save-device-link").disabled = true; toast("Saved. Next time just unlock with your passphrase.", "ok");
  } catch (x){ err.className = "status-box bad"; err.textContent = x.message; }
});
$("unlock-form").addEventListener("submit", async e => {
  e.preventDefault(); const err = $("unlock-error"), pass = $("unlock-passphrase").value, btn = $("unlock-btn"); err.className = "status-box";
  btn.disabled = true; btn.textContent = "Unlocking…";
  try {
    const v = readVault(); if (!v) throw new Error("No saved wallet");
    let mnemonic;
    try { const key = await deriveKey(pass, unb64(v.salt), v.iter || KDF_ITER_V1);
      mnemonic = new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(v.iv) }, key, unb64(v.data))); }
    catch { throw new Error("Wrong passphrase."); }
    const { DirectSecp256k1HdWallet } = await lib();
    const w = await DirectSecp256k1HdWallet.fromMnemonic(mnemonic, { prefix: PREFIX }), a = await w.getAccounts();
    if (!v.v || v.iter !== KDF_ITER || !v.addr) await writeVault(mnemonic, pass, a[0].address).catch(() => {});   // upgrade legacy vaults in place
    $("unlock-passphrase").value = ""; closeModal("unlock-modal");
    await activateSigner(w, a[0].address, "Local wallet", { isLocal: true });
  } catch (x){ err.className = "status-box bad"; err.textContent = x.message; }
  finally { btn.disabled = false; btn.textContent = "Unlock"; }
});
function checkSavedWallet(){ const v = readVault(); $("saved-wallet-row").style.display = v ? "block" : "none"; $("saved-wallet-addr").textContent = v?.addr ? short(v.addr) : "on this device"; }
function forgetDevice(){ if (confirm("Remove the encrypted wallet saved in this browser? Make sure you have your recovery phrase written down elsewhere.")){ store.del(VAULT_KEY); closeModal("unlock-modal"); checkSavedWallet(); toast("Saved wallet removed from this browser."); } }

// auto-lock local wallets when idle
let lastActivity = Date.now();
["pointerdown", "keydown"].forEach(t => addEventListener(t, () => { lastActivity = Date.now(); }, { passive: true }));
setInterval(() => { if (S.isLocal && Date.now() - lastActivity > AUTOLOCK_MS) disconnect("Wallet locked after 15 minutes of inactivity."); }, 30000);

// =====================================================================
// NAV, MODALS, EVENT WIRING
// =====================================================================
const VIEWS = ["overview", "receive", "send", "staking", "activity", "network"], NEEDS_WALLET = ["receive", "send", "staking", "activity"];
function go(nav){ const h = "#/" + nav; if (location.hash !== h) location.hash = h; else route(); }
function route(){
  let nav = (location.hash.match(/^#\/(\w+)/) || [])[1] || "overview";
  if (!VIEWS.includes(nav)) nav = "overview";
  if (NEEDS_WALLET.includes(nav) && !S.addr){ nav = "overview"; if (location.hash.length > 2 && !location.hash.startsWith("#/overview")) history.replaceState(null, "", "#/overview"); }
  document.querySelectorAll("[data-nav]").forEach(t => t.classList.toggle("active", t.dataset.nav === nav && (t.classList.contains("navitem") || !!t.closest(".bottomnav"))));
  VIEWS.forEach(n => $("view-" + n).style.display = n === nav ? "block" : "none");
  $("view-" + nav).querySelectorAll(".rise").forEach(c => { c.style.animationName = "none"; void c.offsetWidth; c.style.animationName = ""; });   // keeps each card's stagger delay
  if (nav === "send") cancelReview();
  if (nav === "activity") loadActivity();
  if (nav === "staking") refreshAccount();
  window.scrollTo({ top: 0 });
}
addEventListener("hashchange", route);

let lastFocus = null;
function openModal(id){ lastFocus = document.activeElement; const m = $(id); m.classList.add("show");
  setTimeout(() => (m.querySelector("input:not([type=checkbox])") || m.querySelector("button.primary:not(:disabled)") || m.querySelector("button"))?.focus(), 30); }
function closeModal(id, force){ const m = $(id); if (m.hasAttribute("data-sticky") && !force) return; m.classList.remove("show"); lastFocus?.focus?.(); }
document.addEventListener("keydown", e => {
  if (e.key === "Escape"){ const m = [...document.querySelectorAll(".modal-backdrop.show")].pop(); if (m) closeModal(m.id); }
  if ((e.key === "Enter" || e.key === " ") && e.target.matches(".val.click")){ e.preventDefault(); e.target.click(); }
});
document.querySelectorAll(".modal-backdrop").forEach(m => m.addEventListener("mousedown", e => { if (e.target === m) closeModal(m.id); }));

const ACTIONS = {
  "connect": k => connectExtension(k), "create": createWallet, "import": importWallet, "seedlen": n => setSeedLength(Number(n)),
  "mnemonic-next": mnemonicNext, "mnemonic-back": () => { $("mm-step-show").style.display = ""; $("mm-step-verify").style.display = "none"; },
  "mnemonic-cancel": () => { newWallet = null; clearMnemonicUI(); closeModal("mnemonic-modal", true); },
  "disconnect": () => disconnect(), "copy-address": () => { if (S.addr) navigator.clipboard.writeText(S.addr).then(() => toast("Address copied", "ok", 2000), () => toast("Couldn't access clipboard", "bad")); },
  "open-save": () => { ["save-passphrase", "save-passphrase2"].forEach(id => $(id).value = ""); $("pw-meter").style.width = "0"; $("save-device-error").className = "status-box"; openModal("save-device-modal"); },
  "open-unlock": () => { $("unlock-error").className = "status-box"; $("unlock-passphrase").value = ""; openModal("unlock-modal"); },
  "forget-device": forgetDevice, "close-modal": id => closeModal(id),
  "send-max": async () => { const r = await sendReserve(), v = S.balance - r; $("send-amount").value = v > 0n ? uToInput(v) : "0"; },
  "send-back": cancelReview, "send-confirm": confirmSend,
  "stake-open": op => openStake(op, "delegate"), "unstake-open": op => openStake(op, "undelegate"), "stake-max": stakeMax,
  "claim-all": openClaim, "claim-confirm": confirmClaim,
};
document.addEventListener("click", e => {
  const nav = e.target.closest("[data-nav]");
  if (nav){ e.preventDefault(); if (NEEDS_WALLET.includes(nav.dataset.nav) && !S.addr){ go("overview"); switchTab("create"); toast("Create, import or connect a wallet to use " + nav.dataset.nav + "."); return; } go(nav.dataset.nav); return; }
  const tab = e.target.closest("[data-tab]"); if (tab) return switchTab(tab.dataset.tab);
  const a = e.target.closest("[data-act]"); if (a && ACTIONS[a.dataset.act]){ e.preventDefault(); ACTIONS[a.dataset.act](a.dataset.arg, a); }
});
function switchTab(tab){ document.querySelectorAll(".tab").forEach(t => { const on = t.dataset.tab === tab; t.classList.toggle("active", on); t.setAttribute("aria-selected", on); });
  ["connect", "create", "import"].forEach(p => $("panel-" + p).style.display = p === tab ? "block" : "none"); }
$("mnemonic-confirm").addEventListener("change", e => { $("mnemonic-continue").disabled = !e.target.checked; });
$("val-search").addEventListener("input", renderValidators);

// =====================================================================
// BOOT
// =====================================================================
renderSeedGrid(); checkSavedWallet(); route();
syncStatus().catch(() => { rpcDown = true; updateHealth(); }).finally(openWS);
refreshValidators(); setInterval(refreshValidators, 60000);
refreshNetwork(); setInterval(refreshNetwork, 60000);
// Extensions inject after load; reconnect silently if the user connected one before.
addEventListener("load", () => setTimeout(() => { const k = store.get(EXT_KEY); if (k && WALLETS[k] && !S.addr) connectExtension(k, true); }, 400));
// Warm the wallet bundle in the background once the dashboard is idle, so Create/Import feel instant.
(window.requestIdleCallback || (f => setTimeout(f, 3000)))(() => { if (navigator.connection?.saveData !== true) lib().catch(() => {}); });
