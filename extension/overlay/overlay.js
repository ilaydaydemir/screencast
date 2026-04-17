const params = new URLSearchParams(location.search);
const cameraId = params.get('cam');
const elapsedInit = parseInt(params.get('elapsed') || '0', 10);

const bubbleWrap = document.getElementById('bubble-wrap');
const webcam = document.getElementById('webcam');
const timerEl = document.getElementById('timer');
const stopBtn = document.getElementById('stop-btn');
const pauseBtn = document.getElementById('pause-btn');
const discardBtn = document.getElementById('discard-btn');
const pauseSvg = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="8" y1="5" x2="8" y2="19"/><line x1="16" y1="5" x2="16" y2="19"/></svg>';
const playSvg = '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><polygon points="6,4 20,12 6,20"/></svg>';

let elapsed = elapsedInit;
let isPaused = false;

function fmt(s) {
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return m + ':' + (sec < 10 ? '0' : '') + sec;
}
timerEl.textContent = fmt(elapsed);

// Camera feed
if (cameraId) {
  navigator.mediaDevices.getUserMedia({
    video: { deviceId: { exact: cameraId }, width: { ideal: 640 }, height: { ideal: 640 } },
  }).then(stream => {
    webcam.srcObject = stream;
  }).catch(() => {
    bubbleWrap.classList.add('no-cam');
  });
} else {
  bubbleWrap.classList.add('no-cam');
}

stopBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ action: 'stopRecording' });
});
pauseBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ action: isPaused ? 'resumeRecording' : 'pauseRecording' });
});
discardBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ action: 'cancelRecording' });
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.action === 'timerSync') {
    elapsed = msg.elapsed;
    timerEl.textContent = fmt(elapsed);
  }
  if (msg.action === 'pauseStateChanged') {
    isPaused = msg.paused;
    document.getElementById('pause-svg')?.remove();
    pauseBtn.innerHTML = isPaused ? playSvg : pauseSvg;
    pauseBtn.title = isPaused ? 'Resume' : 'Pause';
  }
  if (msg.action === 'recordingStopped' || msg.action === 'closeOverlay') {
    try { if (webcam.srcObject) webcam.srcObject.getTracks().forEach(t => t.stop()); } catch {}
    window.close();
  }
});
