// Camera page - runs in extension's origin, so getUserMedia always has permission
const params = new URLSearchParams(location.search);
const deviceId = params.get('d');
const v = document.getElementById('v');
let currentStream = null;
let retryCount = 0;
const MAX_RETRIES = 8;
const RETRY_DELAYS = [300, 500, 700, 1000, 1500, 2000, 2500, 3000];

async function startCamera() {
  // Stop any existing stream first
  if (currentStream) {
    currentStream.getTracks().forEach(t => t.stop());
    currentStream = null;
    v.srcObject = null;
  }

  const constraints = deviceId
    ? { video: { deviceId: { exact: deviceId }, width: { ideal: 480 }, height: { ideal: 480 } } }
    : { video: { width: { ideal: 480 }, height: { ideal: 480 } } };

  // Try with specific device first, then fallback to any camera
  const attempts = [
    constraints,
    { video: { width: { ideal: 480 }, height: { ideal: 480 } } },
  ];

  for (const c of attempts) {
    try {
      currentStream = await navigator.mediaDevices.getUserMedia(c);
      v.srcObject = currentStream;
      showVideo();
      watchTracks();
      retryCount = 0; // Reset on success
      return;
    } catch {}
  }

  // All attempts failed — retry with backoff (camera might still be held by previous tab)
  if (retryCount < MAX_RETRIES) {
    showLoading();
    const delay = RETRY_DELAYS[retryCount] || 3000;
    retryCount++;
    setTimeout(startCamera, delay);
  } else {
    showFallback();
    retryCount = 0;
  }
}

function watchTracks() {
  if (!currentStream) return;
  currentStream.getVideoTracks().forEach(track => {
    track.addEventListener('ended', () => {
      retryCount = 0;
      startCamera();
    });
  });
}

function showVideo() {
  v.style.display = 'block';
  const fb = document.querySelector('.fallback');
  if (fb) fb.remove();
  const ld = document.querySelector('.loading');
  if (ld) ld.remove();
}

function showLoading() {
  v.style.display = 'none';
  if (!document.querySelector('.loading')) {
    const fb = document.querySelector('.fallback');
    if (fb) fb.remove();
    const div = document.createElement('div');
    div.className = 'loading';
    document.body.appendChild(div);
  }
}

function showFallback() {
  v.style.display = 'none';
  const ld = document.querySelector('.loading');
  if (ld) ld.remove();
  if (!document.querySelector('.fallback')) {
    const div = document.createElement('div');
    div.className = 'fallback';
    div.textContent = 'No camera';
    document.body.appendChild(div);
  }
}

function stopCamera() {
  if (currentStream) {
    currentStream.getTracks().forEach(t => t.stop());
    currentStream = null;
    v.srcObject = null;
  }
}

// Listen for stop signal from parent (removeBubble sends this before destroying iframe)
window.addEventListener('message', (e) => {
  if (e.data === 'stop-camera') {
    stopCamera();
  }
});

// Restart camera when tab becomes visible again
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    if (!currentStream || currentStream.getVideoTracks().every(t => t.readyState === 'ended')) {
      retryCount = 0;
      startCamera();
    }
  }
});

startCamera();
