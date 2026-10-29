import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure';
import { SimplePool } from 'nostr-tools/pool';
import * as nip44 from 'nostr-tools/nip44';
import geohash from 'ngeohash';

/* ================= config ================= */
const qsRelay = new URLSearchParams(location.search).get('relay');
const RELAYS = qsRelay && /^wss?:\/\/localhost/.test(qsRelay) ? [qsRelay]
  : ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net', 'wss://relay.nostr.band'];
const K_PRESENCE = 21210, K_SIGNAL = 21212;          // ephemeral: forwarded live, never stored
const APP_TAG = 'zahmah-v2';
const PRESENCE_EVERY = 7000;
const PEER_TTL = 22000;                               // gone if silent this long
const AWAY_TTL = 300000;                              // phone locked: keep 5 min
const MAX_LINKS = 20;                                 // direct links per phone
const CLEAR_VOICES = 3;                               // voices heard at full clarity
const IDLE_WARN_MS = 50000, IDLE_CLOSE_MS = 60000;    // open mic with no speech
const HOLD_MS = 400;                                  // press longer = hold-to-talk
const HAND_TTL = 120000;
const ICE = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] },
  { urls: ['turn:openrelay.metered.ca:80', 'turn:openrelay.metered.ca:443', 'turn:openrelay.metered.ca:443?transport=tcp'], username: 'openrelayproject', credential: 'openrelayproject' }
];

/* ================= helpers ================= */
const $ = (s) => document.querySelector(s);
const ls = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }
};
const hex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('');
const unhex = (h) => new Uint8Array(h.match(/.{2}/g).map((x) => parseInt(x, 16)));
const now = () => Math.floor(Date.now() / 1000);
const codeFromPub = (p) => 'Z-' + String(parseInt(p.slice(0, 8), 16) % 10000).padStart(4, '0');
async function sha(t) { const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t)); return hex(new Uint8Array(d)).slice(0, 24); }
let toastT;
function toast(m, ms = 2600) { const t = $('#toast'); t.textContent = m; t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), ms); }

/* ================= identity ================= */
let skHex = ls.get('zh_sk', null);
if (!skHex) { skHex = hex(generateSecretKey()); ls.set('zh_sk', skHex); }
let sk = unhex(skHex), pub = getPublicKey(sk), myCode = codeFromPub(pub);
const convKeys = new Map();
const ck = (p) => { if (!convKeys.has(p)) convKeys.set(p, nip44.getConversationKey(sk, p)); return convKeys.get(p); };

/* ================= state ================= */
const S = {
  online: false, mic: false, away: false,
  mode: ls.get('zh_mode', 'near'), room: ls.get('zh_room', ''),
  cells: [], myCell: null, fine: null,               // fine = ~40 m cell, shared only with linked peers
  peers: new Map(),
  blocked: new Set(ls.get('zh_blocked', [])),
  muted: new Set(), focus: null,
  hand: 0, closeWarned: new Set(), echoTipShown: false
};
/* peer = {code, seen, talk, away, hand, pc, audio, src, gain, an, level, webaudioOk, linked, downSince, fine} */
const pool = new SimplePool({ enableReconnect: true });
let subChan = null, subSig = null, presenceTimer = null, geoWatch = null, mixTimer = null;
let localStream = null, localTrack = null, localAn = null;
let lastSpeech = 0, idleWarned = false;
let ctx = null, soundBlocked = false;

/* ================= audio engine ================= */
function audioCtx() {
  if (!ctx) { const AC = window.AudioContext || window.webkitAudioContext; if (AC) ctx = new AC(); }
  if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}
function levelOf(an) {
  const d = new Uint8Array(an.fftSize); an.getByteTimeDomainData(d);
  let sum = 0; for (let i = 0; i < d.length; i++) { const v = (d[i] - 128) / 128; sum += v * v; }
  return Math.sqrt(sum / d.length);
}
/* Remote voice: plays through an <audio> element first (always works on iPhone).
   A Web Audio copy measures loudness; once it proves it carries sound, playback
   moves to Web Audio so each voice gets its own volume (ducking). */
function attachRemote(p, stream) {
  const peer = S.peers.get(p); if (!peer) return;
  if (!peer.audio) {
    peer.audio = document.createElement('audio');
    peer.audio.autoplay = true; peer.audio.setAttribute('playsinline', '');
    $('#sinks').appendChild(peer.audio);
  }
  peer.audio.srcObject = stream;
  peer.audio.muted = S.muted.has(p);
  peer.audio.play().catch(() => { soundBlocked = true; render(); });
  const c = audioCtx(); if (!c) return;
  try {
    if (peer.src) { try { peer.src.disconnect(); } catch {} }
    peer.src = c.createMediaStreamSource(stream);
    peer.an = c.createAnalyser(); peer.an.fftSize = 512;
    peer.gain = c.createGain(); peer.gain.gain.value = 0;
    peer.src.connect(peer.an); peer.src.connect(peer.gain); peer.gain.connect(c.destination);
    peer.webaudioOk = false; peer.level = 0;
  } catch { peer.src = peer.an = peer.gain = null; }
}
function mixTick() {
  // 1. levels
  const talkers = [];
  for (const [p, peer] of S.peers) {
    let lv = 0;
    if (peer.an) {
      lv = levelOf(peer.an);
      if (!peer.webaudioOk && lv > 0.003) {           // Web Audio carries sound: hand playback over
        peer.webaudioOk = true;
        if (peer.audio) peer.audio.muted = true;
      }
    }
    peer.level = peer.level * 0.7 + lv * 0.3;
    const active = peer.talk && !S.muted.has(p) && (peer.webaudioOk ? peer.level > 0.012 : true);
    if (active) talkers.push([p, peer]);
  }
  // 2. who is heard clearly: focused person first, then loudest
  talkers.sort((a, b) => (b[0] === S.focus) - (a[0] === S.focus) || b[1].level - a[1].level);
  const clear = new Set(talkers.slice(0, CLEAR_VOICES).map((t) => t[0]));
  const lead = talkers[0] && talkers[0][0];
  // 3. volumes
  for (const [p, peer] of S.peers) {
    let g = 1;
    if (S.muted.has(p)) g = 0;
    else if (p === S.focus || p === lead) g = 1;
    else if (clear.has(p)) g = 0.7;
    else if (peer.talk) g = 0.25;
    if (peer.gain && peer.webaudioOk) peer.gain.gain.setTargetAtTime(g, ctx.currentTime, 0.08);
    else if (peer.audio) { peer.audio.muted = S.muted.has(p); try { peer.audio.volume = g; } catch {} }
    peer.heard = g;
  }
  S.extraTalkers = Math.max(0, talkers.length - CLEAR_VOICES);
  // 4. my own open mic: auto-close after silence
  if (S.mic && localAn) {
    const lv = levelOf(localAn);
    if (lv > 0.02) { lastSpeech = Date.now(); if (idleWarned) { idleWarned = false; render(); } }
    const idle = Date.now() - lastSpeech;
    if (idle > IDLE_WARN_MS && !idleWarned) { idleWarned = true; toast('المايك مفتوح بدون كلام — سيُغلق خلال ١٠ ثوانٍ', 4000); render(); }
    if (idle > IDLE_CLOSE_MS) { setMic(false); toast('أُغلق المايك تلقائياً'); }
  }
  renderLive();
}

/* ================= mic ================= */
async function ensureLocal() {
  if (localTrack && localTrack.readyState === 'live') return true;
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    localTrack = localStream.getAudioTracks()[0];
    localTrack.enabled = false;
    const c = audioCtx();
    if (c) { const s = c.createMediaStreamSource(localStream); localAn = c.createAnalyser(); localAn.fftSize = 512; s.connect(localAn); }
    return true;
  } catch { toast('اسمح للتطبيق باستخدام المايك ليسمعك الآخرون'); return false; }
}
function stopLocal() { if (localStream) localStream.getTracks().forEach((t) => t.stop()); localStream = null; localTrack = null; localAn = null; }

async function setMic(on) {
  if (on) {
    if (!S.online) { toast('فعّل الإتاحة أولاً'); return false; }
    if (!(await ensureLocal())) return false;
    for (const [p, peer] of S.peers) if (peer.pc) {
      const tr = peer.pc.getTransceivers().find((t) => t.receiver.track && t.receiver.track.kind === 'audio');
      if (tr && !tr.sender.track) { try { await tr.sender.replaceTrack(localTrack); renegotiate(p); } catch {} }
    }
    localTrack.enabled = true; S.mic = true; lastSpeech = Date.now(); idleWarned = false;
    if (S.hand) S.hand = 0;                          // speaking lowers your raised hand
    echoTip();
  } else {
    if (localTrack) localTrack.enabled = false; S.mic = false; idleWarned = false;
  }
  if (navigator.vibrate) navigator.vibrate(12);
  sendPresence(); playAll(); render();
  return true;
}

/* Tap = mic stays open. Press and hold = talk only while holding. */
let press = null;
async function onPressStart(e) {
  e.preventDefault();
  audioCtx();
  if (S.mic) { press = { t: Date.now(), opened: false }; return; }
  press = { t: Date.now(), opened: true };
  await setMic(true);
}
function onPressEnd(e) {
  e.preventDefault();
  if (!press) return;
  const held = Date.now() - press.t;
  if (press.opened) { if (held >= HOLD_MS && S.mic) setMic(false); }   // hold-to-talk released
  else setMic(false);                                                  // tap while open = close
  press = null;
}

/* ================= signalling over relays ================= */
function publish(kind, tags, content) {
  const ev = finalizeEvent({ kind, created_at: now(), tags: [['t', APP_TAG], ...tags], content }, sk);
  return Promise.any(pool.publish(RELAYS, ev)).catch(() => {});
}
function sendPresence(off) {
  if (!S.myCell) return;
  const body = off ? { off: 1 } : { on: 1, talk: S.mic ? 1 : 0, away: S.away ? 1 : 0, hand: S.hand || 0 };
  return publish(K_PRESENCE, [['z', S.myCell]], JSON.stringify(body));
}
function sendSignal(to, msg) {
  let c; try { c = nip44.encrypt(JSON.stringify(msg), ck(to)); } catch { return; }
  return publish(K_SIGNAL, [['p', to]], c);
}
function subscribe() {
  closeSubs();
  subChan = pool.subscribeMany(RELAYS, { kinds: [K_PRESENCE], '#t': [APP_TAG], '#z': S.cells, since: now() - 5 }, {
    onevent(ev) { if (Math.abs(now() - ev.created_at) <= 90) onPresence(ev); }
  });
  subSig = pool.subscribeMany(RELAYS, { kinds: [K_SIGNAL], '#p': [pub], since: now() - 5 }, {
    onevent(ev) { if (Math.abs(now() - ev.created_at) <= 90) onSignal(ev); }
  });
}
function closeSubs() { for (const s of [subChan, subSig]) if (s) { try { s.close(); } catch {} } subChan = subSig = null; }

/* ================= people ================= */
function getPeer(p) {
  let peer = S.peers.get(p);
  if (!peer) { peer = { code: codeFromPub(p), seen: Date.now(), joined: Date.now(), talk: 0, away: 0, hand: 0, pc: null, audio: null, level: 0, linked: false }; S.peers.set(p, peer); }
  return peer;
}
function onPresence(ev) {
  const p = ev.pubkey;
  if (p === pub || S.blocked.has(p)) return;
  let m; try { m = JSON.parse(ev.content); } catch { m = {}; }
  if (m.off) { dropPeer(p); render(); return; }
  const peer = getPeer(p);
  peer.seen = Date.now();
  peer.talk = m.talk ? 1 : 0; peer.away = m.away ? 1 : 0;
  peer.hand = typeof m.hand === 'number' && m.hand > 0 && Date.now() - m.hand < HAND_TTL ? m.hand : 0;
  maybeLink(p);
  render();
}
/* Who gets a direct link when the area is crowded: people talking, people
   asking to talk, then the earliest arrivals. Lower key always dials. */
function wanted() {
  return [...S.peers.entries()].filter(([, v]) => !v.away)
    .sort((a, b) => (b[1].talk - a[1].talk) || ((b[1].hand ? 1 : 0) - (a[1].hand ? 1 : 0)) || (a[1].joined - b[1].joined))
    .slice(0, MAX_LINKS).map(([p]) => p);
}
function maybeLink(p) {
  const peer = S.peers.get(p); if (!peer || peer.pc || !S.online) return;
  const w = wanted();
  if (!w.includes(p)) return;
  if (linkCount() >= MAX_LINKS) {
    // free a slot from someone quiet who is no longer wanted
    const spare = [...S.peers.entries()].find(([k, v]) => v.pc && !w.includes(k));
    if (!spare) return;
    closeLink(spare[0]);
  }
  if (pub < p) startLink(p);
}
function prune() {
  let ch = false;
  for (const [p, v] of S.peers) {
    const ttl = v.away ? AWAY_TTL : PEER_TTL;
    if (Date.now() - v.seen > ttl) { dropPeer(p); ch = true; continue; }
    // stuck link: retry
    if (v.pc && !v.linked && v.downSince && Date.now() - v.downSince > 10000) { closeLink(p); ch = true; }
    if (!v.pc) maybeLink(p);
  }
  if (ch) render();
}
const linkCount = () => [...S.peers.values()].filter((v) => v.pc).length;

/* ================= WebRTC ================= */
function makePC(p) {
  const peer = getPeer(p);
  const pc = new RTCPeerConnection({ iceServers: ICE });
  if (localTrack) pc.addTrack(localTrack, localStream); else pc.addTransceiver('audio', { direction: 'sendrecv' });
  pc.ontrack = (e) => attachRemote(p, e.streams[0] || new MediaStream([e.track]));
  peer.downSince = Date.now();
  pc.onconnectionstatechange = () => {
    const st = pc.connectionState;
    peer.linked = st === 'connected';
    if (st === 'connected') { peer.downSince = 0; sendFine(p); }
    else if (!peer.downSince) peer.downSince = Date.now();
    if (st === 'failed') { try { pc.restartIce && pc.restartIce(); } catch {} if (pub < p) renegotiate(p, true); }
    if (st === 'closed') closeLink(p);
    render();
  };
  peer.pc = pc;
  return pc;
}
function gathered(pc) {
  return new Promise((res) => {
    if (pc.iceGatheringState === 'complete') return res();
    const done = () => { pc.removeEventListener('icegatheringstatechange', chk); res(); };
    const chk = () => { if (pc.iceGatheringState === 'complete') done(); };
    pc.addEventListener('icegatheringstatechange', chk);
    setTimeout(done, 2500);
  });
}
async function startLink(p) {
  const pc = makePC(p);
  try { await pc.setLocalDescription(await pc.createOffer()); await gathered(pc); sendSignal(p, { t: 'offer', sdp: pc.localDescription.sdp }); }
  catch { closeLink(p); }
}
async function renegotiate(p, iceRestart) {
  const peer = S.peers.get(p); if (!peer || !peer.pc || peer.pc.signalingState !== 'stable') return;
  try { await peer.pc.setLocalDescription(await peer.pc.createOffer(iceRestart ? { iceRestart: true } : undefined)); await gathered(peer.pc); sendSignal(p, { t: 'offer', sdp: peer.pc.localDescription.sdp }); }
  catch {}
}
async function onSignal(ev) {
  const p = ev.pubkey;
  if (p === pub || S.blocked.has(p) || !S.online) return;
  let m; try { m = JSON.parse(nip44.decrypt(ev.content, ck(p))); } catch { return; }
  const peer = getPeer(p); peer.seen = Date.now();
  try {
    if (m.t === 'offer') {
      let pc = peer.pc;
      if (pc && pc.signalingState !== 'stable') {
        if (pub < p) return;                 // both dialled: the lower key's offer wins
        closeLink(p); pc = null;
      }
      if (!pc) {
        if (linkCount() >= MAX_LINKS) { const spare = [...S.peers.entries()].find(([k, v]) => v.pc && !v.talk && k !== p); if (spare) closeLink(spare[0]); }
        pc = makePC(p);
      }
      await pc.setRemoteDescription({ type: 'offer', sdp: m.sdp });
      await pc.setLocalDescription(await pc.createAnswer());
      await gathered(pc);
      sendSignal(p, { t: 'answer', sdp: pc.localDescription.sdp });
    } else if (m.t === 'answer' && peer.pc && peer.pc.signalingState === 'have-local-offer') {
      await peer.pc.setRemoteDescription({ type: 'answer', sdp: m.sdp });
    } else if (m.t === 'fine') {
      peer.fine = typeof m.c === 'string' ? m.c.slice(0, 8) : null;
      echoTip();
    } else if (m.t === 'bye') {
      dropPeer(p);
    }
  } catch { closeLink(p); }
  render();
}
function closeLink(p) {
  const peer = S.peers.get(p); if (!peer) return;
  if (peer.pc) { try { peer.pc.close(); } catch {} peer.pc = null; }
  peer.linked = false; peer.downSince = 0;
}
function dropPeer(p) {
  const peer = S.peers.get(p); if (!peer) return;
  closeLink(p);
  if (peer.src) { try { peer.src.disconnect(); peer.gain.disconnect(); } catch {} }
  if (peer.audio) { peer.audio.srcObject = null; peer.audio.remove(); }
  S.peers.delete(p);
  if (S.focus === p) S.focus = null;
}
function playAll() {
  audioCtx();
  let blocked = false;
  for (const [, peer] of S.peers) if (peer.audio) peer.audio.play().catch(() => { blocked = true; });
  soundBlocked = blocked; render();
}

/* ================= very-close detection (echo) ================= */
/* Each linked phone gets my ~40 m area, end-to-end encrypted, never shown. */
function sendFine(p) { if (S.mode === 'near' && S.fine) sendSignal(p, { t: 'fine', c: S.fine }); }
function echoTip() {
  if (S.echoTipShown || S.mode !== 'near' || !S.fine) return;
  const near = [S.fine, ...geohash.neighbors(S.fine)];
  const close = [...S.peers.values()].find((v) => v.fine && near.includes(v.fine) && v.linked);
  if (close && (S.mic || close.talk)) {
    S.echoTipShown = true;
    toast(close.code + ' قريب جداً منك — استخدموا سماعات أو افتحوا مايك واحد لتجنب الصدى', 5000);
  }
}

/* ================= channel ================= */
function getPosition() {
  return new Promise((res) => {
    if (!navigator.geolocation) { toast('الموقع غير متاح، استخدم غرفة خاصة'); return res(null); }
    navigator.geolocation.getCurrentPosition((p) => res(p), () => { toast('اسمح بالموقع لتسمع من حولك، أو استخدم غرفة خاصة'); res(null); },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 });
  });
}
function applyPos(pos) {
  const { latitude: la, longitude: lo } = pos.coords;
  const cell = geohash.encode(la, lo, 6);
  S.fine = geohash.encode(la, lo, 8);
  const changed = S.myCell !== 'g:' + cell;
  S.myCell = 'g:' + cell; S.cells = [cell, ...geohash.neighbors(cell)].map((c) => 'g:' + c);
  return changed;
}
async function computeChannel() {
  if (S.mode === 'room') {
    const r = S.room.trim().toLowerCase(); if (!r) return false;
    const id = 'room:' + (await sha('zahmah-room:' + r));
    S.myCell = id; S.cells = [id]; S.fine = null; return true;
  }
  const pos = await getPosition(); if (!pos) return false;
  applyPos(pos); return true;
}

async function goOnline() {
  audioCtx();
  $('#statusSub').textContent = 'جارٍ الاتصال…';
  if (!(await computeChannel())) { S.online = false; render(); return; }
  await ensureLocal();
  S.online = true; S.away = false;
  subscribe(); sendPresence();
  clearInterval(presenceTimer); presenceTimer = setInterval(() => { sendPresence(); prune(); }, PRESENCE_EVERY);
  clearInterval(mixTimer); mixTimer = setInterval(mixTick, 150);
  if (S.mode === 'near' && navigator.geolocation && geoWatch === null) {
    geoWatch = navigator.geolocation.watchPosition((pos) => {
      if (!S.online || S.mode !== 'near') return;
      if (applyPos(pos)) { subscribe(); sendPresence(); }   // moved to a new area: keep links, widen listening
      for (const [p, v] of S.peers) if (v.linked) sendFine(p);
    }, () => {}, { enableHighAccuracy: true, maximumAge: 30000 });
  }
  render();
}
function goOffline() {
  if (S.online) { sendPresence(true); for (const p of S.peers.keys()) sendSignal(p, { t: 'bye' }); }
  S.online = false; S.mic = false; S.hand = 0;
  clearInterval(presenceTimer); clearInterval(mixTimer); closeSubs();
  if (geoWatch !== null) { navigator.geolocation.clearWatch(geoWatch); geoWatch = null; }
  for (const k of [...S.peers.keys()]) dropPeer(k);
  stopLocal(); render();
}
function toggleHand() {
  if (!S.online) { toast('فعّل الإتاحة أولاً'); return; }
  S.hand = S.hand ? 0 : Date.now();
  if (S.hand) toast('طلبت الدور — يرى الجميع يدك المرفوعة');
  sendPresence(); render();
}

/* ================= render ================= */
function statusOf(p, peer) {
  if (S.muted.has(p)) return 'مكتوم';
  if (peer.away) return 'بعيد';
  if (peer.talk) return 'يتكلم';
  if (peer.hand) return 'يطلب الكلام';
  if (peer.pc && !peer.linked) return 'يتصل…';
  if (!peer.pc) return 'قريب';
  return 'متصل';
}
function renderLive() {
  // cheap per-tick updates: talking glow + extra talkers marker
  document.querySelectorAll('#people .chip').forEach((el) => {
    const peer = S.peers.get(el.dataset.p); if (!peer) return;
    el.classList.toggle('lead', peer.talk && peer.heard === 1 && !S.muted.has(el.dataset.p));
    el.classList.toggle('dim', peer.talk && peer.heard < 0.5 && !S.muted.has(el.dataset.p));
  });
  const ex = $('#extra'); const n = S.extraTalkers || 0;
  ex.hidden = !n; ex.textContent = '+' + n + ' يتكلمون بصوت منخفض';
}
function render() {
  const list = [...S.peers.entries()];
  const n = S.online ? list.length : 0;
  document.body.dataset.online = S.online ? '1' : '0';
  document.body.dataset.talking = S.mic ? '1' : '0';
  $('#myCode').textContent = myCode; $('#myCodeBig').textContent = myCode;
  $('#count').textContent = S.online ? String(n) : '—';
  $('#countLabel').textContent = S.online ? (S.mode === 'room' ? 'في الغرفة معك' : 'قريبون منك · ~١ كم') : 'غير متاح';
  $('#statusTitle').textContent = S.online ? 'متاح' : 'غير متاح';
  $('#statusSub').textContent = S.online ? (S.mode === 'room' ? 'غرفة: ' + S.room : 'يسمعك من حولك برمزك فقط') : 'فعّل لتسمع وتُسمَع';
  $('#sw').setAttribute('aria-checked', S.online ? 'true' : 'false');
  $('#segNear').setAttribute('aria-checked', S.mode === 'near' ? 'true' : 'false');
  $('#segRoom').setAttribute('aria-checked', S.mode === 'room' ? 'true' : 'false');
  $('#talk').setAttribute('aria-pressed', S.mic ? 'true' : 'false');
  $('#talkLabel').textContent = !S.online ? 'فعّل الإتاحة للتحدث'
    : (S.mic ? (idleWarned ? 'لا يوجد كلام — سيُغلق قريباً' : 'المايك مفتوح — اضغط للإغلاق') : 'اضغط للفتح · أو اضغط مطولاً وتكلّم');
  $('#hand').setAttribute('aria-pressed', S.hand ? 'true' : 'false');
  $('#soundBanner').hidden = !(S.online && soundBlocked);
  const talking = list.filter(([, v]) => v.talk).length;
  $('#talkersLine').textContent = S.online && talking ? (talking === 1 ? 'شخص يتكلم الآن' : talking + ' يتكلمون الآن') : '';

  // radar dots
  const dots = $('#dots'); dots.innerHTML = '';
  list.slice(0, 40).forEach(([, p], i) => {
    const a = (i * 137.5) * Math.PI / 180, r = 40 + (i % 3) * 30;
    const d = document.createElement('span');
    d.className = 'dot' + (p.talk ? ' talk' : '') + (p.linked ? '' : ' wait') + (p.away ? ' away' : '');
    d.style.left = (50 + Math.cos(a) * r / 2.2) + '%'; d.style.top = (50 + Math.sin(a) * r / 2.2) + '%';
    dots.appendChild(d);
  });

  // people strip: talking first, then raised hands (oldest first), then others
  const strip = $('#people'); strip.innerHTML = '';
  list.sort((a, b) => (b[1].talk - a[1].talk) || ((a[1].hand || Infinity) - (b[1].hand || Infinity)) || (a[1].away - b[1].away))
    .slice(0, 40).forEach(([p, peer]) => {
      const chip = document.createElement('div');
      chip.className = 'chip' + (peer.talk ? ' on' : '') + (peer.hand ? ' hand' : '') + (S.focus === p ? ' focus' : '') + (peer.away ? ' away' : '');
      chip.dataset.p = p;
      const name = document.createElement('button'); name.className = 'cn'; name.dir = 'ltr'; name.textContent = (peer.hand ? '✋ ' : '') + peer.code;
      name.setAttribute('aria-label', (S.focus === p ? 'إلغاء تقديم ' : 'تقديم صوت ') + peer.code);
      name.onclick = () => { S.focus = S.focus === p ? null : p; toast(S.focus ? 'صوت ' + peer.code + ' في المقدمة' : 'رجع الصوت طبيعي'); render(); };
      const st = document.createElement('span'); st.className = 'cs'; st.textContent = statusOf(p, peer);
      const mute = document.createElement('button'); mute.className = 'cb'; mute.textContent = S.muted.has(p) ? 'إلغاء الكتم' : 'كتم';
      mute.setAttribute('aria-label', (S.muted.has(p) ? 'إلغاء كتم ' : 'كتم ') + peer.code);
      mute.onclick = () => { S.muted.has(p) ? S.muted.delete(p) : S.muted.add(p); render(); };
      const block = document.createElement('button'); block.className = 'cb red'; block.textContent = 'حظر';
      block.setAttribute('aria-label', 'حظر ' + peer.code);
      block.onclick = () => {
        if (!confirm('حظر ' + peer.code + '؟ لن تسمعه ولن يسمعك.')) return;
        S.blocked.add(p); ls.set('zh_blocked', [...S.blocked]);
        sendSignal(p, { t: 'bye' }); dropPeer(p); toast('تم حظر ' + peer.code); render();
      };
      chip.append(name, st, mute, block);
      strip.appendChild(chip);
    });
  $('#peopleWrap').hidden = !(S.online && list.length);
  $('#blockedCount').textContent = String(S.blocked.size);
  renderLive();
}

/* ================= events ================= */
function bind() {
  $('#startBtn').addEventListener('click', () => { ls.set('zh_seen', 1); $('#onboard').hidden = true; goOnline(); });
  $('#sw').addEventListener('click', () => (S.online ? goOffline() : goOnline()));
  const t = $('#talk');
  t.addEventListener('pointerdown', onPressStart);
  t.addEventListener('pointerup', onPressEnd);
  t.addEventListener('pointercancel', onPressEnd);
  t.addEventListener('contextmenu', (e) => e.preventDefault());
  t.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setMic(!S.mic); } });
  $('#hand').addEventListener('click', toggleHand);
  $('#soundBanner').addEventListener('click', playAll);

  const setMode = async (m) => {
    if (m === 'room' && !S.room) { openRoom(); return; }
    S.mode = m; ls.set('zh_mode', m);
    if (S.online) { goOffline(); await goOnline(); } else render();
  };
  function openRoom() { $('#roomInput').value = S.room; $('#roomSheet').hidden = false; setTimeout(() => $('#roomInput').focus(), 50); }
  $('#segNear').addEventListener('click', () => setMode('near'));
  $('#segRoom').addEventListener('click', () => (S.mode === 'room' ? openRoom() : setMode('room')));
  $('#roomCancel').addEventListener('click', () => { $('#roomSheet').hidden = true; });
  $('#roomForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = $('#roomInput').value.trim();
    if (v.length < 3) { toast('اكتب اسم غرفة من ٣ أحرف أو أكثر'); return; }
    S.room = v; ls.set('zh_room', v); $('#roomSheet').hidden = true;
    S.mode = 'room'; ls.set('zh_mode', 'room');
    if (S.online) goOffline();
    await goOnline();
  });
  $('#shareRoom').addEventListener('click', async () => {
    const v = $('#roomInput').value.trim() || S.room;
    if (v.length < 3) { toast('اكتب اسم الغرفة أولاً'); return; }
    const link = location.origin + location.pathname + '?room=' + encodeURIComponent(v);
    const text = 'تعال كلّمني على زحمة — الغرفة: ' + v + '\n' + link;
    try { if (navigator.share) await navigator.share({ text }); else { await navigator.clipboard.writeText(text); toast('تم النسخ'); } } catch {}
  });

  $('#openSettings').addEventListener('click', () => { $('#settings').hidden = false; render(); });
  $('#closeSettings').addEventListener('click', () => { $('#settings').hidden = true; });
  $('#clearBlocked').addEventListener('click', () => { S.blocked.clear(); ls.set('zh_blocked', []); toast('تم إلغاء الحظر'); render(); });
  $('#newCode').addEventListener('click', () => {
    if (!confirm('إنشاء رمز جديد؟ سيتغير رمزك فوراً.')) return;
    const was = S.online; if (was) goOffline();
    sk = generateSecretKey(); skHex = hex(sk); ls.set('zh_sk', skHex);
    pub = getPublicKey(sk); myCode = codeFromPub(pub); convKeys.clear();
    toast('رمزك الجديد ' + myCode); render();
    if (was) goOnline();
  });

  // phone locked / app in background → others see "away"; back → reconnect what dropped
  document.addEventListener('visibilitychange', () => {
    if (!S.online) return;
    S.away = document.hidden;
    if (S.away && S.mic) setMic(false);
    sendPresence();
    if (!S.away) { subscribe(); playAll(); prune(); }
  });
  window.addEventListener('online', () => { if (S.online) { subscribe(); sendPresence(); toast('عاد الاتصال'); } });
  window.addEventListener('offline', () => { if (S.online) toast('انقطع الإنترنت — سنعيد الاتصال تلقائياً', 4000); });
  window.addEventListener('pagehide', () => { if (S.online) sendPresence(true); });
}

/* ================= boot ================= */
bind();
const params = new URLSearchParams(location.search);
if (params.get('room')) { S.room = params.get('room').slice(0, 40); S.mode = 'room'; ls.set('zh_room', S.room); ls.set('zh_mode', 'room'); }
if (ls.get('zh_seen', 0)) $('#onboard').hidden = true;
render();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
