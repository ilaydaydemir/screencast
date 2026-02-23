// Screencast - Offscreen Recording Engine
// Handles MediaRecorder, canvas compositing, audio mixing, download, and upload

// === Constants (matching web app) ===
const VIDEO_FRAME_RATE = 30;
const VIDEO_BITS_PER_SECOND = 2_500_000;
const SUPPORTED_MIME_TYPES = [
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
];
const SUPABASE_URL = 'https://bgsvuywxejpmkstgqizq.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJnc3Z1eXd4ZWpwbWtzdGdxaXpxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzE2MDc0MzMsImV4cCI6MjA4NzE4MzQzM30.EvHOy5sBbXzSxjRS5vPGzm8cnFrOXxDfclP-ru3VU_M';

// === State ===
let mediaRecorder = null;
let chunks = [];
let recordedBlob = null;
let screenStream = null;
let webcamStream = null;
let micStream = null;
let audioContext = null;
let rafId = null;
let keepAliveCtx = null;

// === IndexedDB: Persist blob so it survives offscreen document restarts ===
function saveBlobToIDB(blob) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('screencast', 1);
    req.onupgradeneeded = (e) => { e.target.result.createObjectStore('blobs'); };
    req.onsuccess = (e) => {
      const db = e.target.result;
      const tx = db.transaction('blobs', 'readwrite');
      tx.objectStore('blobs').put(blob, 'recording');
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    };
    req.onerror = () => reject(req.error);
  });
}

function loadBlobFromIDB() {
  return new Promise((resolve) => {
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
  });
}

function clearBlobFromIDB() {
  return new Promise((resolve) => {
    const req = indexedDB.open('screencast', 1);
    req.onupgradeneeded = (e) => { e.target.result.createObjectStore('blobs'); };
    req.onsuccess = (e) => {
      const db = e.target.result;
      const tx = db.transaction('blobs', 'readwrite');
      tx.objectStore('blobs').delete('recording');
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => { db.close(); resolve(); };
    };
    req.onerror = () => resolve();
  });
}

// === Keep Alive: play silent audio to prevent Chrome from closing offscreen ===
function startKeepAlive() {
  if (keepAliveCtx) return;
  keepAliveCtx = new AudioContext();
  const oscillator = keepAliveCtx.createOscillator();
  const gain = keepAliveCtx.createGain();
  gain.gain.value = 0.00001; // Silent
  oscillator.connect(gain);
  gain.connect(keepAliveCtx.destination);
  oscillator.start();
}

function stopKeepAlive() {
  if (keepAliveCtx) {
    keepAliveCtx.close().catch(() => {});
    keepAliveCtx = null;
  }
}

// === Message Handler ===
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target !== 'offscreen') return false;

  switch (message.action) {
    case 'startRecording':
      handleStart(message).then(r => sendResponse(r)).catch(e => sendResponse({ success: false, error: e.message }));
      return true;

    case 'stopRecording':
      handleStop().then(result => sendResponse(result));
      return true;

    case 'pauseRecording':
      if (mediaRecorder && mediaRecorder.state === 'recording') mediaRecorder.pause();
      sendResponse({ success: true });
      return false;

    case 'resumeRecording':
      if (mediaRecorder && mediaRecorder.state === 'paused') mediaRecorder.resume();
      sendResponse({ success: true });
      return false;

    case 'downloadRecording':
      handleDownload(message.title).then(() => sendResponse({ success: true }));
      return true;

    case 'uploadToWebApp':
      handleUpload(message).then(sendResponse);
      return true;

    case 'discardRecording':
      cleanup();
      stopKeepAlive();
      recordedBlob = null;
      chunks = [];
      clearBlobFromIDB().catch(() => {});
      sendResponse({ success: true });
      return false;

    case 'enumerateDevices':
      handleEnumerateDevices().then(sendResponse);
      return true;

    case 'keepAlive':
      // Just respond to keep the offscreen document alive
      sendResponse({ alive: true, hasRecording: !!mediaRecorder, hasBlob: !!recordedBlob });
      return false;
  }
});

// === Device Enumeration (runs in offscreen where getUserMedia works) ===
async function handleEnumerateDevices() {
  try {
    // Request permission to get labels and deviceIds
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      stream.getTracks().forEach(t => t.stop());
    } catch {
      try {
        const vs = await navigator.mediaDevices.getUserMedia({ video: true });
        vs.getTracks().forEach(t => t.stop());
      } catch {}
      try {
        const as = await navigator.mediaDevices.getUserMedia({ audio: true });
        as.getTracks().forEach(t => t.stop());
      } catch {}
    }

    const devices = await navigator.mediaDevices.enumerateDevices();
    const cameras = devices
      .filter(d => d.kind === 'videoinput' && d.deviceId)
      .map(d => ({ deviceId: d.deviceId, label: d.label || `Camera ${d.deviceId.slice(0, 8)}` }));
    const mics = devices
      .filter(d => d.kind === 'audioinput' && d.deviceId)
      .map(d => ({ deviceId: d.deviceId, label: d.label || `Microphone ${d.deviceId.slice(0, 8)}` }));

    return { success: true, cameras, mics };
  } catch (err) {
    return { success: false, cameras: [], mics: [], error: err.message };
  }
}

function getSupportedMimeType() {
  for (const mt of SUPPORTED_MIME_TYPES) {
    if (MediaRecorder.isTypeSupported(mt)) return mt;
  }
  return 'video/webm';
}

// === Start Recording ===
async function handleStart({ mode, tabCaptureStreamId, desktopStreamId, cameraId, micId }) {
  chunks = [];
  recordedBlob = null;

  if (mode === 'tab') {
    await startTabMode(tabCaptureStreamId, micId);
  } else if (mode === 'full-screen' || mode === 'window') {
    await startDesktopMode(desktopStreamId, cameraId, micId);
  } else if (mode === 'camera-only') {
    await startCameraOnlyMode(cameraId, micId);
  }

  return { success: true };
}

// === Tab Mode ===
async function startTabMode(streamId, micId) {
  // Get tab capture stream from streamId
  screenStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId,
      },
    },
    video: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId,
      },
    },
  });

  const compositeStream = new MediaStream();

  // Video from tab (includes the injected webcam bubble)
  screenStream.getVideoTracks().forEach(t => compositeStream.addTrack(t));

  // Mix audio: tab audio + mic
  audioContext = new AudioContext();
  const destination = audioContext.createMediaStreamDestination();

  if (screenStream.getAudioTracks().length > 0) {
    const tabSource = audioContext.createMediaStreamSource(
      new MediaStream(screenStream.getAudioTracks())
    );
    tabSource.connect(destination);
  }

  if (micId) {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { deviceId: { exact: micId } },
    });
    const micSource = audioContext.createMediaStreamSource(micStream);
    micSource.connect(destination);
  }

  destination.stream.getAudioTracks().forEach(t => compositeStream.addTrack(t));

  startMediaRecorder(compositeStream);
}

// === Desktop/Window Mode (Canvas Compositing) ===
async function startDesktopMode(streamId, cameraId, micId) {
  screenStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: 'desktop',
        chromeMediaSourceId: streamId,
      },
    },
    video: {
      mandatory: {
        chromeMediaSource: 'desktop',
        chromeMediaSourceId: streamId,
      },
    },
  });

  const screenVideo = document.getElementById('screen-video');
  screenVideo.srcObject = screenStream;
  await screenVideo.play();

  // Webcam for overlay
  const webcamVideo = document.getElementById('webcam-video');
  if (cameraId) {
    webcamStream = await navigator.mediaDevices.getUserMedia({
      video: { deviceId: { exact: cameraId }, width: { ideal: 480 }, height: { ideal: 480 } },
    });
    webcamVideo.srcObject = webcamStream;
    await webcamVideo.play();
  }

  // Canvas compositing
  const canvas = document.getElementById('composite-canvas');
  const videoTrack = screenStream.getVideoTracks()[0];
  const settings = videoTrack?.getSettings();
  const cw = settings?.width || 1920;
  const ch = settings?.height || 1080;
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext('2d');

  const webcamSize = 150;
  const webcamMargin = 20;

  function drawFrame() {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, cw, ch);

    if (screenVideo.readyState >= 2) {
      ctx.drawImage(screenVideo, 0, 0, cw, ch);
    }

    if (webcamVideo.readyState >= 2 && cameraId) {
      const cx = cw - webcamMargin - webcamSize / 2;
      const cy = ch - webcamMargin - webcamSize / 2;

      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, webcamSize / 2, 0, Math.PI * 2);
      ctx.closePath();
      ctx.clip();
      ctx.drawImage(webcamVideo, cx - webcamSize / 2, cy - webcamSize / 2, webcamSize, webcamSize);
      ctx.restore();

      ctx.beginPath();
      ctx.arc(cx, cy, webcamSize / 2, 0, Math.PI * 2);
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 3;
      ctx.stroke();
    }

    rafId = requestAnimationFrame(drawFrame);
  }
  drawFrame();

  // Composite stream
  const canvasStream = canvas.captureStream(VIDEO_FRAME_RATE);
  const compositeStream = new MediaStream();
  canvasStream.getVideoTracks().forEach(t => compositeStream.addTrack(t));

  // Audio mixing
  audioContext = new AudioContext();
  const destination = audioContext.createMediaStreamDestination();

  if (screenStream.getAudioTracks().length > 0) {
    const screenSource = audioContext.createMediaStreamSource(
      new MediaStream(screenStream.getAudioTracks())
    );
    screenSource.connect(destination);
  }

  if (micId) {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { deviceId: { exact: micId } },
    });
    const micSource = audioContext.createMediaStreamSource(micStream);
    micSource.connect(destination);
  }

  destination.stream.getAudioTracks().forEach(t => compositeStream.addTrack(t));

  startMediaRecorder(compositeStream);
}

// === Camera Only ===
async function startCameraOnlyMode(cameraId, micId) {
  const constraints = {};
  if (cameraId) constraints.video = { deviceId: { exact: cameraId }, width: { ideal: 1280 }, height: { ideal: 720 } };
  if (micId) constraints.audio = { deviceId: { exact: micId } };

  webcamStream = await navigator.mediaDevices.getUserMedia(constraints);
  startMediaRecorder(webcamStream);
}

// === MediaRecorder ===
let stopResolve = null;

function startMediaRecorder(stream) {
  startKeepAlive(); // Prevent Chrome from closing offscreen document

  const mimeType = getSupportedMimeType();
  mediaRecorder = new MediaRecorder(stream, {
    mimeType,
    videoBitsPerSecond: VIDEO_BITS_PER_SECOND,
  });

  mediaRecorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };

  mediaRecorder.onstop = async () => {
    recordedBlob = new Blob(chunks, { type: mimeType });
    const blobSize = recordedBlob.size;

    // Persist to IndexedDB so blob survives if offscreen is closed
    try { await saveBlobToIDB(recordedBlob); } catch {}

    cleanup();
    chrome.runtime.sendMessage({
      action: 'recordingStopped',
      blobSize,
    }).catch(() => {});
    // Resolve the stop promise if someone is waiting
    if (stopResolve) {
      stopResolve({ success: true, blobSize });
      stopResolve = null;
    }
  };

  mediaRecorder.start(1000);
}

// === Stop ===
function handleStop() {
  return new Promise((resolve) => {
    if (!mediaRecorder || mediaRecorder.state === 'inactive') {
      resolve({ success: true, blobSize: recordedBlob?.size || 0 });
      return;
    }
    stopResolve = resolve;
    mediaRecorder.stop();
  });
}

// === Download ===
async function handleDownload(title) {
  let blob = recordedBlob;
  if (!blob) {
    blob = await loadBlobFromIDB();
    if (blob) recordedBlob = blob;
  }
  if (!blob) return;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${title || 'recording'}.webm`;
  a.click();
  URL.revokeObjectURL(url);
}

// === Upload to Supabase ===
async function handleUpload({ title, duration, mode }) {
  // Try loading from IndexedDB if blob was lost (offscreen restarted)
  if (!recordedBlob) {
    recordedBlob = await loadBlobFromIDB();
  }
  if (!recordedBlob) return { success: false, error: 'No recording' };

  // Get auth from web app
  const auth = await getWebAppAuth();
  if (!auth) {
    return { success: false, error: 'Not logged in. Please sign in at screencast-eight.vercel.app first.' };
  }

  const headers = {
    'apikey': SUPABASE_ANON_KEY,
    'Authorization': `Bearer ${auth.accessToken}`,
    'Content-Type': 'application/json',
  };

  try {
    // 1. Insert recording row
    sendProgress(10);
    const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/recordings`, {
      method: 'POST',
      headers: { ...headers, 'Prefer': 'return=representation' },
      body: JSON.stringify({
        user_id: auth.userId,
        title: title || 'Untitled Recording',
        duration: duration || 0,
        file_size: recordedBlob.size,
        mime_type: recordedBlob.type || 'video/webm',
        recording_mode: mode === 'camera-only' ? 'camera_only' : 'screen',
        status: 'processing',
      }),
    });

    if (!insertRes.ok) throw new Error('Failed to create recording');
    const [recording] = await insertRes.json();
    sendProgress(20);

    // 2. Upload video
    const videoPath = `${auth.userId}/${recording.id}.webm`;
    const uploadRes = await fetch(`${SUPABASE_URL}/storage/v1/object/recordings/${videoPath}`, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${auth.accessToken}`,
        'Content-Type': 'video/webm',
      },
      body: recordedBlob,
    });

    if (!uploadRes.ok) throw new Error('Failed to upload video');
    sendProgress(70);

    // 3. Generate + upload thumbnail
    let thumbnailPath = null;
    try {
      const thumbBlob = await generateThumbnail(recordedBlob);
      if (thumbBlob) {
        thumbnailPath = `${auth.userId}/${recording.id}-thumb.png`;
        await fetch(`${SUPABASE_URL}/storage/v1/object/recordings/${thumbnailPath}`, {
          method: 'POST',
          headers: {
            'apikey': SUPABASE_ANON_KEY,
            'Authorization': `Bearer ${auth.accessToken}`,
            'Content-Type': 'image/png',
          },
          body: thumbBlob,
        });
      }
    } catch { /* thumbnail optional */ }
    sendProgress(85);

    // 4. Update recording status
    await fetch(`${SUPABASE_URL}/rest/v1/recordings?id=eq.${recording.id}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({
        storage_path: videoPath,
        thumbnail_path: thumbnailPath,
        status: 'ready',
      }),
    });

    sendProgress(100);
    stopKeepAlive(); // Upload done, safe to let Chrome close offscreen
    recordedBlob = null;
    chunks = [];
    return { success: true, recordingId: recording.id };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// === Auth: Read from web app ===
async function getWebAppAuth() {
  // Check stored auth first
  const stored = await chrome.storage.local.get(['authToken', 'userId']);
  if (stored.authToken && stored.userId) {
    return { accessToken: stored.authToken, userId: stored.userId };
  }
  return null;
}

// === Thumbnail Generation ===
function generateThumbnail(blob) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const video = document.createElement('video');
    video.src = url;
    video.muted = true;
    video.onloadeddata = () => { video.currentTime = Math.max(0.1, video.duration * 0.1); };
    video.onseeked = () => {
      const canvas = document.createElement('canvas');
      canvas.width = 640;
      canvas.height = 360;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(video, 0, 0, 640, 360);
      canvas.toBlob((b) => {
        URL.revokeObjectURL(url);
        resolve(b);
      }, 'image/png');
    };
    video.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
    setTimeout(() => { URL.revokeObjectURL(url); resolve(null); }, 5000);
  });
}

// === Helpers ===
function sendProgress(progress) {
  chrome.runtime.sendMessage({ action: 'uploadProgress', progress }).catch(() => {});
}

function cleanup() {
  // NOTE: Do NOT call stopKeepAlive() here - we need the offscreen document
  // alive for download/upload after recording stops. It's stopped on discard.
  if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
  if (screenStream) { screenStream.getTracks().forEach(t => t.stop()); screenStream = null; }
  if (webcamStream) { webcamStream.getTracks().forEach(t => t.stop()); webcamStream = null; }
  if (micStream) { micStream.getTracks().forEach(t => t.stop()); micStream = null; }
  if (audioContext) { audioContext.close().catch(() => {}); audioContext = null; }
  mediaRecorder = null;
}
