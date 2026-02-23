// Screencast - Background Service Worker
// Orchestrates recording: tab capture, desktop capture, messaging, toolbar
// Uses a pinned recorder tab instead of offscreen document for reliability.

// === Constants ===
const SUPABASE_URL = 'https://bgsvuywxejpmkstgqizq.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJnc3Z1eXd4ZWpwbWtzdGdxaXpxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzE2MDc0MzMsImV4cCI6MjA4NzE4MzQzM30.EvHOy5sBbXzSxjRS5vPGzm8cnFrOXxDfclP-ru3VU_M';

// === State ===
let recordingState = 'idle'; // idle | recording | paused | stopped
let currentMode = null;
let activeTabId = null;
let bubbleTabId = null;
let recorderTabId = null;
let currentCameraId = null;
let elapsedSeconds = 0;
let timerInterval = null;
let uploadError = null;
let lastRecordingId = null;
let recorderTabReady = false;

// === Port connection from recorder tab (keeps SW alive) ===
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'recorder') {
    port.onDisconnect.addListener(() => {
      // Recorder tab disconnected — could be closed or crashed
    });
  }
});

// === Recorder Tab Lifecycle Monitoring ===
chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === recorderTabId) {
    recorderTabId = null;
    recorderTabReady = false;
    if (recordingState === 'recording' || recordingState === 'paused') {
      clearInterval(timerInterval);
      recordingState = 'stopped';
      if (bubbleTabId) {
        removeBubble(bubbleTabId).catch(() => {});
        bubbleTabId = null;
      }
      // Notify popup — IDB has chunks for recovery
      chrome.runtime.sendMessage({
        action: 'recorderTabClosed',
        recoverable: true,
        recordingId: lastRecordingId,
      }).catch(() => {});
    }
  }
});

// === Message Router ===
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target === 'recorder') return false;

  switch (message.action) {
    case 'getState':
      sendResponse({
        state: recordingState,
        mode: currentMode,
        elapsed: elapsedSeconds,
        uploadError,
        recordingId: lastRecordingId,
      });
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

    case 'cancelRecording':
      handleCancelRecording().then(sendResponse);
      return true;

    case 'downloadRecording':
      (async () => {
        await ensureRecorderTab();
        const result = await forwardToRecorderTab({ action: 'downloadRecording', title: message.title });
        sendResponse(result);
      })();
      return true;

    case 'uploadToWebApp':
      (async () => {
        await ensureRecorderTab();
        const result = await forwardToRecorderTab({
          action: 'uploadToWebApp',
          title: message.title,
          duration: message.duration,
          mode: message.mode,
        });
        sendResponse(result);
      })();
      return true;

    case 'discardRecording':
      (async () => {
        await forwardToRecorderTab({ action: 'discardRecording' });
        recordingState = 'idle';
        lastRecordingId = null;
        await chrome.storage.session.remove(['lastRecordingId']);
        // Close recorder tab after discard
        await closeRecorderTab();
        sendResponse({ success: true });
      })();
      return true;

    case 'enumerateDevices':
      (async () => {
        await ensureRecorderTab();
        const result = await forwardToRecorderTab({ action: 'enumerateDevices' });
        sendResponse(result);
      })();
      return true;

    // From recorder tab
    case 'recordingStopped':
      recordingState = 'stopped';
      clearInterval(timerInterval);
      // Relay to popup
      chrome.runtime.sendMessage({
        action: 'recordingStopped',
        blobSize: message.blobSize,
        progressiveUploadOk: message.progressiveUploadOk,
      }).catch(() => {});
      // Relay to content script toolbar
      if (bubbleTabId) {
        chrome.tabs.sendMessage(bubbleTabId, { action: 'recordingStopped' }).catch(() => {});
      }
      return false;
  }
});

// === Tab Following: Re-inject bubble when user switches tabs ===
chrome.tabs.onActivated.addListener(async (activeInfo) => {
  if (recordingState !== 'recording' && recordingState !== 'paused') return;
  if (currentMode === 'camera-only') return;
  if (currentMode === 'tab') return;

  const newTabId = activeInfo.tabId;
  if (newTabId === bubbleTabId) return;
  // Don't inject into the recorder tab
  if (newTabId === recorderTabId) return;

  if (bubbleTabId) {
    await removeBubble(bubbleTabId);
    bubbleTabId = null;
    await new Promise(r => setTimeout(r, 500));
  }

  try {
    const tab = await chrome.tabs.get(newTabId);
    if (tab.url && !tab.url.startsWith('chrome://') && !tab.url.startsWith('chrome-extension://') && !tab.url.startsWith('about:')) {
      const isPaused = recordingState === 'paused';
      await injectBubbleAndToolbar(newTabId, currentCameraId, elapsedSeconds, isPaused);
      bubbleTabId = newTabId;
    }
  } catch {}
});

// === Re-inject on page navigation ===
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete') return;
  if (recordingState !== 'recording' && recordingState !== 'paused') return;
  if (tabId !== bubbleTabId) return;
  if (currentMode === 'camera-only') return;

  if (tab.url && !tab.url.startsWith('chrome://') && !tab.url.startsWith('chrome-extension://') && !tab.url.startsWith('about:')) {
    const isPaused = recordingState === 'paused';
    await injectBubbleAndToolbar(tabId, currentCameraId, elapsedSeconds, isPaused);
  }
});

// === Start Recording ===
async function handleStartRecording({ mode, cameraId, micId }) {
  console.log('[SW] handleStartRecording:', mode, 'camera:', cameraId, 'mic:', micId);
  currentMode = mode;
  currentCameraId = cameraId;
  elapsedSeconds = 0;
  uploadError = null;

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    activeTabId = tab.id;
    console.log('[SW] Active tab:', tab.id, tab.url);

    // Create recording row UPFRONT (gives us recordingId for progressive upload)
    const auth = await chrome.storage.local.get(['authToken', 'userId']);
    let recordingId = null;
    if (auth.authToken && auth.userId) {
      try {
        const now = new Date();
        const title = 'Recording - ' + now.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) + ' ' + now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
        const res = await fetch(`${SUPABASE_URL}/rest/v1/recordings`, {
          method: 'POST',
          headers: {
            'apikey': SUPABASE_ANON_KEY,
            'Authorization': `Bearer ${auth.authToken}`,
            'Content-Type': 'application/json',
            'Prefer': 'return=representation',
          },
          body: JSON.stringify({
            user_id: auth.userId,
            title,
            duration: 0,
            file_size: 0,
            mime_type: 'video/webm',
            recording_mode: mode === 'camera-only' ? 'camera_only' : 'screen',
            status: 'processing',
          }),
        });
        if (res.ok) {
          const [row] = await res.json();
          recordingId = row.id;
          lastRecordingId = recordingId;
          await chrome.storage.session.set({ lastRecordingId: recordingId });
        }
      } catch (e) {
        console.warn('Failed to create upfront recording row:', e);
      }
    }

    await ensureRecorderTab();

    if (mode === 'tab') {
      return await startTabRecording(tab, cameraId, micId, recordingId, auth);
    } else if (mode === 'full-screen' || mode === 'window') {
      return await startDesktopRecording(mode, tab, cameraId, micId, recordingId, auth);
    } else if (mode === 'camera-only') {
      return await startCameraOnlyRecording(cameraId, micId, recordingId, auth);
    }

    return { success: false, error: 'Unknown mode' };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// === Inject Webcam Bubble + Loom-style Toolbar ===
async function injectBubbleAndToolbar(tabId, cameraId, elapsed, isPaused) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (camId, currentElapsed, paused) => {
        // Remove existing
        const existing = document.getElementById('screencast-bubble-host');
        if (existing) {
          if (existing._stream) existing._stream.getTracks().forEach(t => t.stop());
          existing.remove();
        }
        if (window._screencastListener) {
          chrome.runtime.onMessage.removeListener(window._screencastListener);
        }

        const host = document.createElement('div');
        host.id = 'screencast-bubble-host';
        host.style.cssText = 'all:initial;position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;pointer-events:none;';
        document.documentElement.appendChild(host);

        const shadow = host.attachShadow({ mode: 'open' });
        let elapsed = currentElapsed;
        let isPaused = paused;
        const SIZES = { small: 100, medium: 150, large: 200 };
        let currentSize = 'medium';
        let toolbarVisible = true;

        const style = document.createElement('style');
        style.textContent = `
          *{margin:0;padding:0;box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;}
          .container{
            position:fixed;bottom:24px;left:24px;
            display:flex;flex-direction:column;align-items:center;gap:8px;
            z-index:2147483647;pointer-events:auto;user-select:none;
          }
          .container.dragging{cursor:grabbing;}
          .toolbar{
            display:flex;flex-direction:column;align-items:center;gap:2px;
            background:rgba(30,30,30,0.95);border-radius:14px;padding:8px 6px;
            box-shadow:0 4px 24px rgba(0,0,0,0.5);backdrop-filter:blur(12px);
          }
          .toolbar.hidden{display:none;}
          .tb{
            width:38px;height:38px;border:none;background:transparent;
            color:#fff;cursor:pointer;border-radius:10px;
            display:flex;align-items:center;justify-content:center;
            transition:background 0.15s;
          }
          .tb:hover{background:rgba(255,255,255,0.15);}
          .stop-btn{background:#ef4444!important;border-radius:10px;}
          .stop-btn:hover{background:#dc2626!important;}
          .timer-display{
            color:#fff;font-size:13px;font-weight:700;
            font-variant-numeric:tabular-nums;padding:4px 0;text-align:center;min-width:44px;
          }
          .divider{width:26px;height:1px;background:rgba(255,255,255,0.12);margin:2px 0;}
          .bubble-wrap{position:relative;cursor:grab;}
          .bubble-wrap.dragging{cursor:grabbing;}
          .bubble{
            width:150px;height:150px;border-radius:50%;overflow:hidden;
            box-shadow:0 4px 24px rgba(0,0,0,0.4),0 0 0 3px rgba(255,255,255,0.9);
            transition:width 0.2s,height 0.2s;
          }
          .bubble:hover{
            box-shadow:0 4px 24px rgba(0,0,0,0.5),0 0 0 3px rgba(255,255,255,1);
          }
          video{width:100%;height:100%;object-fit:cover;transform:scaleX(-1);pointer-events:none;display:block;}
          .sz{
            position:absolute;top:-28px;left:50%;transform:translateX(-50%);
            display:none;gap:2px;background:rgba(0,0,0,0.85);border-radius:6px;padding:3px;pointer-events:auto;
          }
          .bubble-wrap:hover .sz{display:flex;}
          .szb{width:22px;height:22px;border:none;background:transparent;color:#fff;font-size:10px;font-weight:600;cursor:pointer;border-radius:3px;}
          .szb:hover{background:rgba(255,255,255,0.2);}
          .szb.a{background:rgba(255,255,255,0.3);}
          @keyframes pulse{0%,100%{opacity:1;}50%{opacity:0.3;}}
        `;
        shadow.appendChild(style);

        const container = document.createElement('div');
        container.className = 'container';

        const toolbar = document.createElement('div');
        toolbar.className = 'toolbar';

        const stopBtn = document.createElement('button');
        stopBtn.className = 'tb stop-btn';
        stopBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><rect x="3" y="3" width="10" height="10" rx="2"/></svg>';
        stopBtn.title = 'Stop Recording';
        stopBtn.addEventListener('click', e => {
          e.stopPropagation();
          chrome.runtime.sendMessage({ action: 'stopRecording' });
        });
        toolbar.appendChild(stopBtn);

        const timerEl = document.createElement('div');
        timerEl.className = 'timer-display';
        function fmt(s) { const m = Math.floor(s / 60), sec = s % 60; return m + ':' + (sec < 10 ? '0' : '') + sec; }
        timerEl.textContent = fmt(elapsed);
        toolbar.appendChild(timerEl);

        const pauseBtn = document.createElement('button');
        pauseBtn.className = 'tb';
        const pauseSvg = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="8" y1="5" x2="8" y2="19"/><line x1="16" y1="5" x2="16" y2="19"/></svg>';
        const playSvg = '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><polygon points="6,4 20,12 6,20"/></svg>';
        pauseBtn.innerHTML = isPaused ? playSvg : pauseSvg;
        pauseBtn.title = isPaused ? 'Resume' : 'Pause';
        pauseBtn.addEventListener('click', e => {
          e.stopPropagation();
          if (isPaused) {
            chrome.runtime.sendMessage({ action: 'resumeRecording' });
          } else {
            chrome.runtime.sendMessage({ action: 'pauseRecording' });
          }
        });
        toolbar.appendChild(pauseBtn);

        const d1 = document.createElement('div');
        d1.className = 'divider';
        toolbar.appendChild(d1);

        const discardBtn = document.createElement('button');
        discardBtn.className = 'tb';
        discardBtn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';
        discardBtn.title = 'Discard Recording';
        discardBtn.addEventListener('click', e => {
          e.stopPropagation();
          chrome.runtime.sendMessage({ action: 'cancelRecording' });
        });
        toolbar.appendChild(discardBtn);

        const closeBtn = document.createElement('button');
        closeBtn.className = 'tb';
        closeBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
        closeBtn.title = 'Hide Controls';
        closeBtn.addEventListener('click', e => {
          e.stopPropagation();
          toolbarVisible = false;
          toolbar.classList.add('hidden');
        });
        toolbar.appendChild(closeBtn);

        container.appendChild(toolbar);

        const bubbleWrap = document.createElement('div');
        bubbleWrap.className = 'bubble-wrap';

        const szCtrl = document.createElement('div');
        szCtrl.className = 'sz';
        ['small', 'medium', 'large'].forEach(size => {
          const b = document.createElement('button');
          b.className = 'szb' + (size === currentSize ? ' a' : '');
          b.textContent = size[0].toUpperCase();
          b.addEventListener('click', e => {
            e.stopPropagation();
            currentSize = size;
            bubble.style.width = SIZES[size] + 'px';
            bubble.style.height = SIZES[size] + 'px';
            szCtrl.querySelectorAll('.szb').forEach(x => x.classList.remove('a'));
            b.classList.add('a');
          });
          szCtrl.appendChild(b);
        });
        bubbleWrap.appendChild(szCtrl);

        const bubble = document.createElement('div');
        bubble.className = 'bubble';
        bubble.addEventListener('click', e => {
          if (!toolbarVisible) {
            e.stopPropagation();
            toolbarVisible = true;
            toolbar.classList.remove('hidden');
          }
        });

        if (camId) {
          const iframe = document.createElement('iframe');
          iframe.src = chrome.runtime.getURL('camera/camera.html?d=' + encodeURIComponent(camId));
          iframe.style.cssText = 'width:100%;height:100%;border:none;display:block;border-radius:50%;';
          iframe.allow = 'camera';
          bubble.appendChild(iframe);
        } else {
          bubble.style.background = '#333';
        }
        bubbleWrap.appendChild(bubble);

        if (!camId) {
          bubbleWrap.style.display = 'none';
        }

        container.appendChild(bubbleWrap);
        shadow.appendChild(container);

        const listener = (msg) => {
          if (msg.action === 'timerSync') {
            elapsed = msg.elapsed;
            timerEl.textContent = fmt(elapsed);
          }
          if (msg.action === 'pauseStateChanged') {
            isPaused = msg.paused;
            pauseBtn.innerHTML = isPaused ? playSvg : pauseSvg;
            pauseBtn.title = isPaused ? 'Resume' : 'Pause';
          }
          if (msg.action === 'recordingStopped' || msg.action === 'removeBubble') {
            if (host._stream) host._stream.getTracks().forEach(t => t.stop());
            host.remove();
            chrome.runtime.onMessage.removeListener(listener);
          }
        };
        chrome.runtime.onMessage.addListener(listener);
        window._screencastListener = listener;

        let isDragging = false, offX = 0, offY = 0;
        container.addEventListener('mousedown', e => {
          if (e.target.closest('button')) return;
          isDragging = true;
          container.classList.add('dragging');
          const r = container.getBoundingClientRect();
          offX = e.clientX - r.left;
          offY = e.clientY - r.top;
          e.preventDefault();
        });
        document.addEventListener('mousemove', e => {
          if (!isDragging) return;
          const r = container.getBoundingClientRect();
          const newLeft = Math.max(0, Math.min(window.innerWidth - r.width, e.clientX - offX));
          const newTop = Math.max(0, Math.min(window.innerHeight - r.height, e.clientY - offY));
          container.style.left = newLeft + 'px';
          container.style.top = newTop + 'px';
          container.style.bottom = 'auto';
        });
        document.addEventListener('mouseup', () => {
          if (isDragging) {
            isDragging = false;
            container.classList.remove('dragging');
          }
        });
      },
      args: [cameraId, elapsed, isPaused],
    });
    await new Promise(r => setTimeout(r, 600));
  } catch (err) {
    console.warn('Could not inject bubble+toolbar:', err);
  }
}

// === Remove Bubble ===
async function removeBubble(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const host = document.getElementById('screencast-bubble-host');
        if (host) {
          const shadow = host.shadowRoot;
          if (shadow) {
            const iframe = shadow.querySelector('iframe');
            if (iframe) iframe.src = 'about:blank';
          }
          if (host._stream) host._stream.getTracks().forEach(t => t.stop());
          host.remove();
        }
        if (window._screencastListener) {
          chrome.runtime.onMessage.removeListener(window._screencastListener);
          window._screencastListener = null;
        }
      },
    });
  } catch {}
}

// === Tab Recording ===
async function startTabRecording(tab, cameraId, micId, recordingId, auth) {
  await injectBubbleAndToolbar(tab.id, cameraId, 0, false);
  bubbleTabId = tab.id;

  // Use consumerTabId so the pinned recorder tab can consume the stream
  const streamId = await chrome.tabCapture.getMediaStreamId({
    targetTabId: tab.id,
    consumerTabId: recorderTabId,
  });

  const result = await forwardToRecorderTab({
    action: 'startRecording',
    mode: 'tab',
    tabCaptureStreamId: streamId,
    micId,
    cameraId: null,
    recordingId,
    userId: auth.userId,
    authToken: auth.authToken,
  });

  if (!result || !result.success) {
    console.error('[SW] Recorder failed to start tab capture:', result?.error);
    await removeBubble(tab.id);
    bubbleTabId = null;
    return { success: false, error: result?.error || 'Recorder failed to start' };
  }

  startTimer();
  recordingState = 'recording';
  return { success: true };
}

// === Desktop/Window Recording ===
async function startDesktopRecording(mode, tab, cameraId, micId, recordingId, auth) {
  await injectBubbleAndToolbar(tab.id, cameraId, 0, false);
  bubbleTabId = tab.id;

  return new Promise((resolve) => {
    const sources = mode === 'full-screen' ? ['screen'] : ['window'];
    // Pass the recorder tab as targetTab so the stream is bound to it
    // (the recorder tab is where getUserMedia will consume the stream).
    const recorderTab = await chrome.tabs.get(recorderTabId);
    chrome.desktopCapture.chooseDesktopMedia(sources, recorderTab, async (streamId) => {
      if (!streamId) {
        await removeBubble(tab.id);
        bubbleTabId = null;
        resolve({ success: false, error: 'Source selection cancelled' });
        return;
      }

      const result = await forwardToRecorderTab({
        action: 'startRecording',
        mode: mode,
        desktopStreamId: streamId,
        cameraId,
        micId,
        recordingId,
        userId: auth.userId,
        authToken: auth.authToken,
      });

      if (!result || !result.success) {
        console.error('[SW] Recorder failed to start desktop capture:', result?.error);
        await removeBubble(tab.id);
        bubbleTabId = null;
        resolve({ success: false, error: result?.error || 'Recorder failed to start' });
        return;
      }

      startTimer();
      recordingState = 'recording';
      resolve({ success: true });
    });
  });
}

// === Camera Only ===
async function startCameraOnlyRecording(cameraId, micId, recordingId, auth) {
  const result = await forwardToRecorderTab({
    action: 'startRecording',
    mode: 'camera-only',
    cameraId,
    micId,
    recordingId,
    userId: auth.userId,
    authToken: auth.authToken,
  });

  if (!result || !result.success) {
    console.error('[SW] Recorder failed to start camera-only:', result?.error);
    return { success: false, error: result?.error || 'Recorder failed to start' };
  }

  startTimer();
  recordingState = 'recording';
  return { success: true };
}

// === Stop ===
async function handleStopRecording() {
  console.log('[SW] handleStopRecording called');
  clearInterval(timerInterval);
  const savedElapsed = elapsedSeconds;
  const savedMode = currentMode;

  if (bubbleTabId) {
    await removeBubble(bubbleTabId);
    bubbleTabId = null;
  }

  console.log('[SW] Sending stopRecording to recorder tab...');
  const stopResult = await forwardToRecorderTab({ action: 'stopRecording' });
  console.log('[SW] stopResult:', JSON.stringify(stopResult));
  recordingState = 'stopped';
  currentCameraId = null;

  // Fire-and-forget upload — wrapped with error handler so failures always
  // report back to the popup instead of silently dying.
  const uploadWithErrorHandler = async () => {
    try {
      if (stopResult?.progressiveUploadOk) {
        console.log('[SW] Progressive upload OK, calling assembleAndFinalize');
        await assembleAndFinalize(savedElapsed, savedMode);
      } else {
        console.log('[SW] No progressive upload, calling autoUpload');
        await autoUpload(savedElapsed, savedMode);
      }
    } catch (err) {
      console.error('[SW] Upload error handler caught:', err);
      uploadError = err.message || 'Upload failed unexpectedly';
      chrome.runtime.sendMessage({ action: 'autoUploadFailed', error: uploadError }).catch(() => {});
    }
  };
  uploadWithErrorHandler();

  return { success: true, elapsed: savedElapsed, blobSize: stopResult?.blobSize || 0 };
}

// === Assemble: Call server to concatenate progressively uploaded chunks ===
async function assembleAndFinalize(duration, mode) {
  const auth = await chrome.storage.local.get(['authToken', 'userId']);
  if (!auth.authToken || !lastRecordingId) {
    // Fallback to full blob upload
    await autoUpload(duration, mode);
    return;
  }

  const now = new Date();
  const title = 'Recording - ' + now.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) + ' ' + now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });

  try {
    const WEBAPP_URL = 'https://screencast-eight.vercel.app';
    const res = await fetch(`${WEBAPP_URL}/api/recordings/${lastRecordingId}/assemble`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${auth.authToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ title, duration: duration || 0 }),
    });

    if (res.ok) {
      recordingState = 'idle';
      const completedId = lastRecordingId;
      lastRecordingId = null;
      await chrome.storage.session.remove(['lastRecordingId']);
      // Clean up IDB + close recorder tab
      await forwardToRecorderTab({ action: 'discardRecording' });
      await closeRecorderTab();
      chrome.runtime.sendMessage({ action: 'autoUploadComplete', recordingId: completedId }).catch(() => {});
      return;
    }

    // Assembly failed — fallback to full blob upload
    console.warn('Assembly failed, falling back to full blob upload');
    await autoUpload(duration, mode);
  } catch (err) {
    console.error('Assembly error:', err);
    await autoUpload(duration, mode);
  }
}

// === Auto Upload (full blob — fallback when progressive upload fails) ===
async function autoUpload(duration, mode) {
  console.log('[SW] autoUpload started, duration:', duration, 'mode:', mode);
  const auth = await chrome.storage.local.get(['authToken', 'userId']);
  if (!auth.authToken || !auth.userId) {
    console.log('[SW] autoUpload: NOT SIGNED IN');
    chrome.runtime.sendMessage({ action: 'autoUploadFailed', error: 'Not signed in' }).catch(() => {});
    return;
  }
  console.log('[SW] autoUpload: auth OK, userId:', auth.userId);

  const now = new Date();
  const title = 'Recording - ' + now.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) + ' ' + now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });

  const uploadMsg = { action: 'uploadToWebApp', title, duration: duration || 0, mode: mode || 'tab' };

  // Attempt 1: Upload immediately — recorder tab alive, blob in memory
  console.log('[SW] autoUpload attempt 1...');
  let result = await forwardToRecorderTab(uploadMsg);
  console.log('[SW] autoUpload attempt 1 result:', JSON.stringify(result));
  if (result && result.success) {
    recordingState = 'idle';
    lastRecordingId = null;
    await chrome.storage.session.remove(['lastRecordingId']);
    await closeRecorderTab();
    chrome.runtime.sendMessage({ action: 'autoUploadComplete', recordingId: result.recordingId }).catch(() => {});
    return;
  }

  // Attempt 2: Recorder tab may have issues — wait and retry
  await new Promise(r => setTimeout(r, 300));
  result = await forwardToRecorderTab(uploadMsg);
  if (result && result.success) {
    recordingState = 'idle';
    lastRecordingId = null;
    await chrome.storage.session.remove(['lastRecordingId']);
    await closeRecorderTab();
    chrome.runtime.sendMessage({ action: 'autoUploadComplete', recordingId: result.recordingId }).catch(() => {});
    return;
  }

  // Attempt 3: Auth token may be expired — refresh and retry
  if (result && result.error && !result.error.includes('No recording')) {
    await refreshAuthToken();
    const retry = await forwardToRecorderTab(uploadMsg);
    if (retry && retry.success) {
      recordingState = 'idle';
      lastRecordingId = null;
      await chrome.storage.session.remove(['lastRecordingId']);
      await closeRecorderTab();
      chrome.runtime.sendMessage({ action: 'autoUploadComplete', recordingId: retry.recordingId }).catch(() => {});
      return;
    }
    uploadError = retry?.error || 'Upload failed after token refresh';
  } else {
    uploadError = result?.error || 'Upload failed';
  }
  chrome.runtime.sendMessage({ action: 'autoUploadFailed', error: uploadError }).catch(() => {});
}

// === Cancel Recording (stop + discard, used by toolbar discard button) ===
async function handleCancelRecording() {
  clearInterval(timerInterval);

  if (bubbleTabId) {
    await removeBubble(bubbleTabId);
    bubbleTabId = null;
  }

  await forwardToRecorderTab({ action: 'stopRecording' });
  await forwardToRecorderTab({ action: 'discardRecording' });

  // Delete the upfront recording row if we created one
  if (lastRecordingId) {
    const auth = await chrome.storage.local.get(['authToken']);
    if (auth.authToken) {
      fetch(`${SUPABASE_URL}/rest/v1/recordings?id=eq.${lastRecordingId}`, {
        method: 'DELETE',
        headers: {
          'apikey': SUPABASE_ANON_KEY,
          'Authorization': `Bearer ${auth.authToken}`,
        },
      }).catch(() => {});
    }
    lastRecordingId = null;
    await chrome.storage.session.remove(['lastRecordingId']);
  }

  recordingState = 'idle';
  currentCameraId = null;
  await closeRecorderTab();
  chrome.runtime.sendMessage({ action: 'recordingCancelled' }).catch(() => {});
  return { success: true };
}

// === Pause/Resume ===
async function handlePauseRecording() {
  clearInterval(timerInterval);
  await forwardToRecorderTab({ action: 'pauseRecording' });
  recordingState = 'paused';
  if (bubbleTabId) {
    chrome.tabs.sendMessage(bubbleTabId, { action: 'pauseStateChanged', paused: true }).catch(() => {});
  }
  return { success: true };
}

async function handleResumeRecording() {
  startTimer();
  await forwardToRecorderTab({ action: 'resumeRecording' });
  recordingState = 'recording';
  if (bubbleTabId) {
    chrome.tabs.sendMessage(bubbleTabId, { action: 'pauseStateChanged', paused: false }).catch(() => {});
  }
  return { success: true };
}

// === Timer ===
function startTimer() {
  clearInterval(timerInterval);
  timerInterval = setInterval(() => {
    elapsedSeconds++;
    chrome.runtime.sendMessage({ action: 'timerSync', elapsed: elapsedSeconds }).catch(() => {});
    if (bubbleTabId) {
      chrome.tabs.sendMessage(bubbleTabId, { action: 'timerSync', elapsed: elapsedSeconds }).catch(() => {});
    }
    if (elapsedSeconds >= 3600) {
      handleStopRecording();
    }
  }, 1000);
}

// === Recorder Tab Management (replaces offscreen document) ===
async function ensureRecorderTab() {
  // Check if recorder tab still exists
  if (recorderTabId) {
    try {
      await chrome.tabs.get(recorderTabId);
      if (recorderTabReady) return;
      // Tab exists but might not be ready, wait for it
      await waitForRecorderTab();
      return;
    } catch {
      recorderTabId = null;
      recorderTabReady = false;
    }
  }

  // Create new pinned tab
  const tab = await chrome.tabs.create({
    url: chrome.runtime.getURL('recorder/recorder.html'),
    pinned: true,
    active: false,
  });
  recorderTabId = tab.id;
  recorderTabReady = false;

  await waitForRecorderTab();
}

async function waitForRecorderTab() {
  // Wait for tab to fully load
  for (let i = 0; i < 50; i++) {
    try {
      const tab = await chrome.tabs.get(recorderTabId);
      if (tab.status === 'complete') {
        // Small extra delay to ensure script is initialized
        await new Promise(r => setTimeout(r, 200));
        recorderTabReady = true;
        return;
      }
    } catch {
      throw new Error('Recorder tab was closed');
    }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('Recorder tab load timeout');
}

async function forwardToRecorderTab(msg) {
  console.log('[SW] forwardToRecorderTab:', msg.action, 'recorderTabId:', recorderTabId);
  if (!recorderTabId) {
    try {
      await ensureRecorderTab();
      console.log('[SW] ensureRecorderTab done, recorderTabId:', recorderTabId);
    } catch (e) {
      console.error('[SW] ensureRecorderTab failed:', e);
      return { success: false, error: 'Recorder tab not available' };
    }
  }
  try {
    const result = await chrome.runtime.sendMessage({ ...msg, target: 'recorder' });
    console.log('[SW] forwardToRecorderTab response for', msg.action, ':', JSON.stringify(result)?.slice(0, 200));
    return result;
  } catch (err) {
    console.error('[SW] forwardToRecorderTab FAILED for', msg.action, ':', err);
    return { success: false, error: err.message };
  }
}

async function closeRecorderTab() {
  if (recorderTabId) {
    try {
      await chrome.tabs.remove(recorderTabId);
    } catch {}
    recorderTabId = null;
    recorderTabReady = false;
  }
}

// === Token Refresh ===
async function refreshAuthToken() {
  try {
    const stored = await chrome.storage.local.get(['refreshToken']);
    if (!stored.refreshToken) return;

    const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_ANON_KEY,
      },
      body: JSON.stringify({ refresh_token: stored.refreshToken }),
    });

    if (res.ok) {
      const data = await res.json();
      await chrome.storage.local.set({
        authToken: data.access_token,
        refreshToken: data.refresh_token,
        userId: data.user.id,
        userEmail: data.user.email,
      });
    }
  } catch {}
}
