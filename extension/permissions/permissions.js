const allowBtn = document.getElementById('allow-btn');
const doneBtn = document.getElementById('done-btn');
const status = document.getElementById('status');
const preview = document.getElementById('preview');
const cameraFeed = document.getElementById('camera-feed');

let stream = null;

allowBtn.addEventListener('click', async () => {
  allowBtn.disabled = true;
  allowBtn.textContent = 'Requesting...';
  status.textContent = '';
  status.className = '';

  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    cameraFeed.srcObject = stream;
    preview.classList.add('visible');
    status.textContent = 'Camera and microphone access granted!';
    status.className = 'success';
    allowBtn.textContent = 'Access Granted';

    // Store permission flag
    await chrome.storage.local.set({ mediaPermissionGranted: true });

    doneBtn.style.display = 'inline-block';
  } catch (err) {
    // Try individually
    let cameraOk = false;
    let micOk = false;

    try {
      const vs = await navigator.mediaDevices.getUserMedia({ video: true });
      cameraFeed.srcObject = vs;
      preview.classList.add('visible');
      stream = vs;
      cameraOk = true;
    } catch {}

    try {
      const as = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (stream) {
        as.getAudioTracks().forEach(t => stream.addTrack(t));
      } else {
        stream = as;
      }
      micOk = true;
    } catch {}

    if (cameraOk || micOk) {
      const parts = [];
      if (cameraOk) parts.push('camera');
      if (micOk) parts.push('microphone');
      status.textContent = `${parts.join(' and ')} access granted!`;
      status.className = 'success';
      allowBtn.textContent = 'Access Granted';
      await chrome.storage.local.set({ mediaPermissionGranted: true });
      doneBtn.style.display = 'inline-block';
    } else {
      status.textContent = 'Permission denied. Please click Allow when Chrome asks for camera/mic access.';
      status.className = 'error';
      allowBtn.disabled = false;
      allowBtn.textContent = 'Try Again';
    }
  }
});

doneBtn.addEventListener('click', () => {
  if (stream) {
    stream.getTracks().forEach(t => t.stop());
  }
  window.close();
});
