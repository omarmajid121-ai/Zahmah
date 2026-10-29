import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure';
import { SimplePool } from 'nostr-tools/pool';
import * as nip44 from 'nostr-tools/nip44';
import geohash from 'ngeohash';

/* ---------- config ---------- */
const qsRelay = new URLSearchParams(location.search).get('relay');
const RELAYS = qsRelay && /^wss?:\/\/localhost/.test(qsRelay) ? [qsRelay] : ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net', 'wss://relay.nostr.band'];
const K_PRESENCE = 21210;   // ephemeral kinds: relays forward live, never store
const K_SIGNAL = 21212;
const APP_TAG = 'zahmah-v2';
const PRESENCE_EVERY = 7000;
const PEER_TTL = 22000;
const MAX_LINKS = 24;
const ICE = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] },
  { urls: ['turn:openrelay.metered.ca:80', 'turn:openrelay.metered.ca:443', 'turn:openrelay.metered.ca:443?transport=tcp'], username: 'openrelayproject', credential: 'openrelayproject' }
];

/* ---------- helpers ---------- */
const $ = (s) => document.querySelector(s);
const ls = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }
};
const hex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('');
const unhex = (h) => new Uint8Array(h.match(/.{2}/g).map((x) => parseInt(x, 16)));
const now = () => Math.floor(Date.now() / 1000);
function codeFromPub(p) { return 'Z-' + String(parseInt(p.slice(0, 8), 16) % 10000).padStart(4, '0'); }
async function sha(t) { const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t)); return hex(new Uint8Array(d)).slice(0, 24); }
let toastT;
function toast(m) { const t = $('#toast'); t.textContent = m; t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 2400); }

/* ---------- identity ---------- */
let skHex = ls.get('zh_sk', null);
if (!skHex) { skHex = hex(generateSecretKey()); ls.set('zh_sk', skHex); }
let sk = unhex(skHex), pub = getPublicKey(sk), myCode = codeFromPub(pub);
const convKeys = new Map();
const ck = (p) => { if (!convKeys.has(p)) convKeys.set(p, nip44.getConversationKey(sk, p)); return convKeys.get(p); };

/* ---------- state ---------- */
const S = {
  online: false,
  mic: false,
  mode: ls.get('zh_mode', 'near'),
  room: ls.get('zh_room', ''),
  cells: [], myCell: null,
  peers: new Map(),       // pub -> {code, seen, talk, pc, audio, linked}
  blocked: new Set(ls.get('zh_blocked', [])),
  muted: new Set()
};
const pool = new SimplePool();
let subChan = null, subSig = null, presenceTimer = null, geoWatch = null;
let localStream = null, localTrack = null;
let soundBlocked = false;

/* ---------- mic ---------- */
async function ensureLocal() {
  if (localTrack && localTrack.readyState === 'live') return true;
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    localTrack = localStream.getAudioTracks()[0];
    localTrack.enabled = false;
    return true;
  } catch { toast('اسمح للتطبيق باستخدام المايك ليسمعك الآخرون'); return false; }
}
function stopLocal() { if (localStream) localStream.getTracks().forEach((t) => t.stop()); localStream = null; localTrack = null; }

async function toggleMic() {
  if (!S.online) { toast('فعّل الإتاحة أولاً'); return; }
  if (!S.mic) {
    if (!(await ensureLocal())) return;
    // attach the track to any link that was made before we had a mic
    for (const [p, peer] of S.peers) if (peer.pc) {
      const tr = peer.pc.getTransceivers().find((t) => t.receiver.track && t.receiver.track.kind === 'audio');
      if (tr && !tr.sender.track) { try { await tr.sender.replaceTrack(localTrack); tr.direction = 'sendrecv'; renegotiate(p); } catch {} }
    }
    localTrack.enabled = true; S.mic = true;
  } else {
    if (localTrack) localTrack.enabled = false; S.mic = false;
  }
  if (navigator.vibrate) navigator.vibrate(12);
  sendPresence();
  playAll();
  render();
}

/* ---------- nostr ---------- */
function publish(kind, tags, content) {
  const ev = finalizeEvent({ kind, created_at: now(), tags: [['t', APP_TAG], ...tags], content }, sk);
  return Promise.any(pool.publish(RELAYS, ev)).catch(() => {});
}
function sendPresence(off) {
  if (!S.myCell) return;
  return publish(K_PRESENCE, [['z', S.myCell]], JSON.stringify(off ? { off: 1 } : { on: 1, talk: S.mic ? 1 : 0 }));
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
function closeSubs() {
  for (const s of [subChan, subSig]) if (s) { try { s.close(); } catch {} }
  subChan = subSig = null;
}

/* ---------- presence ---------- */
function onPresence(ev) {
  const p = ev.pubkey;
  if (p === pub || S.blocked.has(p)) return;
  let m; try { m = JSON.parse(ev.content); } catch { m = {}; }
  if (m.off) { dropPeer(p); render(); return; }
  let peer = S.peers.get(p);
  if (!peer) { peer = { code: codeFromPub(p), seen: 0, talk: 0, pc: null, audio: null, linked: false }; S.peers.set(p, peer); }
  peer.seen = Date.now(); peer.talk = m.talk ? 1 : 0;
  // the lower key starts the call, so two phones never both dial
  if (!peer.pc && pub < p && linkCount() < MAX_LINKS) startLink(p);
  render();
}
function prune() {
  let ch = false;
  for (const [p, v] of S.peers) if (Date.now() - v.seen > PEER_TTL) { dropPeer(p); ch = true; }
  if (ch) render();
}
const linkCount = () => [...S.peers.values()].filter((v) => v.pc).length;

/* ---------- WebRTC ---------- */
function makePC(p) {
  const peer = S.peers.get(p);
  const pc = new RTCPeerConnection({ iceServers: ICE });
  if (localTrack) pc.addTrack(localTrack, localStream);
  else pc.addTransceiver('audio', { direction: 'sendrecv' });
  pc.ontrack = (e) => {
    const stream = e.streams[0] || new MediaStream([e.track]);
    if (!peer.audio) {
      peer.audio = document.createElement('audio');
      peer.audio.autoplay = true; peer.audio.setAttribute('playsinline', '');
      document.getElementById('sinks').appendChild(peer.audio);
    }
    peer.audio.srcObject = stream;
    peer.audio.muted = S.muted.has(p);
    peer.audio.play().catch(() => { soundBlocked = true; render(); });
  };
  pc.onconnectionstatechange = () => {
    peer.linked = pc.connectionState === 'connected';
    if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
      closeLink(p);
      // retry on the next heartbeat
    }
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
  try {
    await pc.setLocalDescription(await pc.createOffer());
    await gathered(pc);
    sendSignal(p, { t: 'offer', sdp: pc.localDescription.sdp });
  } catch { closeLink(p); }
}
async function renegotiate(p) {
  const peer = S.peers.get(p); if (!peer || !peer.pc) return;
  try {
    await peer.pc.setLocalDescription(await peer.pc.createOffer());
    await gathered(peer.pc);
    sendSignal(p, { t: 'offer', sdp: peer.pc.localDescription.sdp });
  } catch {}
}
async function onSignal(ev) {
  const p = ev.pubkey;
  if (p === pub || S.blocked.has(p) || !S.online) return;
  let m; try { m = JSON.parse(nip44.decrypt(ev.content, ck(p))); } catch { return; }
  let peer = S.peers.get(p);
  if (!peer) { peer = { code: codeFromPub(p), seen: Date.now(), talk: 0, pc: null, audio: null, linked: false }; S.peers.set(p, peer); }
  peer.seen = Date.now();
  try {
    if (m.t === 'offer') {
      let pc = peer.pc;
      if (pc && pc.signalingState !== 'stable') { closeLink(p); pc = null; }
      if (!pc) pc = makePC(p);
      await pc.setRemoteDescription({ type: 'offer', sdp: m.sdp });
      await pc.setLocalDescription(await pc.createAnswer());
      await gathered(pc);
      sendSignal(p, { t: 'answer', sdp: pc.localDescription.sdp });
    } else if (m.t === 'answer' && peer.pc && peer.pc.signalingState === 'have-local-offer') {
      await peer.pc.setRemoteDescription({ type: 'answer', sdp: m.sdp });
    } else if (m.t === 'bye') {
      dropPeer(p);
    }
  } catch { closeLink(p); }
  render();
}
function closeLink(p) {
  const peer = S.peers.get(p); if (!peer) return;
  if (peer.pc) { try { peer.pc.close(); } catch {} peer.pc = null; }
  peer.linked = false;
}
function dropPeer(p) {
  const peer = S.peers.get(p); if (!peer) return;
  closeLink(p);
  if (peer.audio) { peer.audio.srcObject = null; peer.audio.remove(); }
  S.peers.delete(p);
}
function playAll() {
  let blocked = false;
  for (const [, peer] of S.peers) if (peer.audio) peer.audio.play().catch(() => { blocked = true; });
  soundBlocked = blocked; render();
}

/* ---------- channel ---------- */
function getPosition() {
  return new Promise((res) => {
    if (!navigator.geolocation) { toast('الموقع غير متاح، استخدم غرفة خاصة'); return res(null); }
    navigator.geolocation.getCurrentPosition((p) => res(p), () => { toast('اسمح بالموقع لتسمع من حولك، أو استخدم غرفة خاصة'); res(null); },
      { enableHighAccuracy: false, timeout: 15000, maximumAge: 60000 });
  });
}
async function computeChannel() {
  if (S.mode === 'room') {
    const r = S.room.trim().toLowerCase(); if (!r) return false;
    const id = 'room:' + (await sha('zahmah-room:' + r));
    S.myCell = id; S.cells = [id]; return true;
  }
  const pos = await getPosition(); if (!pos) return false;
  const cell = geohash.encode(pos.coords.latitude, pos.coords.longitude, 6);
  S.myCell = 'g:' + cell; S.cells = [cell, ...geohash.neighbors(cell)].map((c) => 'g:' + c);
  return true;
}

async function goOnline() {
  $('#statusSub').textContent = 'جارٍ الاتصال…';
  if (!(await computeChannel())) { S.online = false; render(); return; }
  await ensureLocal();           // ask for mic once, mic stays closed until you tap
  S.online = true;
  subscribe(); sendPresence();
  clearInterval(presenceTimer);
  presenceTimer = setInterval(() => { sendPresence(); prune(); }, PRESENCE_EVERY);
  if (S.mode === 'near' && navigator.geolocation && geoWatch === null) {
    geoWatch = navigator.geolocation.watchPosition((p) => {
      const c = 'g:' + geohash.encode(p.coords.latitude, p.coords.longitude, 6);
      if (S.online && S.mode === 'near' && c !== S.myCell) {
        computeChannel().then(() => { for (const k of [...S.peers.keys()]) dropPeer(k); subscribe(); sendPresence(); render(); });
      }
    }, () => {}, { enableHighAccuracy: false, maximumAge: 60000 });
  }
  render();
}
function goOffline() {
  if (S.online) { sendPresence(true); for (const p of S.peers.keys()) sendSignal(p, { t: 'bye' }); }
  S.online = false; S.mic = false;
  clearInterval(presenceTimer); closeSubs();
  if (geoWatch !== null) { navigator.geolocation.clearWatch(geoWatch); geoWatch = null; }
  for (const k of [...S.peers.keys()]) dropPeer(k);
  stopLocal();
  render();
}

/* ---------- render ---------- */
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
  $('#talkLabel').textContent = !S.online ? 'فعّل الإتاحة للتحدث' : (S.mic ? 'المايك مفتوح — اضغط للإغلاق' : 'اضغط لفتح المايك');
  $('#soundBanner').hidden = !(S.online && soundBlocked);

  // dots
  const dots = $('#dots'); dots.innerHTML = '';
  list.slice(0, 30).forEach(([, p], i) => {
    const a = (i * 137.5) * Math.PI / 180, r = 40 + (i % 3) * 30;
    const d = document.createElement('span');
    d.className = 'dot' + (p.talk ? ' talk' : '') + (p.linked ? '' : ' wait');
    d.style.left = (50 + Math.cos(a) * r / 2.2) + '%'; d.style.top = (50 + Math.sin(a) * r / 2.2) + '%';
    dots.appendChild(d);
  });

  // people strip
  const strip = $('#people'); strip.innerHTML = '';
  list.sort((a, b) => b[1].talk - a[1].talk).slice(0, 30).forEach(([p, peer]) => {
    const chip = document.createElement('div');
    chip.className = 'chip' + (peer.talk ? ' on' : '');
    const name = document.createElement('span'); name.className = 'cn'; name.dir = 'ltr'; name.textContent = peer.code;
    const st = document.createElement('span'); st.className = 'cs';
    st.textContent = S.muted.has(p) ? 'مكتوم' : (peer.talk ? 'يتكلم' : (peer.linked ? 'متصل' : 'يتصل…'));
    const mute = document.createElement('button'); mute.className = 'cb'; mute.textContent = S.muted.has(p) ? 'إلغاء الكتم' : 'كتم';
    mute.setAttribute('aria-label', (S.muted.has(p) ? 'إلغاء كتم ' : 'كتم ') + peer.code);
    mute.onclick = () => { S.muted.has(p) ? S.muted.delete(p) : S.muted.add(p); if (peer.audio) peer.audio.muted = S.muted.has(p); render(); };
    const block = document.createElement('button'); block.className = 'cb red'; block.textContent = 'حظر';
    block.setAttribute('aria-label', 'حظر ' + peer.code);
    block.onclick = () => {
      if (!confirm('حظر ' + peer.code + '؟ لن تسمعه ولن يسمعك.')) return;
      S.blocked.add(p); ls.set('zh_blocked', [...S.blocked]);
      const reports = ls.get('zh_reports', []); reports.push({ code: peer.code, at: Date.now() }); ls.set('zh_reports', reports);
      sendSignal(p, { t: 'bye' }); dropPeer(p); toast('تم حظر ' + peer.code); render();
    };
    chip.append(name, st, mute, block);
    strip.appendChild(chip);
  });
  strip.hidden = !(S.online && list.length);
  $('#blockedCount').textContent = String(S.blocked.size);
}

/* ---------- events ---------- */
function bind() {
  $('#startBtn').addEventListener('click', () => { ls.set('zh_seen', 1); $('#onboard').hidden = true; goOnline(); });
  $('#sw').addEventListener('click', () => (S.online ? goOffline() : goOnline()));
  $('#talk').addEventListener('click', toggleMic);
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

  document.addEventListener('visibilitychange', () => { if (!document.hidden && S.online) { sendPresence(); playAll(); } });
  window.addEventListener('pagehide', () => { if (S.online) sendPresence(true); });
}

/* ---------- boot ---------- */
bind();
const params = new URLSearchParams(location.search);
if (params.get('room')) { S.room = params.get('room').slice(0, 40); S.mode = 'room'; ls.set('zh_room', S.room); ls.set('zh_mode', 'room'); }
if (ls.get('zh_seen', 0)) $('#onboard').hidden = true;
render();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
