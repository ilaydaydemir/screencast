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
      files: ['content/content.js'],
    });
    await new Promise(r => setTimeout(r, 200));
    await chrome.tabs.sendMessage(tab.id, { action: 'showBubble', cameraId });
    await new Promise(r => setTimeout(r, 500));
  } catch {
    // Can't inject into chrome:// or other restricted pages
    console.warn('Could not inject webcam bubble into this tab');
  }
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

  // Remove bubble from tab (all modes that had one)
  if (activeTabId) {
    try {
      await chrome.tabs.sendMessage(activeTabId, { action: 'removeBubble' });
    } catch { /* tab may be closed or no bubble */ }
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
