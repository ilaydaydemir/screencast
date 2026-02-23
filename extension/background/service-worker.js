// Screencast - Background Service Worker
// Orchestrates recording: tab capture, desktop capture, messaging

// === State ===
let recordingState = 'idle'; // idle | recording | paused | stopped
let currentMode = null;
let activeTabId = null;
let elapsedSeconds = 0;
let timerInterval = null;
let offscreenCreated = false;

// === Message Router ===
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Ignore messages targeting offscreen
  if (message.target === 'offscreen') return false;

  switch (message.action) {
    case 'getState':
      sendResponse({ state: recordingState, mode: currentMode, elapsed: elapsedSeconds });
      return false;

    case 'startRecording':
      handleStartRecording(message).then(sendResponse);
      return true;

    case 'stopRecording':
      handleStopRecording().then(sendResponse);
      return true;

    case 'pauseRecording':
      handlePauseRecording().then(sendResponse);
      return true;

    case 'resumeRecording':
      handleResumeRecording().then(sendResponse);
      return true;

    case 'downloadRecording':
      forwardToOffscreen({ action: 'downloadRecording', title: message.title }).then(sendResponse);
      return true;

    case 'uploadToWebApp':
      forwardToOffscreen({
        action: 'uploadToWebApp',
        title: message.title,
        duration: message.duration,
        mode: message.mode,
      }).then(sendResponse);
      return true;

    case 'discardRecording':
      forwardToOffscreen({ action: 'discardRecording' }).then(() => {
        recordingState = 'idle';
        sendResponse({ success: true });
      });
      return true;

    case 'enumerateDevices':
      (async () => {
        await ensureOffscreenDocument();
        const result = await forwardToOffscreen({ action: 'enumerateDevices' });
        sendResponse(result);
      })();
      return true;

    // From offscreen
    case 'recordingStopped':
      recordingState = 'stopped';
      clearInterval(timerInterval);
      // Relay to popup
      chrome.runtime.sendMessage({ action: 'recordingStopped', blobSize: message.blobSize }).catch(() => {});
      return false;
  }
});

// === Start Recording ===
async function handleStartRecording({ mode, cameraId, micId }) {
  currentMode = mode;

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    activeTabId = tab.id;

    await ensureOffscreenDocument();

    if (mode === 'tab') {
      return await startTabRecording(tab, cameraId, micId);
    } else if (mode === 'full-screen' || mode === 'window') {
      return await startDesktopRecording(mode, tab, cameraId, micId);
    } else if (mode === 'camera-only') {
      return await startCameraOnlyRecording(cameraId, micId);
    }

    return { success: false, error: 'Unknown mode' };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// === Inject Webcam Bubble ===
async function injectWebcamBubble(tab, cameraId) {
  if (!cameraId) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (camId) => {
        // Remove existing bubble if any
        const existing = document.getElementById('screencast-bubble-host');
        if (existing) existing.remove();

        // Create host
        const host = document.createElement('div');
        host.id = 'screencast-bubble-host';
        host.style.cssText = 'all:initial;position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;pointer-events:none;';
        document.documentElement.appendChild(host);

        const shadow = host.attachShadow({ mode: 'open' });

        const SIZES = { small: 100, medium: 150, large: 200 };
        let currentSize = 'medium';

        // Styles
        const style = document.createElement('style');
        style.textContent = `
          * { margin:0; padding:0; box-sizing:border-box; }
          .bubble {
            position:fixed; bottom:24px; left:24px;
            width:${SIZES.medium}px; height:${SIZES.medium}px;
            z-index:2147483647; cursor:grab; pointer-events:auto;
            border-radius:50%; overflow:visible; user-select:none;
            transition: width 0.2s ease, height 0.2s ease;
          }
          .bubble.dragging { cursor:grabbing; }
          .video-mask {
            width:100%; height:100%; border-radius:50%; overflow:hidden;
            box-shadow: 0 4px 24px rgba(0,0,0,0.4), 0 0 0 3px rgba(255,255,255,0.9);
          }
          .bubble:hover .video-mask {
            box-shadow: 0 4px 24px rgba(0,0,0,0.5), 0 0 0 3px rgba(255,255,255,1);
          }
          video {
            width:100%; height:100%; object-fit:cover;
            transform:scaleX(-1); pointer-events:none; display:block;
          }
          .controls {
            position:absolute; top:-36px; left:50%; transform:translateX(-50%);
            display:none; gap:2px; background:rgba(0,0,0,0.85);
            border-radius:6px; padding:4px; pointer-events:auto;
          }
          .bubble:hover .controls { display:flex; }
          .size-btn {
            width:26px; height:26px; border:none; background:transparent;
            color:#fff; font-size:11px; font-weight:600; cursor:pointer;
            border-radius:4px; font-family:-apple-system,sans-serif;
          }
          .size-btn:hover { background:rgba(255,255,255,0.2); }
          .size-btn.active { background:rgba(255,255,255,0.3); }
        `;
        shadow.appendChild(style);

        // Bubble container
        const bubble = document.createElement('div');
        bubble.className = 'bubble';

        // Size controls
        const controls = document.createElement('div');
        controls.className = 'controls';
        ['small','medium','large'].forEach(size => {
          const btn = document.createElement('button');
          btn.className = `size-btn ${size === currentSize ? 'active' : ''}`;
          btn.textContent = size[0].toUpperCase();
          btn.addEventListener('click', (e) => {
            e.stopPropagation();
            currentSize = size;
            bubble.style.width = SIZES[size] + 'px';
            bubble.style.height = SIZES[size] + 'px';
            controls.querySelectorAll('.size-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
          });
          controls.appendChild(btn);
        });
        bubble.appendChild(controls);

        // Video
        const mask = document.createElement('div');
        mask.className = 'video-mask';
        const video = document.createElement('video');
        video.autoplay = true;
        video.playsInline = true;
        video.muted = true;
        mask.appendChild(video);
        bubble.appendChild(mask);
        shadow.appendChild(bubble);

        // Start webcam
        (async () => {
          try {
            const stream = await navigator.mediaDevices.getUserMedia({
              video: { deviceId: { exact: camId }, width: { ideal: 480 }, height: { ideal: 480 } },
            });
            video.srcObject = stream;
            // Store stream ref for cleanup
            host.dataset.hasStream = 'true';
            host._stream = stream;
          } catch {
            try {
              const stream = await navigator.mediaDevices.getUserMedia({
                video: { width: { ideal: 480 }, height: { ideal: 480 } },
              });
              video.srcObject = stream;
              host._stream = stream;
            } catch (err) {
              console.error('[Screencast] Webcam failed:', err);
            }
          }
        })();

        // Dragging
        let isDragging = false, offsetX = 0, offsetY = 0;
        bubble.addEventListener('mousedown', (e) => {
          if (e.target.closest('.size-btn')) return;
          isDragging = true;
          bubble.classList.add('dragging');
          const rect = bubble.getBoundingClientRect();
          offsetX = e.clientX - rect.left;
          offsetY = e.clientY - rect.top;
          e.preventDefault();
        });
        document.addEventListener('mousemove', (e) => {
          if (!isDragging) return;
          const sz = SIZES[currentSize];
          bubble.style.left = Math.max(0, Math.min(window.innerWidth - sz, e.clientX - offsetX)) + 'px';
          bubble.style.top = Math.max(0, Math.min(window.innerHeight - sz, e.clientY - offsetY)) + 'px';
          bubble.style.bottom = 'auto';
        });
        document.addEventListener('mouseup', () => {
          if (isDragging) { isDragging = false; bubble.classList.remove('dragging'); }
        });
      },
      args: [cameraId],
    });
    // Wait for bubble to render and webcam to start
    await new Promise(r => setTimeout(r, 800));
  } catch (err) {
    console.warn('Could not inject webcam bubble:', err);
  }
}

// === Remove Webcam Bubble ===
async function removeWebcamBubble(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const host = document.getElementById('screencast-bubble-host');
        if (host) {
          if (host._stream) host._stream.getTracks().forEach(t => t.stop());
          host.remove();
        }
      },
    });
  } catch {}
}

// === Tab Recording ===
async function startTabRecording(tab, cameraId, micId) {
  // Inject webcam bubble into page (captured by tabCapture)
  await injectWebcamBubble(tab, cameraId);

  // Get tab capture stream ID
  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });

  // Send to offscreen
  await forwardToOffscreen({
    action: 'startRecording',
    mode: 'tab',
    tabCaptureStreamId: streamId,
    micId,
    cameraId: null, // Camera already in tab DOM
  });

  startTimer();
  recordingState = 'recording';
  return { success: true };
}

// === Desktop/Window Recording ===
async function startDesktopRecording(mode, tab, cameraId, micId) {
  // Inject webcam bubble so user can see themselves
  await injectWebcamBubble(tab, cameraId);

  return new Promise((resolve) => {
    const sources = mode === 'full-screen' ? ['screen'] : ['window'];
    chrome.desktopCapture.chooseDesktopMedia(sources, tab, async (streamId) => {
      if (!streamId) {
        // Remove bubble if user cancelled
        try { await chrome.tabs.sendMessage(tab.id, { action: 'removeBubble' }); } catch {}
        resolve({ success: false, error: 'Source selection cancelled' });
        return;
      }

      await forwardToOffscreen({
        action: 'startRecording',
        mode: mode,
        desktopStreamId: streamId,
        cameraId,
        micId,
      });

      startTimer();
      recordingState = 'recording';
      resolve({ success: true });
    });
  });
}

// === Camera Only ===
async function startCameraOnlyRecording(cameraId, micId) {
  await forwardToOffscreen({
    action: 'startRecording',
    mode: 'camera-only',
    cameraId,
    micId,
  });

  startTimer();
  recordingState = 'recording';
  return { success: true };
}

// === Stop ===
async function handleStopRecording() {
  clearInterval(timerInterval);

  // Remove bubble from tab
  if (activeTabId) {
    await removeWebcamBubble(activeTabId);
  }

  const stopResult = await forwardToOffscreen({ action: 'stopRecording' });
  recordingState = 'stopped';
  return { success: true, elapsed: elapsedSeconds, blobSize: stopResult?.blobSize || 0 };
}

// === Pause/Resume ===
async function handlePauseRecording() {
  clearInterval(timerInterval);
  await forwardToOffscreen({ action: 'pauseRecording' });
  recordingState = 'paused';
  return { success: true };
}

async function handleResumeRecording() {
  startTimer();
  await forwardToOffscreen({ action: 'resumeRecording' });
  recordingState = 'recording';
  return { success: true };
}

// === Timer ===
function startTimer() {
  elapsedSeconds = 0;
  timerInterval = setInterval(() => {
    elapsedSeconds++;
    chrome.runtime.sendMessage({ action: 'timerSync', elapsed: elapsedSeconds }).catch(() => {});
    if (elapsedSeconds >= 3600) {
      handleStopRecording();
    }
  }, 1000);
}

// === Offscreen Document ===
async function ensureOffscreenDocument() {
  if (offscreenCreated) return;

  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
  });
  if (existingContexts.length > 0) {
    offscreenCreated = true;
    return;
  }

  await chrome.offscreen.createDocument({
    url: 'offscreen/offscreen.html',
    reasons: ['USER_MEDIA', 'DISPLAY_MEDIA'],
    justification: 'Recording screen/camera via MediaRecorder requires DOM access',
  });
  offscreenCreated = true;
}

async function forwardToOffscreen(msg) {
  try {
    return await chrome.runtime.sendMessage({ ...msg, target: 'offscreen' });
  } catch (err) {
    console.error('Failed to forward to offscreen:', err);
    return { success: false, error: err.message };
  }
}
