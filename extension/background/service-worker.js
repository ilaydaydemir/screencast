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
let isDesktopContentScript = false; // true when desktop/window recording uses content script
let overlayWindowId = null; // floating camera+controls window (Loom-style)

// === Persist/restore state across SW restarts ===
async function persistRecordingState() {
  await chrome.storage.session.set({
    _swState: {
      recordingState, currentMode, activeTabId, bubbleTabId,
      currentCameraId, elapsedSeconds, isDesktopContentScript, lastRecordingId,
    },
  });
}

async function restoreRecordingState() {
  const { _swState } = await chrome.storage.session.get('_swState');
  if (_swState && _swState.recordingState !== 'idle') {
    recordingState = _swState.recordingState;
    currentMode = _swState.currentMode;
    activeTabId = _swState.activeTabId;
    bubbleTabId = _swState.bubbleTabId;
    currentCameraId = _swState.currentCameraId;
    elapsedSeconds = _swState.elapsedSeconds || 0;
    isDesktopContentScript = _swState.isDesktopContentScript || false;
    lastRecordingId = _swState.lastRecordingId;
    console.log('[SW] Restored state:', recordingState, currentMode, 'tab:', activeTabId);
    return true;
  }
  return false;
}

// Restore immediately on SW startup
restoreRecordingState();

// === Port connection from recorder tab / content script (keeps SW alive) ===
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'recorder') {
    port.onDisconnect.addListener(() => {
      // Recorder tab disconnected — could be closed or crashed
    });
  }
  if (port.name === 'desktopRecorder') {
    // Content script keepalive — restore state if needed
    if (port.sender && port.sender.tab) {
      activeTabId = port.sender.tab.id;
    }
    port.onDisconnect.addListener(() => {
      // Content script disconnected (tab closed/navigated)
      if (recordingState === 'recording' || recordingState === 'paused') {
        if (isDesktopContentScript) {
          recordingState = 'stopped';
          clearInterval(timerInterval);
          isDesktopContentScript = false;
          if (bubbleTabId) {
            removeBubble(bubbleTabId).catch(() => {});
            bubbleTabId = null;
          }
        }
      }
    });
  }
});

// Offscreen doc lifecycle is managed by Chrome; no tab listener needed.

// === Message Router ===
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target === 'recorder') return false;

  switch (message.action) {
    case 'getState':
      (async () => {
        if (recordingState === 'idle') await restoreRecordingState();
        sendResponse({
          state: recordingState,
          mode: currentMode,
          elapsed: elapsedSeconds,
          uploadError,
          recordingId: lastRecordingId,
        });
      })();
      return true;

    case 'ensureRecorderReady':
      ensureRecorderTab().then(() => sendResponse({ success: true })).catch(() => sendResponse({ success: false }));
      return true;

    case 'forceReset':
      // User pressed reset button — clean up everything and return to idle
      (async () => {
        await resetToIdleAndCleanup('User reset');
        sendResponse({ success: true });
      })();
      return true;

    case 'startRecording':
      handleStartRecording(message).then(sendResponse);
      return true;

    case 'stopRecording':
      (async () => {
        if (recordingState === 'idle') await restoreRecordingState();
        sendResponse(await handleStopRecording());
      })();
      return true;

    case 'pauseRecording':
      (async () => {
        if (recordingState === 'idle') await restoreRecordingState();
        sendResponse(await handlePauseRecording());
      })();
      return true;

    case 'resumeRecording':
      (async () => {
        if (recordingState === 'idle') await restoreRecordingState();
        sendResponse(await handleResumeRecording());
      })();
      return true;

    case 'cancelRecording':
      (async () => {
        if (recordingState === 'idle') await restoreRecordingState();
        sendResponse(await handleCancelRecording());
      })();
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

    case 'prepareDesktopRecording':
      (async () => {
        try {
          const { mode, cameraId, micId } = message;
          currentMode = mode;
          currentCameraId = cameraId;
          elapsedSeconds = 0;
          uploadError = null;
          isDesktopContentScript = true;

          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          activeTabId = tab.id;

          const auth = await chrome.storage.local.get(['authToken', 'userId']);
          if (!auth.authToken || !auth.userId) {
            sendResponse({ success: false, error: 'Not logged in' });
            return;
          }

          // Create recording row upfront
          let recordingId = null;
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
              recording_mode: 'screen',
              status: 'processing',
            }),
          });
          if (res.ok) {
            const [row] = await res.json();
            recordingId = row.id;
            lastRecordingId = recordingId;
            await chrome.storage.session.set({ lastRecordingId: recordingId });
          } else {
            sendResponse({ success: false, error: 'Failed to create recording row' });
            return;
          }

          sendResponse({
            success: true,
            recordingId,
            userId: auth.userId,
            authToken: auth.authToken,
          });
        } catch (err) {
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;

    case 'desktopRecordingStarted':
      // Content script started recording — inject bubble + start timer.
      // Re-set all state from message + sender (SW may have slept during picker).
      recordingState = 'recording';
      isDesktopContentScript = true;
      currentMode = message.mode || currentMode;
      currentCameraId = message.cameraId !== undefined ? message.cameraId : currentCameraId;
      if (message.recordingId) lastRecordingId = message.recordingId;
      // sender.tab.id is the tab where the content script runs
      if (sender && sender.tab) {
        activeTabId = sender.tab.id;
      }
      console.log('[SW] desktopRecordingStarted — tab:', activeTabId, 'camera:', currentCameraId, 'mode:', currentMode);
      if (activeTabId) {
        injectBubbleAndToolbar(activeTabId, currentCameraId, 0, false)
          .then(() => console.log('[SW] Bubble injected on tab', activeTabId))
          .catch(err => console.error('[SW] Bubble injection failed:', err));
        bubbleTabId = activeTabId;
      }
      startTimer();
      persistRecordingState();
      return false;

    case 'desktopRecordingStopped':
      // User clicked Chrome's "Stop sharing" button — content script auto-stops + uploads
      recordingState = 'stopped';
      clearInterval(timerInterval);
      persistRecordingState();
      // Relay to popup so it shows the done view
      chrome.runtime.sendMessage({ action: 'recordingStopped', blobSize: 1 }).catch(() => {});
      if (bubbleTabId) {
        chrome.tabs.sendMessage(bubbleTabId, { action: 'recordingStopped' }).catch(() => {});
        removeBubble(bubbleTabId).catch(() => {});
        bubbleTabId = null;
      }
      return false;

    case 'desktopRecordingComplete':
      recordingState = 'idle';
      clearInterval(timerInterval);
      isDesktopContentScript = false;
      if (message.success && !message.discarded) {
        lastRecordingId = message.recordingId;
        chrome.storage.session.set({ uploadResult: { success: true, ts: Date.now() } }).catch(() => {});
        chrome.runtime.sendMessage({ action: 'autoUploadComplete' }).catch(() => {});
      } else if (message.discarded) {
        // Delete orphaned recording row
        if (lastRecordingId) {
          (async () => {
            const auth = await chrome.storage.local.get(['authToken']);
            if (auth.authToken) {
              fetch(`${SUPABASE_URL}/rest/v1/recordings?id=eq.${lastRecordingId}`, {
                method: 'DELETE',
                headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': `Bearer ${auth.authToken}` },
              }).catch(() => {});
            }
          })();
        }
        lastRecordingId = null;
        chrome.runtime.sendMessage({ action: 'recordingCancelled' }).catch(() => {});
      } else {
        chrome.storage.session.set({ uploadResult: { success: false, error: message.error, ts: Date.now() } }).catch(() => {});
        chrome.runtime.sendMessage({ action: 'autoUploadFailed', error: message.error }).catch(() => {});
      }
      if (bubbleTabId) {
        chrome.tabs.sendMessage(bubbleTabId, { action: 'recordingStopped' }).catch(() => {});
        removeBubble(bubbleTabId);
        bubbleTabId = null;
      }
      persistRecordingState();
      return false;

    case 'desktopRecordingFailed':
      recordingState = 'idle';
      isDesktopContentScript = false;
      if (bubbleTabId) {
        removeBubble(bubbleTabId).catch(() => {});
        bubbleTabId = null;
      }
      // Delete the upfront recording row
      if (lastRecordingId) {
        (async () => {
          const auth = await chrome.storage.local.get(['authToken']);
          if (auth.authToken) {
            fetch(`${SUPABASE_URL}/rest/v1/recordings?id=eq.${lastRecordingId}`, {
              method: 'DELETE',
              headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': `Bearer ${auth.authToken}` },
            }).catch(() => {});
          }
        })();
        lastRecordingId = null;
      }
      persistRecordingState();
      // Relay to popup so it goes back to setup view
      chrome.runtime.sendMessage({ action: 'desktopRecordingFailed', error: message.error }).catch(() => {});
      return false;

    // From recorder tab
    case 'recordingStopped':
      recordingState = 'stopped';
      clearInterval(timerInterval);
      persistRecordingState();
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
  // Restore state if SW restarted
  if (recordingState === 'idle') {
    await restoreRecordingState();
  }
  if (recordingState !== 'recording' && recordingState !== 'paused') return;
  if (currentMode === 'camera-only') return;

  const newTabId = activeInfo.tabId;
  if (newTabId === bubbleTabId) return;

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
      persistRecordingState();
    }
  } catch {}
});

// === Re-inject on page navigation ===
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete') return;
  if (recordingState === 'idle') await restoreRecordingState();
  if (recordingState !== 'recording' && recordingState !== 'paused') return;
  if (tabId !== bubbleTabId) return;
  if (currentMode === 'camera-only') return;

  if (tab.url && !tab.url.startsWith('chrome://') && !tab.url.startsWith('chrome-extension://') && !tab.url.startsWith('about:')) {
    const isPaused = recordingState === 'paused';
    await injectBubbleAndToolbar(tabId, currentCameraId, elapsedSeconds, isPaused);
  }
});

// === Start Recording ===
async function handleStartRecording({ mode, cameraId, micId, desktopStreamId, sourceTabId }) {
  console.log('[SW] handleStartRecording:', mode, 'camera:', cameraId, 'mic:', micId, 'desktopStreamId:', !!desktopStreamId, 'sourceTabId:', sourceTabId);
  currentMode = mode;
  currentCameraId = cameraId;
  elapsedSeconds = 0;
  uploadError = null;
  isDesktopContentScript = false;

  // Always start with a fresh offscreen document — any previous stream would
  // block chrome.tabCapture with "Cannot capture a tab with an active stream"
  await closeRecorderTab();
  await closeOverlayWindow();

  try {
    // Prefer explicit sourceTabId from popup (popup doesn't have a tab, so SW query is ambiguous)
    let tab;
    if (sourceTabId) {
      try { tab = await chrome.tabs.get(sourceTabId); } catch {}
    }
    if (!tab) {
      const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      tab = activeTab;
    }
    if (!tab) {
      return { success: false, error: 'No active tab found' };
    }
    activeTabId = tab.id;

    if (!recorderTabReady) await ensureRecorderTab();

    let forwardMsg;
    if (mode === 'tab') {
      // Tab capture: get stream ID for the user's tab. No consumerTabId → any extension context can consume.
      console.log('[SW] Getting tab capture stream ID for tab:', tab.id);
      const tabStreamId = await chrome.tabCapture.getMediaStreamId({
        targetTabId: tab.id,
      });
      console.log('[SW] tabCaptureStreamId obtained:', tabStreamId?.slice(0, 20));
      forwardMsg = {
        action: 'startRecording',
        mode: 'tab',
        tabCaptureStreamId: tabStreamId,
        cameraId: null,
        micId,
      };
    } else {
      // Screen/Window/Camera: desktopStreamId from popup's chooseDesktopMedia, or null for camera-only
      forwardMsg = {
        action: 'startRecording',
        mode,
        desktopStreamId: desktopStreamId || null,
        cameraId: mode === 'camera-only' ? cameraId : null,
        micId,
      };
    }

    const result = await forwardToRecorderTab(forwardMsg);

    if (!result || !result.success) {
      return { success: false, error: result?.error || 'Recorder failed to start' };
    }

    // Recording started! Now create DB row (non-blocking for activation)
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
            user_id: auth.userId, title, duration: 0, file_size: 0,
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
          // Send recordingId to recorder tab for upload
          forwardToRecorderTab({
            action: 'setRecordingId',
            recordingId, userId: auth.userId, authToken: auth.authToken,
          }).catch(() => {});
        }
      } catch (e) {
        console.warn('Failed to create recording row:', e);
      }
    }

    // Offscreen document is invisible — no refocus needed.
    // Open floating overlay window (camera bubble + controls) — visible on all pages including chrome://
    try {
      const url = chrome.runtime.getURL('overlay/overlay.html') + '?cam=' + encodeURIComponent(cameraId || '') + '&elapsed=0';
      const win = await chrome.windows.create({
        url,
        type: 'popup',
        width: 180,
        height: cameraId ? 210 : 70,
        top: 60,
        left: 60,
        focused: false,
      });
      overlayWindowId = win.id;
    } catch (e) { console.warn('[SW] Overlay window failed:', e); }

    // Inject bubble — prefer the source tab, fall back to any real webpage
    const injectTab = await findInjectableTab(tab);
    if (injectTab) {
      try {
        await injectBubbleAndToolbar(injectTab.id, cameraId, 0, false);
        bubbleTabId = injectTab.id;
        // If the bubble is on a different tab than the source, bring it to front so user sees controls
        if (injectTab.id !== tab.id) {
          await chrome.tabs.update(injectTab.id, { active: true });
          await chrome.windows.update(injectTab.windowId, { focused: true });
        }
      } catch (e) { console.warn('[SW] Bubble injection failed:', e); }
    } else {
      // No injectable tab — open a minimal control page
      const controlTab = await chrome.tabs.create({
        url: 'https://www.google.com/search?q=recording+in+progress',
        active: true,
      });
      // Wait for it to load, then inject
      await new Promise(r => setTimeout(r, 2000));
      try {
        await injectBubbleAndToolbar(controlTab.id, cameraId, 0, false);
        bubbleTabId = controlTab.id;
      } catch (e) { console.warn('[SW] Fallback bubble injection failed:', e); }
    }

    startTimer();
    recordingState = 'recording';
    persistRecordingState();
    return { success: true };
  } catch (err) {
    console.error('[SW] handleStartRecording error:', err);
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
          iframe.allow = 'camera *';
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
  persistRecordingState();
  return { success: true };
}

// === Desktop/Window Recording ===
async function startDesktopRecording(mode, tab, cameraId, micId, recordingId, auth, desktopStreamId) {
  // Inject webcam bubble on active tab (skip silently on internal pages)
  try {
    if (tab.url && !tab.url.startsWith('chrome://') && !tab.url.startsWith('chrome-extension://') && !tab.url.startsWith('about:')) {
      await injectBubbleAndToolbar(tab.id, cameraId, 0, false);
      bubbleTabId = tab.id;
    }
  } catch { /* bubble is optional — will appear when user switches to a regular tab */ }

  // The popup already showed the picker and got the streamId (no targetTab binding).
  // Forward to recorder tab which uses getUserMedia({chromeMediaSource: 'desktop'}).
  const result = await forwardToRecorderTab({
    action: 'startRecording',
    mode: mode,
    desktopStreamId,
    cameraId: null, // webcam is on the active tab via content script bubble
    micId,
    recordingId,
    userId: auth.userId,
    authToken: auth.authToken,
  });

  if (!result || !result.success) {
    console.error('[SW] Recorder failed to start desktop capture:', result?.error);
    await removeBubble(tab.id);
    bubbleTabId = null;
    return { success: false, error: result?.error || 'Recorder failed to start' };
  }

  startTimer();
  recordingState = 'recording';
  return { success: true };
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

// Close overlay window when user closes it manually (stop recording)
chrome.windows.onRemoved.addListener((winId) => {
  if (winId === overlayWindowId) {
    overlayWindowId = null;
    if (recordingState === 'recording' || recordingState === 'paused') {
      handleStopRecording().catch(() => {});
    }
  }
});

// === Stop ===
async function handleStopRecording() {
  console.log('[SW] handleStopRecording called');
  clearInterval(timerInterval);
  const savedElapsed = elapsedSeconds;
  const savedMode = currentMode;

  // Desktop/window content script mode — route stop to content script on active tab
  if (isDesktopContentScript) {
    if (activeTabId) {
      chrome.tabs.sendMessage(activeTabId, { action: 'stopDesktopRecording' }).catch(() => {});
    }
    if (bubbleTabId) {
      removeBubble(bubbleTabId).catch(() => {});
      bubbleTabId = null;
    }
    // Content script handles upload via desktopRecordingComplete message
    recordingState = 'stopped';
    currentCameraId = null;
    persistRecordingState();
    return { success: true };
  }

  if (bubbleTabId) {
    await removeBubble(bubbleTabId);
    bubbleTabId = null;
  }
  await closeOverlayWindow();

  console.log('[SW] Sending stopRecording to recorder tab...');
  const stopResult = await forwardToRecorderTab({ action: 'stopRecording' });
  console.log('[SW] stopResult:', JSON.stringify(stopResult));
  recordingState = 'stopped';
  currentCameraId = null;
  persistRecordingState();

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
      chrome.storage.session.set({ uploadResult: { success: true, ts: Date.now() } }).catch(() => {});
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
    await resetToIdleAndCleanup('Not signed in');
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
    persistRecordingState();
    chrome.storage.session.set({ uploadResult: { success: true, ts: Date.now() } }).catch(() => {});
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
    persistRecordingState();
    chrome.storage.session.set({ uploadResult: { success: true, ts: Date.now() } }).catch(() => {});
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
      persistRecordingState();
      chrome.storage.session.set({ uploadResult: { success: true, ts: Date.now() } }).catch(() => {});
      chrome.runtime.sendMessage({ action: 'autoUploadComplete', recordingId: retry.recordingId }).catch(() => {});
      return;
    }
    uploadError = retry?.error || 'Upload failed after token refresh';
  } else {
    uploadError = result?.error || 'Upload failed';
  }
  // UPLOAD FAILED — reset to idle so user can start a new recording
  await resetToIdleAndCleanup(uploadError);
}

async function closeOverlayWindow() {
  if (overlayWindowId != null) {
    try { await chrome.windows.remove(overlayWindowId); } catch {}
    overlayWindowId = null;
  }
}

// === Reset state to idle after terminal upload failure ===
// CRITICAL: without this, recordingState stays 'stopped' forever and popup is stuck
async function resetToIdleAndCleanup(errorMsg) {
  console.log('[SW] resetToIdleAndCleanup:', errorMsg);
  uploadError = errorMsg;
  clearInterval(timerInterval);

  // Delete the orphan "processing" DB row so dashboard isn't cluttered
  if (lastRecordingId) {
    try {
      const auth = await chrome.storage.local.get(['authToken']);
      if (auth.authToken) {
        await fetch(`${SUPABASE_URL}/rest/v1/recordings?id=eq.${lastRecordingId}`, {
          method: 'DELETE',
          headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': `Bearer ${auth.authToken}` },
        });
      }
    } catch {}
    lastRecordingId = null;
  }

  // Clean up IDB and recorder tab
  try { await forwardToRecorderTab({ action: 'discardRecording' }); } catch {}
  try { await closeRecorderTab(); } catch {}
  try { await closeOverlayWindow(); } catch {}

  // Clean up bubble
  if (bubbleTabId) {
    removeBubble(bubbleTabId).catch(() => {});
    bubbleTabId = null;
  }

  // Reset state
  recordingState = 'idle';
  currentMode = null;
  currentCameraId = null;
  activeTabId = null;
  elapsedSeconds = 0;
  isDesktopContentScript = false;
  await chrome.storage.session.remove(['lastRecordingId', '_swState']);
  persistRecordingState();

  // Notify popup
  chrome.storage.session.set({ uploadResult: { success: false, error: errorMsg, ts: Date.now() } }).catch(() => {});
  chrome.runtime.sendMessage({ action: 'autoUploadFailed', error: errorMsg }).catch(() => {});
}

// === Cancel Recording (stop + discard, used by toolbar discard button) ===
async function handleCancelRecording() {
  clearInterval(timerInterval);

  if (bubbleTabId) {
    await removeBubble(bubbleTabId);
    bubbleTabId = null;
  }
  await closeOverlayWindow();

  // Route to content script or recorder tab depending on mode
  if (isDesktopContentScript && activeTabId) {
    chrome.tabs.sendMessage(activeTabId, { action: 'discardDesktopRecording' }).catch(() => {});
  } else {
    await forwardToRecorderTab({ action: 'stopRecording' });
    await forwardToRecorderTab({ action: 'discardRecording' });
    await closeRecorderTab();
  }

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
  isDesktopContentScript = false;
  persistRecordingState();
  chrome.runtime.sendMessage({ action: 'recordingCancelled' }).catch(() => {});
  return { success: true };
}

// === Pause/Resume ===
async function handlePauseRecording() {
  clearInterval(timerInterval);
  if (isDesktopContentScript && activeTabId) {
    chrome.tabs.sendMessage(activeTabId, { action: 'pauseDesktopRecording' }).catch(() => {});
  } else {
    await forwardToRecorderTab({ action: 'pauseRecording' });
  }
  recordingState = 'paused';
  persistRecordingState();
  if (bubbleTabId) {
    chrome.tabs.sendMessage(bubbleTabId, { action: 'pauseStateChanged', paused: true }).catch(() => {});
  }
  return { success: true };
}

async function handleResumeRecording() {
  startTimer();
  if (isDesktopContentScript && activeTabId) {
    chrome.tabs.sendMessage(activeTabId, { action: 'resumeDesktopRecording' }).catch(() => {});
  } else {
    await forwardToRecorderTab({ action: 'resumeRecording' });
  }
  recordingState = 'recording';
  persistRecordingState();
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

// === Offscreen Document Management (invisible — Loom-style) ===
const OFFSCREEN_URL = 'offscreen/offscreen.html';

async function hasOffscreenDocument() {
  if (!chrome.runtime.getContexts) return false;
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
  });
  return contexts.length > 0;
}

async function ensureRecorderTab() {
  // Keep the function name for compatibility, but create an offscreen document instead
  if (await hasOffscreenDocument()) {
    recorderTabReady = true;
    return;
  }
  try {
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: ['USER_MEDIA', 'DISPLAY_MEDIA'],
      justification: 'Record screen/tab/window/camera to video file',
    });
    // Small delay for script init
    await new Promise(r => setTimeout(r, 300));
    recorderTabReady = true;
    recorderTabId = -1; // sentinel: offscreen doc exists (not a tab)
  } catch (err) {
    // If already exists due to race, that's fine
    if (String(err).includes('Only a single offscreen')) {
      recorderTabReady = true;
      recorderTabId = -1;
      return;
    }
    throw err;
  }
}

async function forwardToRecorderTab(msg) {
  console.log('[SW] forwardToRecorderTab:', msg.action);
  if (!(await hasOffscreenDocument())) {
    try {
      await ensureRecorderTab();
    } catch (e) {
      console.error('[SW] ensureRecorderTab (offscreen) failed:', e);
      return { success: false, error: 'Offscreen doc not available: ' + e.message };
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
  try {
    if (await hasOffscreenDocument()) {
      await chrome.offscreen.closeDocument();
    }
  } catch {}
  recorderTabId = null;
  recorderTabReady = false;
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
