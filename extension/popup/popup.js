// === Constants ===
const MAX_DURATION = 3600;
const SUPABASE_URL = 'https://bgsvuywxejpmkstgqizq.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJnc3Z1eXd4ZWpwbWtzdGdxaXpxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzE2MDc0MzMsImV4cCI6MjA4NzE4MzQzM30.EvHOy5sBbXzSxjRS5vPGzm8cnFrOXxDfclP-ru3VU_M';

// === State ===
let currentMode = 'tab';
let previewStream = null;
let audioContext = null;
let audioAnalyser = null;
let audioRafId = null;
let timerInterval = null;
let elapsedSeconds = 0;

// === DOM Refs ===
const authView = document.getElementById('auth-view');
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
const authEmail = document.getElementById('auth-email');
const authPassword = document.getElementById('auth-password');
const signinBtn = document.getElementById('signin-btn');
const signupBtn = document.getElementById('signup-btn');
const authError = document.getElementById('auth-error');
const userInfo = document.getElementById('user-info');
const userEmailEl = document.getElementById('user-email');
const signoutBtn = document.getElementById('signout-btn');

// === Init ===
document.addEventListener('DOMContentLoaded', async () => {
  // Always attach button listeners first
  startBtn.addEventListener('click', startRecording);
  pauseBtn.addEventListener('click', togglePause);
  stopBtn.addEventListener('click', stopRecording);
  downloadBtn.addEventListener('click', downloadRecording);
  uploadBtn.addEventListener('click', uploadRecording);
  discardBtn.addEventListener('click', discardRecording);
  signinBtn.addEventListener('click', handleSignIn);
  signupBtn.addEventListener('click', handleSignUp);
  signoutBtn.addEventListener('click', handleSignOut);

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
    recordingInfo.textContent = 'Saving to Screencast...';
    titleInput.style.display = 'none';
    downloadBtn.parentElement.style.display = 'none';
    discardBtn.style.display = 'none';
    return;
  }
  if (state && state.state === 'uploading') {
    elapsedSeconds = state.elapsed || 0;
    showView('done');
    recordingInfo.textContent = 'Saving to Screencast...';
    titleInput.style.display = 'none';
    downloadBtn.parentElement.style.display = 'none';
    discardBtn.style.display = 'none';
    return;
  }
  if (state && state.state === 'upload_failed') {
    elapsedSeconds = state.elapsed || 0;
    showView('done');
    showUploadFailed(state.uploadError || 'Upload failed');
    return;
  }

  // Check auth status
  const auth = await chrome.storage.local.get(['authToken', 'userId', 'userEmail']);
  if (auth.authToken && auth.userId) {
    // Logged in - show setup view
    showView('setup');
    showUserInfo(auth.userEmail || 'Signed in');
    await enumerateDevices();
    setupModeAndDeviceListeners();
  } else {
    // Not logged in - try sync from web app first
    const synced = await syncAuthFromWebApp();
    if (synced) {
      const auth2 = await chrome.storage.local.get(['userEmail']);
      showView('setup');
      showUserInfo(auth2.userEmail || 'Signed in');
      await enumerateDevices();
      setupModeAndDeviceListeners();
    } else {
      showView('auth');
    }
  }
});

function setupModeAndDeviceListeners() {
  document.querySelectorAll('.mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentMode = btn.dataset.mode;
    });
  });

  cameraSelect.addEventListener('change', () => {
    startCameraPreview(cameraSelect.value);
  });
  micSelect.addEventListener('change', () => {
    startAudioLevel(micSelect.value);
  });
}

function showUserInfo(email) {
  userEmailEl.textContent = email;
  userInfo.style.display = 'flex';
}

// === Auth: Sign In ===
async function handleSignIn() {
  const email = authEmail.value.trim();
  const password = authPassword.value;
  if (!email || !password) {
    showAuthError('Please enter email and password');
    return;
  }

  signinBtn.disabled = true;
  signinBtn.textContent = 'Signing in...';
  authError.style.display = 'none';

  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_ANON_KEY,
      },
      body: JSON.stringify({ email, password }),
    });

    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error_description || data.msg || 'Sign in failed');
    }

    await chrome.storage.local.set({
      authToken: data.access_token,
      refreshToken: data.refresh_token,
      userId: data.user.id,
      userEmail: data.user.email,
    });

    showView('setup');
    showUserInfo(data.user.email);
    await enumerateDevices();
    setupModeAndDeviceListeners();
  } catch (err) {
    showAuthError(err.message);
    signinBtn.disabled = false;
    signinBtn.textContent = 'Sign In';
  }
}

// === Auth: Sign Up ===
async function handleSignUp() {
  const email = authEmail.value.trim();
  const password = authPassword.value;
  if (!email || !password) {
    showAuthError('Please enter email and password');
    return;
  }
  if (password.length < 6) {
    showAuthError('Password must be at least 6 characters');
    return;
  }

  signupBtn.disabled = true;
  authError.style.display = 'none';

  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/signup`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_ANON_KEY,
      },
      body: JSON.stringify({ email, password }),
    });

    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error_description || data.msg || 'Sign up failed');
    }

    // Auto sign in after signup
    if (data.access_token) {
      await chrome.storage.local.set({
        authToken: data.access_token,
        refreshToken: data.refresh_token,
        userId: data.user.id,
        userEmail: data.user.email,
      });
      showView('setup');
      showUserInfo(data.user.email);
      await enumerateDevices();
      setupModeAndDeviceListeners();
    } else {
      showAuthError('Check your email to confirm your account, then sign in.');
      signupBtn.disabled = false;
    }
  } catch (err) {
    showAuthError(err.message);
    signupBtn.disabled = false;
  }
}

// === Auth: Sign Out ===
async function handleSignOut() {
  await chrome.storage.local.remove(['authToken', 'refreshToken', 'userId', 'userEmail']);
  userInfo.style.display = 'none';
  showView('auth');
}

function showAuthError(msg) {
  authError.textContent = msg;
  authError.style.display = 'block';
}

// === Device Enumeration (via offscreen document) ===
async function enumerateDevices() {
  try {
    const result = await sendMessage({ action: 'enumerateDevices' });

    if (!result || !result.success || (result.cameras.length === 0 && result.mics.length === 0)) {
      showPermissionPrompt();
      return;
    }

    const { cameras, mics } = result;
    hidePermissionPrompt();

    cameraSelect.innerHTML = '<option value="">No Camera</option>';
    cameras.forEach(cam => {
      const opt = document.createElement('option');
      opt.value = cam.deviceId;
      opt.textContent = cam.label;
      cameraSelect.appendChild(opt);
    });

    micSelect.innerHTML = '<option value="">No Microphone</option>';
    mics.forEach(mic => {
      const opt = document.createElement('option');
      opt.value = mic.deviceId;
      opt.textContent = mic.label;
      micSelect.appendChild(opt);
    });

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
    showPermissionPrompt();
  }
}

function showPermissionPrompt() {
  let banner = document.getElementById('permission-banner');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'permission-banner';
    banner.innerHTML = `
      <p style="margin:0 0 10px;font-size:13px;color:#ccc;">Camera & microphone access is needed for recording.</p>
      <button id="grant-permission-btn" style="
        width:100%;padding:10px;background:#e54545;color:#fff;border:none;
        border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;
      ">Grant Camera & Mic Access</button>
    `;
    banner.style.cssText = 'padding:12px 16px;background:#1a1a1a;border-radius:10px;margin:0 0 12px;text-align:center;';
    const firstSection = setupView.querySelector('.section');
    setupView.insertBefore(banner, firstSection);

    document.getElementById('grant-permission-btn').addEventListener('click', () => {
      chrome.tabs.create({ url: chrome.runtime.getURL('permissions/permissions.html') });
    });
  }
  banner.style.display = 'block';
}

function hidePermissionPrompt() {
  const banner = document.getElementById('permission-banner');
  if (banner) banner.style.display = 'none';
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
    // Show saving state (auto-upload happens in background)
    recordingInfo.textContent = 'Saving to Screencast...';
    titleInput.style.display = 'none';
    downloadBtn.parentElement.style.display = 'none';
    discardBtn.style.display = 'none';
  }
}

// === Download (direct from IndexedDB — no offscreen dependency) ===
async function downloadRecording() {
  const title = titleInput.value || generateTitle();
  downloadBtn.disabled = true;
  downloadBtn.textContent = 'Downloading...';

  // Try direct IDB download first (most reliable — same origin as offscreen)
  let blob = await loadBlobFromIDB();

  if (!blob) {
    // Fallback: try via offscreen document
    const result = await sendMessage({ action: 'downloadRecording', title });
    downloadBtn.disabled = false;
    downloadBtn.textContent = 'Download';
    if (result && !result.success) {
      recordingInfo.innerHTML = `<div style="color:#f87171;font-size:13px;">${result.error || 'Download failed'}</div>`;
    }
    return;
  }

  // Download blob directly from popup
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${title}.webm`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  downloadBtn.disabled = false;
  downloadBtn.textContent = 'Download';
}

function generateTitle() {
  const now = new Date();
  return 'Recording - ' + now.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) + ' ' + now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
}

// === IndexedDB access (popup shares same origin as offscreen) ===
function loadBlobFromIDB() {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open('screencast', 1);
      req.onupgradeneeded = (e) => { e.target.result.createObjectStore('blobs'); };
      req.onsuccess = (e) => {
        const db = e.target.result;
        const tx = db.transaction('blobs', 'readonly');
        const getReq = tx.objectStore('blobs').get('recording');
        getReq.onsuccess = () => { db.close(); resolve(getReq.result || null); };
        getReq.onerror = () => { db.close(); resolve(null); };
      };
      req.onerror = () => resolve(null);
    } catch { resolve(null); }
  });
}

// === Upload ===
async function uploadRecording() {
  // Check auth before upload
  const auth = await chrome.storage.local.get(['authToken', 'userId']);
  if (!auth.authToken || !auth.userId) {
    alert('Please sign in first to save recordings.');
    return;
  }

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
  const retryBtn = document.getElementById('retry-btn');
  if (retryBtn) retryBtn.remove();
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
    recordingInfo.textContent = 'Saving to Screencast...';
    titleInput.style.display = 'none';
    downloadBtn.parentElement.style.display = 'none';
    discardBtn.style.display = 'none';
    const rb = document.getElementById('retry-btn');
    if (rb) rb.style.display = 'none';
  }
  if (message.action === 'autoUploadComplete') {
    recordingInfo.textContent = 'Saved! Opening dashboard...';
    setTimeout(() => {
      chrome.tabs.create({ url: 'https://screencast-eight.vercel.app/dashboard' });
      window.close();
    }, 1000);
  }
  if (message.action === 'autoUploadFailed') {
    showUploadFailed(message.error || 'Upload failed');
  }
  if (message.action === 'recordingCancelled') {
    clearInterval(timerInterval);
    showView('setup');
    startBtn.disabled = false;
    startBtn.textContent = 'Start Recording';
    enumerateDevices();
  }
});

// === Upload Failed: Show retry/download/discard ===
function showUploadFailed(error) {
  recordingInfo.innerHTML = `
    <div style="color:#f87171;font-size:13px;margin-bottom:8px;">Upload failed: ${error}</div>
    <div style="color:#999;font-size:12px;">${formatTime(elapsedSeconds)} recorded</div>
  `;
  titleInput.style.display = '';
  if (!titleInput.value) titleInput.value = generateTitle();
  downloadBtn.parentElement.style.display = ''; // .done-actions div
  discardBtn.style.display = '';

  // Add retry button if not already present
  let retryBtn = document.getElementById('retry-btn');
  if (!retryBtn) {
    retryBtn = document.createElement('button');
    retryBtn.id = 'retry-btn';
    retryBtn.textContent = 'Retry Upload';
    retryBtn.className = 'primary-btn';
    retryBtn.style.cssText = 'width:100%;margin-bottom:8px;';
    retryBtn.addEventListener('click', retryUpload);
    // Insert before the .done-actions div
    const doneActions = downloadBtn.parentElement;
    doneActions.parentElement.insertBefore(retryBtn, doneActions);
  }
  retryBtn.style.display = '';
  retryBtn.disabled = false;
  retryBtn.textContent = 'Retry Upload';
}

async function retryUpload() {
  const retryBtn = document.getElementById('retry-btn');
  if (retryBtn) {
    retryBtn.disabled = true;
    retryBtn.textContent = 'Retrying...';
  }
  recordingInfo.textContent = 'Saving to Screencast...';
  titleInput.style.display = 'none';
  downloadBtn.parentElement.style.display = 'none';
  discardBtn.style.display = 'none';
  if (retryBtn) retryBtn.style.display = 'none';

  const result = await sendMessage({ action: 'retryUpload' });
  // If it fails, autoUploadFailed message will trigger showUploadFailed
  // If it succeeds, autoUploadComplete message will open dashboard
}

// === Helpers ===
function showView(view) {
  authView.style.display = view === 'auth' ? 'block' : 'none';
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
    if (stored.authToken && stored.userId) return true;

    const tabs = await chrome.tabs.query({ url: 'https://screencast-eight.vercel.app/*' });
    if (tabs.length === 0) return false;

    const results = await chrome.scripting.executeScript({
      target: { tabId: tabs[0].id },
      func: () => {
        const keys = Object.keys(localStorage);
        const authKey = keys.find(k => k.startsWith('sb-') && k.endsWith('-auth-token'));
        if (!authKey) return null;
        try {
          const data = JSON.parse(localStorage.getItem(authKey));
          return { accessToken: data.access_token, userId: data.user?.id, email: data.user?.email };
        } catch { return null; }
      },
    });

    const auth = results?.[0]?.result;
    if (auth && auth.accessToken && auth.userId) {
      await chrome.storage.local.set({
        authToken: auth.accessToken,
        userId: auth.userId,
        userEmail: auth.email || '',
      });
      return true;
    }
    return false;
  } catch {
    return false;
  }
}
