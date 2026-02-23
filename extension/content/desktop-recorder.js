// Desktop/Window screen recorder — injected on the active tab.
// Has user activation propagated from popup click, so getDisplayMedia() works.
// Records the screen stream directly (no canvas compositing needed).

(async () => {
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
  const { mode, micId, recordingId, userId, authToken } = config;

  // --- Get screen stream (has user activation from popup click) ---
  let screenStream;
  try {
    const displaySurface = mode === 'window' ? 'window' : 'monitor';
    screenStream = await navigator.mediaDevices.getDisplayMedia({
      video: { displaySurface },
      audio: true,
    });
  } catch (err) {
    console.error('[DesktopRec] getDisplayMedia failed:', err);
    chrome.runtime.sendMessage({ action: 'desktopRecordingFailed', error: err.message });
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

  if (screenStream.getAudioTracks().length > 0) {
    const screenSource = audioContext.createMediaStreamSource(
      new MediaStream(screenStream.getAudioTracks())
    );
    screenSource.connect(destination);
  }

  if (micStream) {
    const micSource = audioContext.createMediaStreamSource(micStream);
    micSource.connect(destination);
  }

  // --- Composite stream (screen video + mixed audio) ---
  const compositeStream = new MediaStream();
  screenStream.getVideoTracks().forEach(t => compositeStream.addTrack(t));
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

  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };

  recorder.onstop = async () => {
    const blob = new Blob(chunks, { type: mimeType });
    console.log('[DesktopRec] Recording stopped, blob size:', blob.size);
    cleanup();

    if (blob.size === 0) {
      chrome.runtime.sendMessage({ action: 'desktopRecordingComplete', success: false, error: 'Empty recording' });
      return;
    }

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
      chrome.runtime.sendMessage({ action: 'desktopRecordingComplete', success: true, recordingId });
    } catch (err) {
      console.error('[DesktopRec] Upload error:', err);
      chrome.runtime.sendMessage({ action: 'desktopRecordingComplete', success: false, error: err.message });
    }
  };

  // --- Start recording ---
  recorder.start(1000);
  console.log('[DesktopRec] Recording started, mode:', mode);

  // Notify service worker
  chrome.runtime.sendMessage({ action: 'desktopRecordingStarted', recordingId });

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

  // --- Handle user clicking Chrome's "Stop sharing" button ---
  screenStream.getVideoTracks()[0].onended = () => {
    if (recorder.state !== 'inactive') recorder.stop();
    chrome.runtime.sendMessage({ action: 'desktopRecordingStopped' });
  };

  function cleanup() {
    screenStream.getTracks().forEach(t => t.stop());
    if (micStream) micStream.getTracks().forEach(t => t.stop());
    audioContext.close().catch(() => {});
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
