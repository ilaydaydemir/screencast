// Desktop/Window screen recorder — injected on the active tab.
// Has user activation propagated from popup click, so getDisplayMedia() works.
// Records the screen stream directly (no canvas compositing needed).

(async () => {
  // Guard against double injection
  if (window._screencastDesktopRecorderActive) {
    console.warn('[DesktopRec] Already active, skipping duplicate injection');
    return;
  }
  window._screencastDesktopRecorderActive = true;

  // IDB helpers — content scripts share the extension's IDB origin
  let _idbChunkIndex = 0;
  function idbSaveChunk(index, chunk, mimeType) {
    return new Promise((resolve) => {
      try {
        const req = indexedDB.open('screencast', 1);
        req.onupgradeneeded = (e) => { e.target.result.createObjectStore('blobs'); };
        req.onsuccess = (e) => {
          const db = e.target.result;
          const tx = db.transaction('blobs', 'readwrite');
          const store = tx.objectStore('blobs');
          store.put(chunk, `chunk-${index}`);
          store.put({ count: index + 1, mimeType }, 'chunk-meta');
          tx.oncomplete = () => { db.close(); resolve(); };
          tx.onerror = () => { db.close(); resolve(); };
        };
        req.onerror = () => resolve();
      } catch { resolve(); }
    });
  }
  function idbSaveFinalBlob(blob) {
    return new Promise((resolve) => {
      try {
        const req = indexedDB.open('screencast', 1);
        req.onupgradeneeded = (e) => { e.target.result.createObjectStore('blobs'); };
        req.onsuccess = (e) => {
          const db = e.target.result;
          const tx = db.transaction('blobs', 'readwrite');
          tx.objectStore('blobs').put(blob, 'recording');
          tx.oncomplete = () => { db.close(); resolve(); };
          tx.onerror = () => { db.close(); resolve(); };
        };
        req.onerror = () => resolve();
      } catch { resolve(); }
    });
  }
  function idbClear() {
    return new Promise((resolve) => {
      try {
        const req = indexedDB.open('screencast', 1);
        req.onupgradeneeded = (e) => { e.target.result.createObjectStore('blobs'); };
        req.onsuccess = (e) => {
          const db = e.target.result;
          const tx = db.transaction('blobs', 'readwrite');
          tx.objectStore('blobs').clear();
          tx.oncomplete = () => { db.close(); resolve(); };
          tx.onerror = () => { db.close(); resolve(); };
        };
        req.onerror = () => resolve();
      } catch { resolve(); }
    });
  }
  await idbClear();
  const SUPABASE_URL = 'https://bgsvuywxejpmkstgqizq.supabase.co';
  const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJnc3Z1eXd4ZWpwbWtzdGdxaXpxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzE2MDc0MzMsImV4cCI6MjA4NzE4MzQzM30.EvHOy5sBbXzSxjRS5vPGzm8cnFrOXxDfclP-ru3VU_M';
  const SUPPORTED_MIME_TYPES = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm',
  ];

  // Read config stored by the popup before injection
  const { desktopRecordConfig: config } = await chrome.storage.session.get('desktopRecordConfig');
  if (!config) {
    console.error('[DesktopRec] No config found');
    return;
  }
  const { mode, cameraId, micId, recordingId, userId, authToken } = config;

  // --- Wait for tab to become visible (injected as background tab from internal page) ---
  if (document.visibilityState !== 'visible') {
    await new Promise(resolve => {
      document.addEventListener('visibilitychange', function handler() {
        if (document.visibilityState === 'visible') {
          document.removeEventListener('visibilitychange', handler);
          resolve();
        }
      });
    });
  }

  // --- Get screen stream (has user activation from popup click) ---
  let screenStream = null;

  if (mode !== 'camera-only') {
    try {
      const constraints = { audio: true, surfaceSwitching: 'include' };
      if (mode === 'tab') {
        // Prefer current tab — Chrome shows a "Share this tab?" dialog
        constraints.preferCurrentTab = true;
        constraints.video = true;
        constraints.selfBrowserSurface = 'include';
      } else if (mode === 'window') {
        constraints.preferCurrentTab = false;
        constraints.video = { displaySurface: 'window' };
        constraints.selfBrowserSurface = 'exclude';
      } else {
        // full-screen
        constraints.preferCurrentTab = false;
        constraints.video = { displaySurface: 'monitor' };
        constraints.selfBrowserSurface = 'exclude';
      }
      screenStream = await navigator.mediaDevices.getDisplayMedia(constraints);
    } catch (err) {
      console.error('[DesktopRec] getDisplayMedia failed:', err);
      window._screencastDesktopRecorderActive = false;
      chrome.runtime.sendMessage({ action: 'desktopRecordingFailed', error: err.message });
      return;
    }
    const videoTrack = screenStream.getVideoTracks()[0];
    const trackSettings = videoTrack.getSettings();
    console.log('[DesktopRec] Capture type:', trackSettings.displaySurface,
      'dimensions:', trackSettings.width, 'x', trackSettings.height,
      'frameRate:', trackSettings.frameRate);
  }

  // --- Get camera stream (camera-only mode, or for overlay reference) ---
  let cameraStream = null;
  if (mode === 'camera-only' && cameraId) {
    try {
      cameraStream = await navigator.mediaDevices.getUserMedia({
        video: { deviceId: { exact: cameraId } },
        audio: false,
      });
    } catch (err) {
      console.warn('[DesktopRec] Camera failed:', err.message);
    }
  }

  if (mode === 'camera-only' && !cameraStream) {
    // No camera available — abort
    window._screencastDesktopRecorderActive = false;
    chrome.runtime.sendMessage({ action: 'desktopRecordingFailed', error: 'No camera available for Camera Only mode.' });
    return;
  }

  // --- Get mic stream ---
  let micStream = null;
  if (micId) {
    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: { deviceId: { exact: micId } },
      });
    } catch (err) {
      console.warn('[DesktopRec] Mic failed, continuing without:', err.message);
    }
  }

  // --- Mix audio (system audio + mic) ---
  const audioContext = new AudioContext();
  const destination = audioContext.createMediaStreamDestination();

  if (screenStream && screenStream.getAudioTracks().length > 0) {
    const screenSource = audioContext.createMediaStreamSource(
      new MediaStream(screenStream.getAudioTracks())
    );
    screenSource.connect(destination);
  }

  if (micStream) {
    const micSource = audioContext.createMediaStreamSource(micStream);
    micSource.connect(destination);
  }

  // --- Composite stream ---
  const compositeStream = new MediaStream();
  if (mode === 'camera-only') {
    cameraStream.getVideoTracks().forEach(t => compositeStream.addTrack(t));
  } else {
    screenStream.getVideoTracks().forEach(t => compositeStream.addTrack(t));
  }
  destination.stream.getAudioTracks().forEach(t => compositeStream.addTrack(t));

  // --- MediaRecorder ---
  let mimeType = 'video/webm';
  for (const mt of SUPPORTED_MIME_TYPES) {
    if (MediaRecorder.isTypeSupported(mt)) { mimeType = mt; break; }
  }

  const recorder = new MediaRecorder(compositeStream, {
    mimeType,
    videoBitsPerSecond: 2_500_000,
  });

  const chunks = [];
  const startTime = Date.now();
  let chunkCount = 0;

  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) {
      chunks.push(e.data);
      chunkCount++;
      // Save every chunk to IDB so data survives tab navigation
      idbSaveChunk(_idbChunkIndex++, e.data, mimeType);
      if (chunkCount % 5 === 0) {
        console.log(`[DesktopRec] Chunk ${chunkCount}, size: ${e.data.size}, total: ${chunks.reduce((s, c) => s + c.size, 0)}`);
      }
    }
  };

  recorder.onstop = async () => {
    const blob = new Blob(chunks, { type: mimeType });
    console.log('[DesktopRec] Recording stopped, blob size:', blob.size);
    // Stop media tracks (but keep keepalive port open during upload)
    if (screenStream) screenStream.getTracks().forEach(t => t.stop());
    if (cameraStream) cameraStream.getTracks().forEach(t => t.stop());
    if (micStream) micStream.getTracks().forEach(t => t.stop());
    audioContext.close().catch(() => {});

    if (blob.size === 0) {
      cleanup();
      chrome.runtime.sendMessage({ action: 'desktopRecordingComplete', success: false, error: 'Empty recording' });
      return;
    }

    // Save final blob to IDB before upload (recovery safety net)
    await idbSaveFinalBlob(blob);

    // Upload to Supabase Storage
    try {
      chrome.runtime.sendMessage({ action: 'uploadProgress', progress: 10 });
      const videoPath = `${userId}/${recordingId}.webm`;
      const uploadRes = await fetch(`${SUPABASE_URL}/storage/v1/object/recordings/${videoPath}`, {
        method: 'POST',
        headers: {
          'apikey': SUPABASE_ANON_KEY,
          'Authorization': `Bearer ${authToken}`,
          'Content-Type': 'video/webm',
          'x-upsert': 'true',
        },
        body: blob,
      });

      if (!uploadRes.ok) {
        const errBody = await uploadRes.text().catch(() => '');
        throw new Error(`Upload failed (${uploadRes.status}): ${errBody}`);
      }
      chrome.runtime.sendMessage({ action: 'uploadProgress', progress: 70 });

      // Generate thumbnail
      let thumbnailPath = null;
      try {
        const thumbBlob = await generateThumbnail(blob);
        if (thumbBlob) {
          thumbnailPath = `${userId}/${recordingId}-thumb.png`;
          await fetch(`${SUPABASE_URL}/storage/v1/object/recordings/${thumbnailPath}`, {
            method: 'POST',
            headers: {
              'apikey': SUPABASE_ANON_KEY,
              'Authorization': `Bearer ${authToken}`,
              'Content-Type': 'image/png',
              'x-upsert': 'true',
            },
            body: thumbBlob,
          });
        }
      } catch { /* thumbnail optional */ }
      chrome.runtime.sendMessage({ action: 'uploadProgress', progress: 85 });

      // Update recording row
      const duration = Math.round((Date.now() - startTime) / 1000);
      await fetch(`${SUPABASE_URL}/rest/v1/recordings?id=eq.${recordingId}`, {
        method: 'PATCH',
        headers: {
          'apikey': SUPABASE_ANON_KEY,
          'Authorization': `Bearer ${authToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          storage_path: videoPath,
          thumbnail_path: thumbnailPath,
          status: 'ready',
          duration,
          file_size: blob.size,
        }),
      });

      chrome.runtime.sendMessage({ action: 'uploadProgress', progress: 100 });
      cleanup();
      chrome.runtime.sendMessage({ action: 'desktopRecordingComplete', success: true, recordingId });
    } catch (err) {
      console.error('[DesktopRec] Upload error:', err);
      cleanup();
      chrome.runtime.sendMessage({ action: 'desktopRecordingComplete', success: false, error: err.message });
    }
  };

  // --- Keep content script alive via port connection ---
  // Chrome may throttle/suspend background tabs. A port keeps the SW alive,
  // and periodic messaging keeps this content script's execution context active.
  const keepAlivePort = chrome.runtime.connect({ name: 'desktopRecorder' });
  const keepAliveInterval = setInterval(() => {
    try { keepAlivePort.postMessage({ alive: true, chunks: chunkCount }); } catch {}
  }, 1000);

  // --- Start recording ---
  recorder.start(1000);
  console.log('[DesktopRec] Recording started, mode:', mode);

  // Notify service worker (include all state so SW can restore after sleep)
  chrome.runtime.sendMessage({ action: 'desktopRecordingStarted', recordingId, cameraId: cameraId || null, mode });

  // --- Listen for stop/pause/resume from service worker ---
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.action === 'stopDesktopRecording') {
      if (recorder.state !== 'inactive') recorder.stop();
    }
    if (msg.action === 'pauseDesktopRecording') {
      if (recorder.state === 'recording') recorder.pause();
    }
    if (msg.action === 'resumeDesktopRecording') {
      if (recorder.state === 'paused') recorder.resume();
    }
    if (msg.action === 'discardDesktopRecording') {
      if (recorder.state !== 'inactive') {
        recorder.ondataavailable = null;
        recorder.onstop = null;
        recorder.stop();
      }
      cleanup();
      chrome.runtime.sendMessage({ action: 'desktopRecordingComplete', success: true, discarded: true });
    }
  });

  // --- Handle user clicking Chrome's "Stop sharing" button (screen modes only) ---
  if (screenStream) {
    screenStream.getVideoTracks()[0].onended = () => {
      if (recorder.state !== 'inactive') recorder.stop();
      chrome.runtime.sendMessage({ action: 'desktopRecordingStopped' });
    };
  }

  // --- Stop recorder when page navigates away so onstop fires and IDB is saved ---
  window.addEventListener('beforeunload', () => {
    if (recorder.state !== 'inactive') recorder.stop();
  });

  function cleanup() {
    clearInterval(keepAliveInterval);
    try { keepAlivePort.disconnect(); } catch {}
    if (screenStream) screenStream.getTracks().forEach(t => t.stop());
    if (cameraStream) cameraStream.getTracks().forEach(t => t.stop());
    if (micStream) micStream.getTracks().forEach(t => t.stop());
    audioContext.close().catch(() => {});
    window._screencastDesktopRecorderActive = false;
  }

  // --- Thumbnail generator ---
  function generateThumbnail(videoBlob) {
    return new Promise((resolve) => {
      const video = document.createElement('video');
      video.muted = true;
      video.playsInline = true;
      const url = URL.createObjectURL(videoBlob);
      video.src = url;
      video.currentTime = 0.5;
      video.onloadeddata = () => {
        const canvas = document.createElement('canvas');
        canvas.width = Math.min(video.videoWidth, 640);
        canvas.height = Math.round(canvas.width * (video.videoHeight / video.videoWidth));
        const ctx = canvas.getContext('2d');
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        canvas.toBlob((blob) => {
          URL.revokeObjectURL(url);
          resolve(blob);
        }, 'image/png');
      };
      video.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
      setTimeout(() => { URL.revokeObjectURL(url); resolve(null); }, 5000);
    });
  }
})();
