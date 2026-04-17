const SB_URL = 'https://bgsvuywxejpmkstgqizq.supabase.co';
const SB_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJnc3Z1eXd4ZWpwbWtzdGdxaXpxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzE2MDc0MzMsImV4cCI6MjA4NzE4MzQzM30.EvHOy5sBbXzSxjRS5vPGzm8cnFrOXxDfclP-ru3VU_M';
const APP_URL = 'https://screencast-eight.vercel.app';

const $ = id => document.getElementById(id);

let mediaRecorder = null;
let chunks = [];
let startTime = null;
let timerInterval = null;
let screenStream = null;
let shareUrl = null;

// ── State machine ──────────────────────────────────────────
function show(state) {
  ['idle','recording','uploading','done','error'].forEach(s => {
    $(`state-${s}`).style.display = s === state ? 'block' : 'none';
  });
}

// ── On load: check login then show idle ────────────────────
chrome.storage.local.get(['token', 'userId'], s => {
  if (!s.token || !s.userId) {
    showError('Not signed in. Open the extension and sign in first.');
    return;
  }
  show('idle');
});

// ── Start ──────────────────────────────────────────────────
$('start-btn').addEventListener('click', startRecording);

async function startRecording() {
  $('start-btn').disabled = true;
  try {
    // Native browser screen picker — user picks screen / window / tab
    screenStream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: 30 },
      audio: true, // system audio if available
    });

    // Mic audio (optional — user can deny)
    let micStream = null;
    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    } catch { /* mic denied, record without */ }

    // Merge tracks
    const tracks = [
      ...screenStream.getVideoTracks(),
      ...screenStream.getAudioTracks(),
      ...(micStream ? micStream.getAudioTracks() : []),
    ];
    const combined = new MediaStream(tracks);

    // Pick best supported codec
    const mimeType = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
      .find(m => MediaRecorder.isTypeSupported(m)) || 'video/webm';

    chunks = [];
    mediaRecorder = new MediaRecorder(combined, { mimeType });
    mediaRecorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };
    mediaRecorder.onstop = handleStop;
    mediaRecorder.start(1000);

    // When user stops via Chrome's native "Stop sharing" bar
    screenStream.getVideoTracks()[0].addEventListener('ended', () => stopRecording());

    startTime = Date.now();
    show('recording');
    startTimer();
  } catch (e) {
    if (e.name === 'NotAllowedError' || e.message.includes('cancel')) {
      // User cancelled picker — just reset
      $('start-btn').disabled = false;
      return;
    }
    showError(e.message);
  }
}

// ── Stop ───────────────────────────────────────────────────
$('stop-btn').addEventListener('click', stopRecording);

function stopRecording() {
  stopTimer();
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  }
  screenStream?.getTracks().forEach(t => t.stop());
}

// ── Discard ────────────────────────────────────────────────
$('cancel-btn').addEventListener('click', () => {
  stopTimer();
  mediaRecorder?.stream?.getTracks().forEach(t => t.stop());
  if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
  chunks = [];
  show('idle');
  $('start-btn').disabled = false;
});

// ── After recording stops → upload ────────────────────────
async function handleStop() {
  if (chunks.length === 0) { show('idle'); return; }

  const blob = new Blob(chunks, { type: mediaRecorder.mimeType || 'video/webm' });
  const duration = Math.round((Date.now() - startTime) / 1000);
  show('uploading');

  try {
    const { token, userId } = await chrome.storage.local.get(['token', 'userId']);
    if (!token) throw new Error('Not signed in');

    setProgress(10);

    // 1. Create DB record
    const title = `Recording ${new Date().toLocaleString('en-US', { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' })}`;
    const recRes = await sbFetch('POST', '/rest/v1/recordings', token, {
      user_id: userId,
      title,
      duration,
      file_size: blob.size,
      mime_type: blob.type,
      recording_mode: 'screen',
      status: 'processing',
    }, 'Prefer: return=representation');

    if (!recRes.ok) {
      const e = await recRes.json();
      throw new Error(e.message || 'DB insert failed');
    }

    const recData = await recRes.json();
    const rec = Array.isArray(recData) ? recData[0] : recData;
    setProgress(30);

    // 2. Upload video to storage
    const path = `${userId}/${rec.id}.webm`;
    const upRes = await fetch(`${SB_URL}/storage/v1/object/recordings/${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': blob.type,
        'apikey': SB_KEY,
        'Authorization': `Bearer ${token}`,
      },
      body: blob,
    });
    if (!upRes.ok) {
      const e = await upRes.json().catch(() => ({}));
      throw new Error(e.error || e.message || 'Upload failed');
    }
    setProgress(85);

    // 3. Mark ready
    await sbFetch('PATCH', `/rest/v1/recordings?id=eq.${rec.id}`, token, {
      storage_path: path,
      status: 'ready',
    });
    setProgress(100);

    shareUrl = `${APP_URL}/watch/${rec.share_id}`;
    showDone(shareUrl, rec.id);
  } catch (e) {
    showError(e.message);
  }
}

// ── Done ───────────────────────────────────────────────────
function showDone(url, recId) {
  show('done');
  $('share-link').textContent = url;
  $('open-btn').onclick = () => { chrome.tabs.create({ url: `${APP_URL}/dashboard/recordings/${recId}` }); };
  $('share-link').onclick = () => {
    navigator.clipboard.writeText(url).then(() => {
      $('copy-note').textContent = '✓ Copied!';
      setTimeout(() => { $('copy-note').textContent = 'Click link to copy'; }, 2000);
    });
  };
}

$('again-btn').addEventListener('click', () => {
  chunks = [];
  show('idle');
  $('start-btn').disabled = false;
});

// ── Error ──────────────────────────────────────────────────
function showError(msg) {
  show('error');
  $('err-msg').textContent = msg;
}
$('retry-btn').addEventListener('click', () => {
  show('idle');
  $('start-btn').disabled = false;
});

// ── Timer ──────────────────────────────────────────────────
function startTimer() {
  $('timer').textContent = '0:00';
  timerInterval = setInterval(() => {
    const s = Math.floor((Date.now() - startTime) / 1000);
    const m = Math.floor(s / 60);
    $('timer').textContent = `${m}:${String(s % 60).padStart(2, '0')}`;
  }, 500);
}
function stopTimer() { clearInterval(timerInterval); }

// ── Progress bar ───────────────────────────────────────────
function setProgress(pct) { $('progress-bar').style.width = `${pct}%`; }

// ── Supabase helper ────────────────────────────────────────
function sbFetch(method, path, token, body, extraHeader) {
  const headers = {
    'Content-Type': 'application/json',
    'apikey': SB_KEY,
    'Authorization': `Bearer ${token}`,
  };
  if (extraHeader) {
    const [k, v] = extraHeader.split(': ');
    headers[k] = v;
  }
  return fetch(`${SB_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
}
