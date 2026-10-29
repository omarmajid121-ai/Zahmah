import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure';
import { SimplePool } from 'nostr-tools/pool';
import geohash from 'ngeohash';

/* ---------- config ---------- */
const RELAYS = ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net', 'wss://relay.nostr.band'];
const K_PRESENCE = 21210;      // ephemeral: relays forward, never store
const K_VOICE = 21211;
const APP_TAG = 'zahmah-v1';
const PRESENCE_EVERY = 8000;
const PEER_TTL = 25000;
const MAX_TALK_MS = 15000;
const CHUNK = 24000;           // base64 chars per event

/* ---------- small helpers ---------- */
const $ = (s) => document.querySelector(s);
const ls = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }
};
const hex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('');
const unhex = (h) => new Uint8Array(h.match(/.{2}/g).map((x) => parseInt(x, 16)));
const toAr = (n) => String(n).replace(/\d/g, (d) => '٠١٢٣٤٥٦٧٨٩'[d]);
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

function codeFromPub(pub) {
  const n = parseInt(pub.slice(0, 8), 16) % 10000;
  return 'Z-' + String(n).padStart(4, '0');
}
async function sha(text) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return hex(new Uint8Array(d)).slice(0, 24);
}
function blobToB64(blob) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(',')[1]);
    r.onerror = rej;
    r.readAsDataURL(blob);
  });
}
function b64ToBuf(b64) {
  const bin = atob(b64); const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u.buffer;
}
let toastT;
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 2200);
}

/* ---------- identity ---------- */
let skHex = ls.get('zh_sk', null);
if (!skHex) { skHex = hex(generateSecretKey()); ls.set('zh_sk', skHex); }
let sk = unhex(skHex);
let pub = getPublicKey(sk);
let myCode = codeFromPub(pub);

/* ---------- state ---------- */
const S = {
  online: false,
  mode: ls.get('zh_mode', 'near'),          // near | room
  room: ls.get('zh_room', ''),
  cells: [],                                 // channel ids we listen to
  myCell: null,                              // channel id we publish to
  peers: new Map(),                          // pubkey -> {code, seen}
  blocked: new Set(ls.get('zh_blocked', [])),
  muted: new Set(),
  talking: false,
  playing: null,                             // {pub, code}
  geoOk: false
};

const pool = new SimplePool();
let sub = null;
let presenceTimer = null;
let geoWatch = null;
let stream = null;
let recorder = null;
let recChunks = [];
let recStart = 0;
let recTimer = null;
let audioCtx = null;
const inbound = new Map();   // msgId -> {parts:[], total, mime, pub, code, at}
const playQueue = [];

/* ---------- audio ---------- */
function unlockAudio() {
  if (!audioCtx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    audioCtx = new AC();
  }
  if (audioCtx.state === 'suspended') audioCtx.resume();
  const b = audioCtx.createBuffer(1, 1, 22050);
  const s = audioCtx.createBufferSource(); s.buffer = b; s.connect(audioCtx.destination); s.start(0);
}
function pickMime() {
  const opts = ['audio/mp4', 'audio/aac', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];
  if (!window.MediaRecorder) return '';
  return opts.find((m) => MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(m)) || '';
}
async function ensureMic() {
  if (stream && stream.active) return true;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    return true;
  } catch {
    toast('اسمح للتطبيق باستخدام المايك من الإعدادات');
    return false;
  }
}
function releaseMic() {
  if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
}

async function startTalk() {
  if (!S.online || S.talking) return;
  if (S.playing) { toast('انتظر حتى ينتهي ' + S.playing.code); return; }
  unlockAudio();
  if (!(await ensureMic())) return;
  const mime = pickMime();
  try {
    recorder = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 32000 } : { audioBitsPerSecond: 32000 });
  } catch {
    recorder = new MediaRecorder(stream);
  }
  recChunks = [];
  recorder.ondataavailable = (e) => { if (e.data && e.data.size) recChunks.push(e.data); };
  recorder.onstop = sendClip;
  recorder.start();
  recStart = Date.now();
  S.talking = true;
  if (navigator.vibrate) navigator.vibrate(15);
  render();
  recTimer = setInterval(() => {
    const ms = Date.now() - recStart;
    $('#talkTimer').textContent = toAr(Math.floor(ms / 1000)) + ' / ' + toAr(MAX_TALK_MS / 1000) + ' ث';
    if (ms >= MAX_TALK_MS) stopTalk();
  }, 200);
}
function stopTalk() {
  if (!S.talking) return;
  S.talking = false;
  clearInterval(recTimer);
  try { recorder && recorder.state !== 'inactive' && recorder.stop(); } catch {}
  render();
}
async function sendClip() {
  const dur = Date.now() - recStart;
  if (dur < 500 || !recChunks.length) { toast('اضغط مع الاستمرار وتكلّم'); return; }
  const blob = new Blob(recChunks, { type: recorder.mimeType || 'audio/mp4' });
  const b64 = await blobToB64(blob);
  const id = uid();
  const total = Math.ceil(b64.length / CHUNK);
  $('#talkHint').textContent = 'يتم الإرسال…';
  try {
    for (let i = 0; i < total; i++) {
      const content = JSON.stringify({ id, i, n: total, mime: blob.type, ms: dur, d: b64.slice(i * CHUNK, (i + 1) * CHUNK) });
      const ev = finalizeEvent({ kind: K_VOICE, created_at: Math.floor(Date.now() / 1000), tags: [['t', APP_TAG], ['z', S.myCell]], content }, sk);
      await Promise.any(pool.publish(RELAYS, ev));
    }
    toast(S.mode === 'room' ? 'وصل صوتك للغرفة' : 'وصل صوتك لمن حولك');
  } catch {
    toast('تعذّر الإرسال، تأكد من الإنترنت');
  }
  render();
}

function onVoice(ev) {
  if (ev.pubkey === pub || S.blocked.has(ev.pubkey) || !S.online) return;
  let m; try { m = JSON.parse(ev.content); } catch { return; }
  if (!m || typeof m.id !== 'string' || typeof m.d !== 'string' || !(m.n > 0 && m.n <= 40)) return;
  let rec = inbound.get(m.id);
  if (!rec) { rec = { parts: [], total: m.n, mime: m.mime, pub: ev.pubkey, at: Date.now(), got: 0 }; inbound.set(m.id, rec); }
  if (rec.pub !== ev.pubkey || rec.parts[m.i] !== undefined) return;
  rec.parts[m.i] = m.d; rec.got++;
  touchPeer(ev.pubkey);
  if (rec.got === rec.total) {
    inbound.delete(m.id);
    if (S.muted.has(ev.pubkey)) return;
    playQueue.push({ pub: ev.pubkey, code: codeFromPub(ev.pubkey), data: rec.parts.join(''), mime: rec.mime });
    if (!S.playing) playNext();
  }
  for (const [k, v] of inbound) if (Date.now() - v.at > 60000) inbound.delete(k);
}
async function playNext() {
  const item = playQueue.shift();
  if (!item) { S.playing = null; render(); return; }
  if (S.blocked.has(item.pub) || S.muted.has(item.pub)) { playNext(); return; }
  S.playing = item; render();
  try {
    if (!audioCtx) unlockAudio();
    const buf = await audioCtx.decodeAudioData(b64ToBuf(item.data));
    const src = audioCtx.createBufferSource(); src.buffer = buf;
    const an = audioCtx.createAnalyser(); an.fftSize = 64;
    src.connect(an); an.connect(audioCtx.destination);
    S.currentSrc = src;
    animateWave(an);
    src.onended = () => { S.currentSrc = null; setTimeout(playNext, 250); };
    src.start(0);
  } catch {
    // fallback: <audio>
    try {
      const a = new Audio('data:' + (item.mime || 'audio/mp4') + ';base64,' + item.data);
      a.onended = () => setTimeout(playNext, 250);
      a.onerror = () => playNext();
      await a.play();
    } catch { playNext(); }
  }
}
function animateWave(an) {
  const bars = document.querySelectorAll('#wave span');
  const data = new Uint8Array(an.frequencyBinCount);
  const tick = () => {
    if (!S.playing) return;
    an.getByteFrequencyData(data);
    bars.forEach((b, i) => { const v = data[(i * 2) % data.length] / 255; b.style.height = (6 + v * 46) + 'px'; });
    requestAnimationFrame(tick);
  };
  tick();
}

/* ---------- presence ---------- */
function touchPeer(p) {
  const prev = S.peers.get(p);
  S.peers.set(p, { code: codeFromPub(p), seen: Date.now() });
  if (!prev) render();
}
function onPresence(ev) {
  if (ev.pubkey === pub || S.blocked.has(ev.pubkey)) return;
  let m; try { m = JSON.parse(ev.content); } catch { m = {}; }
  if (m && m.off) { S.peers.delete(ev.pubkey); render(); return; }
  touchPeer(ev.pubkey);
}
async function sendPresence(off) {
  if (!S.myCell) return;
  const ev = finalizeEvent({ kind: K_PRESENCE, created_at: Math.floor(Date.now() / 1000), tags: [['t', APP_TAG], ['z', S.myCell]], content: JSON.stringify(off ? { off: 1 } : { on: 1 }) }, sk);
  try { await Promise.any(pool.publish(RELAYS, ev)); } catch {}
}
function prunePeers() {
  let changed = false;
  for (const [k, v] of S.peers) if (Date.now() - v.seen > PEER_TTL) { S.peers.delete(k); changed = true; }
  if (changed) render();
}

/* ---------- channel ---------- */
async function computeChannel() {
  if (S.mode === 'room') {
    const r = S.room.trim().toLowerCase();
    if (!r) return false;
    const id = 'room:' + (await sha('zahmah-room:' + r));
    S.myCell = id; S.cells = [id];
    return true;
  }
  const pos = await getPosition();
  if (!pos) return false;
  const cell = geohash.encode(pos.coords.latitude, pos.coords.longitude, 6);
  S.myCell = 'g:' + cell;
  S.cells = [cell, ...geohash.neighbors(cell)].map((c) => 'g:' + c);
  return true;
}
function getPosition() {
  return new Promise((res) => {
    if (!navigator.geolocation) { toast('الموقع غير متاح على هذا الجهاز'); return res(null); }
    navigator.geolocation.getCurrentPosition(
      (p) => { S.geoOk = true; res(p); },
      () => { toast('اسمح بالموقع لتسمع من حولك، أو استخدم غرفة خاصة'); res(null); },
      { enableHighAccuracy: false, timeout: 15000, maximumAge: 60000 }
    );
  });
}
function subscribe() {
  if (sub) { try { sub.close(); } catch {} sub = null; }
  sub = pool.subscribeMany(RELAYS, { kinds: [K_PRESENCE, K_VOICE], '#t': [APP_TAG], '#z': S.cells, since: Math.floor(Date.now() / 1000) - 5 }, {
    onevent(ev) {
      if (Math.abs(Date.now() / 1000 - ev.created_at) > 120) return;
      if (ev.kind === K_PRESENCE) onPresence(ev); else if (ev.kind === K_VOICE) onVoice(ev);
    }
  });
}

async function goOnline() {
  unlockAudio();
  $('#statusSub').textContent = 'جارٍ الاتصال…';
  const ok = await computeChannel();
  if (!ok) { S.online = false; render(); return; }
  S.online = true;
  S.peers.clear();
  subscribe();
  sendPresence();
  clearInterval(presenceTimer);
  presenceTimer = setInterval(() => { sendPresence(); prunePeers(); }, PRESENCE_EVERY);
  if (S.mode === 'near' && navigator.geolocation && geoWatch === null) {
    geoWatch = navigator.geolocation.watchPosition((p) => {
      const cell = 'g:' + geohash.encode(p.coords.latitude, p.coords.longitude, 6);
      if (cell !== S.myCell && S.online && S.mode === 'near') { computeChannel().then(() => { S.peers.clear(); subscribe(); sendPresence(); render(); }); }
    }, () => {}, { enableHighAccuracy: false, maximumAge: 60000 });
  }
  render();
}
function goOffline() {
  sendPresence(true);
  S.online = false;
  clearInterval(presenceTimer);
  if (sub) { try { sub.close(); } catch {} sub = null; }
  if (geoWatch !== null) { navigator.geolocation.clearWatch(geoWatch); geoWatch = null; }
  S.peers.clear(); playQueue.length = 0;
  if (S.currentSrc) { try { S.currentSrc.stop(); } catch {} }
  S.playing = null;
  releaseMic();
  render();
}

/* ---------- render ---------- */
function render() {
  const n = S.online ? S.peers.size : 0;
  document.body.dataset.online = S.online ? '1' : '0';
  document.body.dataset.talking = S.talking ? '1' : '0';
  document.body.dataset.mode = S.mode;
  $('#myCode').textContent = myCode;
  $('#myCodeBig').textContent = myCode;
  $('#count').textContent = S.online ? String(n) : '—';
  $('#countLabel').textContent = S.online ? (S.mode === 'room' ? 'في الغرفة معك' : 'قريبون منك · ~١ كم') : 'غير متاح';
  $('#statusTitle').textContent = S.online ? 'متاح' : 'غير متاح';
  $('#statusSub').textContent = S.online ? (S.mode === 'room' ? 'غرفة: ' + S.room : 'يسمعك من حولك برمزك فقط') : 'فعّل لتسمع وتُسمَع';
  $('#sw').setAttribute('aria-checked', S.online ? 'true' : 'false');
  $('#segNear').setAttribute('aria-checked', S.mode === 'near' ? 'true' : 'false');
  $('#segRoom').setAttribute('aria-checked', S.mode === 'room' ? 'true' : 'false');
  $('#talkLabel').textContent = !S.online ? 'فعّل الإتاحة للتحدث' : (S.talking ? 'على الهواء — اترك للإرسال' : 'اضغط مع الاستمرار للتحدث');
  if (!S.talking) $('#talkTimer').textContent = '';
  $('#talkHint').textContent = '';

  // dots
  const dots = $('#dots'); dots.innerHTML = '';
  let i = 0;
  for (const [, p] of S.peers) {
    if (i >= 24) break;
    const a = (i * 137.5) * Math.PI / 180, r = 40 + (i % 3) * 30;
    const d = document.createElement('span');
    d.className = 'dot';
    d.style.left = (50 + Math.cos(a) * r / 2.2) + '%';
    d.style.top = (50 + Math.sin(a) * r / 2.2) + '%';
    d.title = p.code;
    dots.appendChild(d); i++;
  }

  // incoming
  const inc = $('#incoming');
  if (S.playing) {
    inc.hidden = false;
    $('#incCode').textContent = S.playing.code;
  } else inc.hidden = true;

  // settings
  $('#blockedCount').textContent = toAr(S.blocked.size);
}

/* ---------- events ---------- */
function bind() {
  $('#startBtn').addEventListener('click', () => {
    unlockAudio(); ls.set('zh_seen', 1);
    $('#onboard').hidden = true;
    goOnline();
  });
  $('#sw').addEventListener('click', () => { S.online ? goOffline() : goOnline(); });

  const setMode = async (m) => {
    if (m === 'room' && !S.room) { openRoom(); return; }
    S.mode = m; ls.set('zh_mode', m);
    if (S.online) { goOffline(); await goOnline(); } else render();
  };
  $('#segNear').addEventListener('click', () => setMode('near'));
  $('#segRoom').addEventListener('click', () => (S.mode === 'room' ? openRoom() : setMode('room')));

  function openRoom() { $('#roomInput').value = S.room; $('#roomSheet').hidden = false; setTimeout(() => $('#roomInput').focus(), 50); }
  $('#roomCancel').addEventListener('click', () => { $('#roomSheet').hidden = true; });
  $('#roomForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = $('#roomInput').value.trim();
    if (v.length < 3) { toast('اكتب اسم غرفة من ٣ أحرف أو أكثر'); return; }
    S.room = v; ls.set('zh_room', v);
    $('#roomSheet').hidden = true;
    S.mode = 'room'; ls.set('zh_mode', 'room');
    if (S.online) goOffline();
    await goOnline();
  });
  $('#shareRoom').addEventListener('click', async () => {
    const v = $('#roomInput').value.trim() || S.room;
    const link = location.origin + location.pathname + '?room=' + encodeURIComponent(v);
    const text = 'تعال كلّمني على زحمة — الغرفة: ' + v + '\n' + link;
    try { if (navigator.share) await navigator.share({ text }); else { await navigator.clipboard.writeText(text); toast('تم النسخ'); } } catch {}
  });

  const btn = $('#talk');
  const down = (e) => { e.preventDefault(); startTalk(); };
  const up = (e) => { e.preventDefault(); stopTalk(); };
  btn.addEventListener('pointerdown', down);
  btn.addEventListener('pointerup', up);
  btn.addEventListener('pointercancel', up);
  btn.addEventListener('pointerleave', up);
  btn.addEventListener('contextmenu', (e) => e.preventDefault());

  $('#muteBtn').addEventListener('click', () => {
    if (!S.playing) return; S.muted.add(S.playing.pub);
    if (S.currentSrc) { try { S.currentSrc.stop(); } catch {} }
    toast('تم كتم ' + S.playing.code + ' لهذه الجلسة');
  });
  $('#blockBtn').addEventListener('click', () => {
    if (!S.playing) return; S.blocked.add(S.playing.pub); ls.set('zh_blocked', [...S.blocked]);
    S.peers.delete(S.playing.pub);
    if (S.currentSrc) { try { S.currentSrc.stop(); } catch {} }
    toast('تم حظر ' + S.playing.code);
  });
  $('#reportBtn').addEventListener('click', () => {
    if (!S.playing) return;
    const reports = ls.get('zh_reports', []); reports.push({ code: S.playing.code, at: Date.now() }); ls.set('zh_reports', reports);
    S.blocked.add(S.playing.pub); ls.set('zh_blocked', [...S.blocked]);
    if (S.currentSrc) { try { S.currentSrc.stop(); } catch {} }
    toast('تم الإبلاغ والحظر');
  });

  $('#openSettings').addEventListener('click', () => { $('#settings').hidden = false; render(); });
  $('#closeSettings').addEventListener('click', () => { $('#settings').hidden = true; });
  $('#clearBlocked').addEventListener('click', () => { S.blocked.clear(); ls.set('zh_blocked', []); toast('تم إلغاء الحظر'); render(); });
  $('#newCode').addEventListener('click', () => {
    if (!confirm('إنشاء رمز جديد؟ سيتغير رمزك فوراً.')) return;
    sk = generateSecretKey(); skHex = hex(sk); ls.set('zh_sk', skHex);
    pub = getPublicKey(sk); myCode = codeFromPub(pub);
    toast('رمزك الجديد ' + myCode); render();
  });

  document.addEventListener('visibilitychange', () => { if (!document.hidden && S.online) { sendPresence(); if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume(); } });
  window.addEventListener('pagehide', () => { if (S.online) sendPresence(true); });
}

/* ---------- boot ---------- */
bind();
render();
if (ls.get('zh_seen', 0)) $('#onboard').hidden = true;
const params = new URLSearchParams(location.search);
if (params.get('room')) { S.room = params.get('room').slice(0, 40); S.mode = 'room'; ls.set('zh_room', S.room); ls.set('zh_mode', 'room'); render(); }
if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
