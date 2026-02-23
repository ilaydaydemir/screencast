// Screencast - Recorder Tab Engine (replaces offscreen.js)
// Runs in a pinned tab — Chrome never kills visible tabs.
// Handles MediaRecorder, canvas compositing, audio mixing, download, upload,
// and progressive chunk upload to Supabase Storage.

// === Constants ===
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
const UPLOAD_BATCH_SIZE = 5;

// === State ===
let mediaRecorder = null;
let chunks = [];
let recordedBlob = null;
let screenStream = null;
let webcamStream = null;
let micStream = null;
let audioContext = null;
let rafId = null;
let currentMimeType = 'video/webm';
let chunkIndex = 0;
let currentRecordingId = null;
let currentUserId = null;
let currentAuthToken = null;

// === Progressive Upload State ===
let uploadQueue = [];       // chunks waiting to be uploaded
let uploadedCount = 0;      // number of chunks successfully uploaded to server
let uploadFailed = false;   // if true, skip progressive upload, fall back to full blob
let isUploading = false;    // prevent concurrent flush operations

// === Port connection to service worker (keeps SW alive) ===
let swPort = null;
function connectPort() {
  swPort = chrome.runtime.connect({ name: 'recorder' });
  swPort.onDisconnect.addListener(() => {
    // Reconnect if disconnected (e.g., SW restarts)
    setTimeout(connectPort, 1000);
  });
}
connectPort();

// === IndexedDB: Fresh connection per operation ===
function saveChunkToIDB(index, chunk, mimeType) {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open('screencast', 1);
      req.onupgradeneeded = (e) => { e.target.result.createObjectStore('blobs'); };
      req.onsuccess = (e) => {
        const db = e.target.result;
        try {
          const tx = db.transaction('blobs', 'readwrite');
          const store = tx.objectStore('blobs');
          store.put(chunk, `chunk-${index}`);
          store.put({ count: index + 1, mimeType }, 'chunk-meta');
          tx.oncomplete = () => {
            console.log(`[Screencast IDB] Saved chunk-${index} (${chunk.size} bytes)`);
            db.close();
            resolve();
          };
          tx.onerror = (err) => {
            console.error(`[Screencast IDB] Chunk-${index} tx error:`, err);
            db.close();
            resolve();
          };
        } catch (e2) {
          console.error(`[Screencast IDB] Chunk-${index} exception:`, e2);
          db.close();
          resolve();
        }
      };
      req.onerror = (e) => {
        console.error(`[Screencast IDB] Open failed for chunk-${index}:`, e);
        resolve();
      };
    } catch (e3) {
      console.error(`[Screencast IDB] Outer exception for chunk-${index}:`, e3);
      resolve();
    }
  });
}

function saveFinalBlobToIDB(blob) {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open('screencast', 1);
      req.onupgradeneeded = (e) => { e.target.result.createObjectStore('blobs'); };
      req.onsuccess = (e) => {
        const db = e.target.result;
        try {
          const tx = db.transaction('blobs', 'readwrite');
          tx.objectStore('blobs').put(blob, 'recording');
          tx.oncomplete = () => {
            console.log(`[Screencast IDB] Saved final blob (${blob.size} bytes)`);
            db.close();
            resolve();
          };
          tx.onerror = () => { db.close(); resolve(); };
        } catch { db.close(); resolve(); }
      };
      req.onerror = () => resolve();
    } catch { resolve(); }
  });
}

function clearIDB() {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open('screencast', 1);
      req.onupgradeneeded = (e) => { e.target.result.createObjectStore('blobs'); };
      req.onsuccess = (e) => {
        const db = e.target.result;
        try {
          const tx = db.transaction('blobs', 'readwrite');
          tx.objectStore('blobs').clear();
          tx.oncomplete = () => {
            console.log('[Screencast IDB] Cleared all data');
            db.close();
            resolve();
          };
          tx.onerror = () => { db.close(); resolve(); };
        } catch { db.close(); resolve(); }
      };
      req.onerror = () => resolve();
    } catch { resolve(); }
  });
}

function idbGet(key) {
  return new Promise((resolve) => {
    try {
      const openReq = indexedDB.open('screencast', 1);
      openReq.onupgradeneeded = (e) => { e.target.result.createObjectStore('blobs'); };
      openReq.onsuccess = (e) => {
        const db = e.target.result;
        try {
          const tx = db.transaction('blobs', 'readonly');
          const getReq = tx.objectStore('blobs').get(key);
          getReq.onsuccess = () => { db.close(); resolve(getReq.result || null); };
          getReq.onerror = () => { db.close(); resolve(null); };
        } catch { db.close(); resolve(null); }
      };
      openReq.onerror = () => resolve(null);
    } catch { resolve(null); }
  });
}

async function reconstructFromChunks() {
  const meta = await idbGet('chunk-meta');
  console.log('[Screencast] chunk-meta:', meta);
  if (!meta || !meta.count) return null;

  const parts = [];
  for (let i = 0; i < meta.count; i++) {
    const chunk = await idbGet(`chunk-${i}`);
    if (chunk) parts.push(chunk);
    else { console.log(`[Screencast] Missing chunk-${i}, stopping`); break; }
  }

  if (parts.length === 0) return null;
  console.log(`[Screencast] Reconstructed recording from ${parts.length}/${meta.count} chunks`);
  return new Blob(parts, { type: meta.mimeType || 'video/webm' });
}

async function loadRecording() {
  if (recordedBlob) {
    console.log('[Screencast] loadRecording: from memory');
    return recordedBlob;
  }

  const final = await idbGet('recording');
  if (final) {
    console.log('[Screencast] loadRecording: from IDB final blob');
    recordedBlob = final;
    return final;
  }

  const reconstructed = await reconstructFromChunks();
  if (reconstructed) {
    console.log('[Screencast] loadRecording: reconstructed from IDB chunks');
    recordedBlob = reconstructed;
    return reconstructed;
  }

  console.log('[Screencast] loadRecording: NO DATA FOUND');
  return null;
}

// === Progressive Chunk Upload ===
async function flushUploadQueue() {
  if (isUploading || uploadFailed || !currentRecordingId || !currentUserId || !currentAuthToken) return;
  if (uploadQueue.length === 0) return;

  isUploading = true;
  const batch = uploadQueue.splice(0, UPLOAD_BATCH_SIZE);

  for (const item of batch) {
    const chunkName = `chunk-${String(item.index).padStart(6, '0')}.webm`;
    const path = `${currentUserId}/${currentRecordingId}/chunks/${chunkName}`;

    try {
      const res = await fetch(`${SUPABASE_URL}/storage/v1/object/recordings/${path}`, {
        method: 'POST',
        headers: {
          'apikey': SUPABASE_ANON_KEY,
          'Authorization': `Bearer ${currentAuthToken}`,
          'Content-Type': 'video/webm',
        },
        body: item.data,
      });

      if (!res.ok) {
        const errBody = await res.text().catch(() => '');
        console.error(`[Screencast] Chunk upload failed (${res.status}): ${errBody}`);
        // Put failed items back and mark upload as failed
        uploadQueue.unshift(...batch.filter(b => b.index >= item.index));
        uploadFailed = true;
        isUploading = false;
        return;
      }

      uploadedCount++;
      console.log(`[Screencast] Uploaded chunk ${item.index} → ${path}`);
    } catch (err) {
      console.error(`[Screencast] Chunk upload error:`, err);
      uploadQueue.unshift(...batch.filter(b => b.index >= item.index));
      uploadFailed = true;
      isUploading = false;
      return;
    }
  }

  isUploading = false;

  // If more chunks queued while we were uploading, flush again
  if (uploadQueue.length >= UPLOAD_BATCH_SIZE) {
    flushUploadQueue();
  }
}

// === Message Handler ===
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target !== 'recorder') return false;

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
      recordedBlob = null;
      chunks = [];
      chunkIndex = 0;
      uploadQueue = [];
      uploadedCount = 0;
      uploadFailed = false;
      currentRecordingId = null;
      clearIDB();
      sendResponse({ success: true });
      return false;

    case 'enumerateDevices':
      handleEnumerateDevices().then(sendResponse);
      return true;

    case 'keepAlive':
      sendResponse({ alive: true, hasRecording: !!mediaRecorder, hasBlob: !!recordedBlob });
      return false;
  }
});

// === Device Enumeration ===
async function handleEnumerateDevices() {
  try {
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
async function handleStart({ mode, tabCaptureStreamId, desktopStreamId, cameraId, micId, recordingId, userId, authToken }) {
  chunks = [];
  recordedBlob = null;
  uploadQueue = [];
  uploadedCount = 0;
  uploadFailed = false;
  currentRecordingId = recordingId || null;
  currentUserId = userId || null;
  currentAuthToken = authToken || null;

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
  screenStream.getVideoTracks().forEach(t => compositeStream.addTrack(t));

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
  await startMediaRecorder(compositeStream);
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

  const webcamVideo = document.getElementById('webcam-video');
  if (cameraId) {
    webcamStream = await navigator.mediaDevices.getUserMedia({
      video: { deviceId: { exact: cameraId }, width: { ideal: 480 }, height: { ideal: 480 } },
    });
    webcamVideo.srcObject = webcamStream;
    await webcamVideo.play();
  }

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

  const canvasStream = canvas.captureStream(VIDEO_FRAME_RATE);
  const compositeStream = new MediaStream();
  canvasStream.getVideoTracks().forEach(t => compositeStream.addTrack(t));

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
  await startMediaRecorder(compositeStream);
}

// === Camera Only ===
async function startCameraOnlyMode(cameraId, micId) {
  const constraints = {};
  if (cameraId) constraints.video = { deviceId: { exact: cameraId }, width: { ideal: 1280 }, height: { ideal: 720 } };
  if (micId) constraints.audio = { deviceId: { exact: micId } };

  webcamStream = await navigator.mediaDevices.getUserMedia(constraints);
  await startMediaRecorder(webcamStream);
}

// === MediaRecorder ===
let stopResolve = null;

async function startMediaRecorder(stream) {
  const mimeType = getSupportedMimeType();
  currentMimeType = mimeType;
  chunkIndex = 0;

  await clearIDB();

  // Verify IDB works
  try {
    await new Promise((resolve, reject) => {
      const req = indexedDB.open('screencast', 1);
      req.onupgradeneeded = (e) => { e.target.result.createObjectStore('blobs'); };
      req.onsuccess = (e) => {
        const db = e.target.result;
        const tx = db.transaction('blobs', 'readwrite');
        tx.objectStore('blobs').put('test', '_idb_test');
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => { db.close(); reject(new Error('IDB test write failed')); };
      };
      req.onerror = () => reject(new Error('IDB open failed'));
    });
    console.log('[Screencast] IDB test write OK');
  } catch (idbErr) {
    console.error('[Screencast] IDB NOT WORKING:', idbErr);
  }

  mediaRecorder = new MediaRecorder(stream, {
    mimeType,
    videoBitsPerSecond: VIDEO_BITS_PER_SECOND,
  });

  mediaRecorder.ondataavailable = (e) => {
    if (e.data.size > 0) {
      chunks.push(e.data);
      const idx = chunkIndex++;

      // Save to IDB (safety net)
      saveChunkToIDB(idx, e.data, mimeType);

      // Add to progressive upload queue
      if (!uploadFailed && currentRecordingId) {
        uploadQueue.push({ index: idx, data: e.data });

        // Flush every UPLOAD_BATCH_SIZE chunks
        if (uploadQueue.length >= UPLOAD_BATCH_SIZE) {
          flushUploadQueue();
        }
      }
    }
  };

  mediaRecorder.onstop = async () => {
    recordedBlob = new Blob(chunks, { type: mimeType });
    const blobSize = recordedBlob.size;
    console.log(`[Screencast] Recording stopped: ${blobSize} bytes, ${chunks.length} chunks`);

    try { await saveFinalBlobToIDB(recordedBlob); } catch (e) {
      console.error('[Screencast] saveFinalBlobToIDB failed:', e);
    }

    // Flush remaining upload queue
    if (!uploadFailed && currentRecordingId && uploadQueue.length > 0) {
      await flushUploadQueue();
    }

    cleanup();
    chrome.runtime.sendMessage({
      action: 'recordingStopped',
      blobSize,
      progressiveUploadOk: !uploadFailed && currentRecordingId && uploadedCount > 0,
      uploadedChunks: uploadedCount,
      totalChunks: chunkIndex,
    }).catch(() => {});
    if (stopResolve) {
      stopResolve({
        success: true,
        blobSize,
        progressiveUploadOk: !uploadFailed && currentRecordingId && uploadedCount > 0,
        uploadedChunks: uploadedCount,
        totalChunks: chunkIndex,
      });
      stopResolve = null;
    }
  };

  console.log(`[Screencast] MediaRecorder started (${mimeType}), progressive upload ${currentRecordingId ? 'enabled' : 'disabled'}`);
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
  const blob = await loadRecording();
  if (!blob) return;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${title || 'recording'}.webm`;
  a.click();
  URL.revokeObjectURL(url);
}

// === Upload to Supabase (full blob — fallback when progressive upload fails) ===
async function handleUpload({ title, duration, mode }) {
  const blob = await loadRecording();
  if (!blob) return { success: false, error: 'No recording found in memory or IDB' };
  recordedBlob = blob;
  console.log(`[Screencast] Upload starting: ${blob.size} bytes`);

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
    sendProgress(10);

    // Use existing recording row if we have one, otherwise create new
    let recordingId = currentRecordingId;
    if (!recordingId) {
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

      if (!insertRes.ok) {
        const errBody = await insertRes.text().catch(() => '');
        throw new Error(`DB insert failed (${insertRes.status}): ${errBody}`);
      }
      const [recording] = await insertRes.json();
      recordingId = recording.id;
    } else {
      // Update existing row with title/duration/file_size
      await fetch(`${SUPABASE_URL}/rest/v1/recordings?id=eq.${recordingId}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({
          title: title || 'Untitled Recording',
          duration: duration || 0,
          file_size: recordedBlob.size,
        }),
      });
    }
    sendProgress(20);

    // Upload video
    const videoPath = `${auth.userId}/${recordingId}.webm`;
    const uploadRes = await fetch(`${SUPABASE_URL}/storage/v1/object/recordings/${videoPath}`, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${auth.accessToken}`,
        'Content-Type': 'video/webm',
      },
      body: recordedBlob,
    });

    if (!uploadRes.ok) {
      const errBody = await uploadRes.text().catch(() => '');
      throw new Error(`Storage upload failed (${uploadRes.status}): ${errBody}`);
    }
    sendProgress(70);

    // Generate + upload thumbnail
    let thumbnailPath = null;
    try {
      const thumbBlob = await generateThumbnail(recordedBlob);
      if (thumbBlob) {
        thumbnailPath = `${auth.userId}/${recordingId}-thumb.png`;
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

    // Update recording status
    await fetch(`${SUPABASE_URL}/rest/v1/recordings?id=eq.${recordingId}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({
        storage_path: videoPath,
        thumbnail_path: thumbnailPath,
        status: 'ready',
      }),
    });

    sendProgress(100);
    recordedBlob = null;
    chunks = [];
    uploadQueue = [];
    currentRecordingId = null;
    clearIDB();
    return { success: true, recordingId };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// === Auth ===
async function getWebAppAuth() {
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
  if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
  if (screenStream) { screenStream.getTracks().forEach(t => t.stop()); screenStream = null; }
  if (webcamStream) { webcamStream.getTracks().forEach(t => t.stop()); webcamStream = null; }
  if (micStream) { micStream.getTracks().forEach(t => t.stop()); micStream = null; }
  if (audioContext) { audioContext.close().catch(() => {}); audioContext = null; }
  mediaRecorder = null;
}
