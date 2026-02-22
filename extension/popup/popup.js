// === Constants ===
const MAX_DURATION = 3600;

// === State ===
let currentMode = 'tab';
let previewStream = null;
let audioContext = null;
let audioAnalyser = null;
let audioRafId = null;
let timerInterval = null;
let elapsedSeconds = 0;

// === DOM Refs ===
const setupView = document.getElementById('setup-view');
const recordingView = document.getElementById('recording-view');
const doneView = document.getElementById('done-view');
const cameraSelect = document.getElementById('camera-select');
const micSelect = document.getElementById('mic-select');
const cameraPreview = document.getElementById('camera-preview');
const noCameraMsg = document.getElementById('no-camera-msg');
const audioLevelBar = document.getElementById('audio-level-bar');
const timerEl = document.getElementById('timer');
const startBtn = document.getElementById('start-btn');
const pauseBtn = document.getElementById('pause-btn');
const stopBtn = document.getElementById('stop-btn');
const downloadBtn = document.getElementById('download-btn');
const uploadBtn = document.getElementById('upload-btn');
const discardBtn = document.getElementById('discard-btn');
const titleInput = document.getElementById('title-input');
const recordingInfo = document.getElementById('recording-info');
const uploadProgress = document.getElementById('upload-progress');
const uploadBar = document.getElementById('upload-bar');

// === Init ===
document.addEventListener('DOMContentLoaded', async () => {
  // Always attach button listeners first
  startBtn.addEventListener('click', startRecording);
  pauseBtn.addEventListener('click', togglePause);
  stopBtn.addEventListener('click', stopRecording);
  downloadBtn.addEventListener('click', downloadRecording);
  uploadBtn.addEventListener('click', uploadRecording);
  discardBtn.addEventListener('click', discardRecording);

  // Sync auth from web app if not stored yet
  await syncAuthFromWebApp();

  // Check if already recording
  const state = await sendMessage({ action: 'getState' });
  if (state && (state.state === 'recording' || state.state === 'paused')) {
    elapsedSeconds = state.elapsed || 0;
    currentMode = state.mode || 'tab';
    showView('recording');
    startTimerDisplay();
    if (state.state === 'paused') {
      pauseBtn.textContent = 'Resume';
    }
    return;
  }
  if (state && state.state === 'stopped') {
    elapsedSeconds = state.elapsed || 0;
    showView('done');
    recordingInfo.textContent = `${formatTime(elapsedSeconds)} recorded`;
    return;
  }

  await enumerateDevices();

  // Mode picker
  document.querySelectorAll('.mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentMode = btn.dataset.mode;
    });
  });

  // Device selectors
  cameraSelect.addEventListener('change', () => {
    startCameraPreview(cameraSelect.value);
  });
  micSelect.addEventListener('change', () => {
    startAudioLevel(micSelect.value);
  });
});

// === Device Enumeration ===
async function enumerateDevices() {
  // Request permissions - try both, then individually if needed
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    stream.getTracks().forEach(t => t.stop());
  } catch {
    // Try video and audio separately
    try {
      const vs = await navigator.mediaDevices.getUserMedia({ video: true });
      vs.getTracks().forEach(t => t.stop());
    } catch {}
    try {
      const as = await navigator.mediaDevices.getUserMedia({ audio: true });
      as.getTracks().forEach(t => t.stop());
    } catch {}
  }

  // Always enumerate devices (labels available after permission grant)
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const cameras = devices.filter(d => d.kind === 'videoinput');
    const mics = devices.filter(d => d.kind === 'audioinput');

    // Populate camera select
    cameraSelect.innerHTML = '<option value="">No Camera</option>';
    cameras.forEach(cam => {
      const opt = document.createElement('option');
      opt.value = cam.deviceId;
      opt.textContent = cam.label || `Camera ${cam.deviceId.slice(0, 8)}`;
      cameraSelect.appendChild(opt);
    });

    // Populate mic select
    micSelect.innerHTML = '<option value="">No Microphone</option>';
    mics.forEach(mic => {
      const opt = document.createElement('option');
      opt.value = mic.deviceId;
      opt.textContent = mic.label || `Microphone ${mic.deviceId.slice(0, 8)}`;
      micSelect.appendChild(opt);
    });

    // Auto-select first devices
    if (cameras.length > 0) {
      cameraSelect.value = cameras[0].deviceId;
      startCameraPreview(cameras[0].deviceId);
    }
    if (mics.length > 0) {
      micSelect.value = mics[0].deviceId;
      startAudioLevel(mics[0].deviceId);
    }
  } catch (err) {
    console.warn('Device enumeration failed:', err);
  }
}

// === Camera Preview ===
async function startCameraPreview(deviceId) {
  if (previewStream) {
    previewStream.getTracks().forEach(t => t.stop());
    previewStream = null;
  }

  if (!deviceId) {
    cameraPreview.srcObject = null;
    noCameraMsg.style.display = 'flex';
    return;
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { deviceId: { exact: deviceId } }
    });
    previewStream = stream;
    cameraPreview.srcObject = stream;
    noCameraMsg.style.display = 'none';
  } catch {
    noCameraMsg.style.display = 'flex';
  }
}

// === Audio Level Meter ===
async function startAudioLevel(deviceId) {
  if (audioRafId) cancelAnimationFrame(audioRafId);
  if (audioContext) { audioContext.close(); audioContext = null; }

  if (!deviceId) {
    audioLevelBar.style.width = '0%';
    return;
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { deviceId: { exact: deviceId } }
    });
    audioContext = new AudioContext();
    const source = audioContext.createMediaStreamSource(stream);
    audioAnalyser = audioContext.createAnalyser();
    audioAnalyser.fftSize = 256;
    source.connect(audioAnalyser);

    const dataArray = new Uint8Array(audioAnalyser.frequencyBinCount);
    function tick() {
      audioAnalyser.getByteFrequencyData(dataArray);
      const avg = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;
      audioLevelBar.style.width = `${Math.min(100, (avg / 128) * 100)}%`;
      audioRafId = requestAnimationFrame(tick);
    }
    tick();
  } catch {
    audioLevelBar.style.width = '0%';
  }
}

// === Start Recording ===
async function startRecording() {
  startBtn.disabled = true;
  startBtn.textContent = 'Starting...';

  // Stop preview streams
  if (previewStream) {
    previewStream.getTracks().forEach(t => t.stop());
    previewStream = null;
  }
  if (audioRafId) cancelAnimationFrame(audioRafId);
  if (audioContext) { audioContext.close(); audioContext = null; }

  const response = await sendMessage({
    action: 'startRecording',
    mode: currentMode,
    cameraId: cameraSelect.value || null,
    micId: micSelect.value || null,
  });

  if (response && response.success) {
    elapsedSeconds = 0;
    showView('recording');
    startTimerDisplay();
  } else {
    startBtn.disabled = false;
    startBtn.textContent = 'Start Recording';
    alert(response?.error || 'Failed to start recording');
  }
}

// === Timer Display ===
function startTimerDisplay() {
  timerEl.textContent = formatTime(elapsedSeconds);
  timerInterval = setInterval(() => {
    elapsedSeconds++;
    timerEl.textContent = formatTime(elapsedSeconds);
    if (elapsedSeconds >= MAX_DURATION) {
      stopRecording();
    }
  }, 1000);
}

// === Pause/Resume ===
async function togglePause() {
  if (pauseBtn.textContent === 'Pause') {
    await sendMessage({ action: 'pauseRecording' });
    pauseBtn.textContent = 'Resume';
    clearInterval(timerInterval);
    document.querySelector('.rec-dot').style.animationPlayState = 'paused';
  } else {
    await sendMessage({ action: 'resumeRecording' });
    pauseBtn.textContent = 'Pause';
    startTimerDisplay();
    document.querySelector('.rec-dot').style.animationPlayState = 'running';
  }
}

// === Stop Recording ===
async function stopRecording() {
  clearInterval(timerInterval);
  const response = await sendMessage({ action: 'stopRecording' });
  if (response && response.success) {
    showView('done');
    const size = response.blobSize ? ` (${formatSize(response.blobSize)})` : '';
    recordingInfo.textContent = `${formatTime(elapsedSeconds)} recorded${size}`;
  }
}

// === Download ===
async function downloadRecording() {
  const title = titleInput.value || 'recording';
  await sendMessage({ action: 'downloadRecording', title });
}

// === Upload ===
async function uploadRecording() {
  uploadBtn.disabled = true;
  uploadBtn.textContent = 'Uploading...';
  uploadProgress.style.display = 'block';

  const response = await sendMessage({
    action: 'uploadToWebApp',
    title: titleInput.value || 'Untitled Recording',
    duration: elapsedSeconds,
    mode: currentMode,
  });

  if (response && response.success) {
    chrome.tabs.create({ url: 'https://screencast-eight.vercel.app/dashboard' });
    window.close();
  } else {
    uploadBtn.disabled = false;
    uploadBtn.textContent = 'Save to Screencast';
    alert(response?.error || 'Upload failed');
  }
}

// === Discard ===
async function discardRecording() {
  await sendMessage({ action: 'discardRecording' });
  showView('setup');
  startBtn.disabled = false;
  startBtn.textContent = 'Start Recording';
  await enumerateDevices();
}

// === Message Listener (progress updates from background) ===
chrome.runtime.onMessage.addListener((message) => {
  if (message.action === 'uploadProgress') {
    uploadBar.style.width = `${message.progress}%`;
  }
  if (message.action === 'timerSync') {
    elapsedSeconds = message.elapsed;
    timerEl.textContent = formatTime(elapsedSeconds);
  }
  if (message.action === 'recordingStopped') {
    clearInterval(timerInterval);
    showView('done');
    recordingInfo.textContent = `${formatTime(elapsedSeconds)} recorded`;
  }
});

// === Helpers ===
function showView(view) {
  setupView.style.display = view === 'setup' ? 'block' : 'none';
  recordingView.style.display = view === 'recording' ? 'block' : 'none';
  doneView.style.display = view === 'done' ? 'block' : 'none';
}

function formatTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function formatSize(bytes) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function sendMessage(msg) {
  try {
    return await chrome.runtime.sendMessage(msg);
  } catch (err) {
    console.error('Message failed:', err);
    return null;
  }
}

// === Auth Sync: Read Supabase token from web app ===
async function syncAuthFromWebApp() {
  try {
    const stored = await chrome.storage.local.get(['authToken', 'userId']);
    if (stored.authToken && stored.userId) return; // Already have auth

    // Find an open tab with the web app
    const tabs = await chrome.tabs.query({ url: 'https://screencast-eight.vercel.app/*' });
    if (tabs.length === 0) return;

    const results = await chrome.scripting.executeScript({
      target: { tabId: tabs[0].id },
      func: () => {
        const keys = Object.keys(localStorage);
        const authKey = keys.find(k => k.startsWith('sb-') && k.endsWith('-auth-token'));
        if (!authKey) return null;
        try {
          const data = JSON.parse(localStorage.getItem(authKey));
          return { accessToken: data.access_token, userId: data.user?.id };
        } catch { return null; }
      },
    });

    const auth = results?.[0]?.result;
    if (auth && auth.accessToken && auth.userId) {
      await chrome.storage.local.set({
        authToken: auth.accessToken,
        userId: auth.userId,
      });
    }
  } catch {
    // Web app tab not available or permissions issue
  }
}
