// Camera page - runs in extension's origin, so getUserMedia always has permission
const params = new URLSearchParams(location.search);
const deviceId = params.get('d');

(async () => {
  const v = document.getElementById('v');
  try {
    const constraints = deviceId
      ? { video: { deviceId: { exact: deviceId }, width: { ideal: 480 }, height: { ideal: 480 } } }
      : { video: { width: { ideal: 480 }, height: { ideal: 480 } } };
    v.srcObject = await navigator.mediaDevices.getUserMedia(constraints);
  } catch {
    try {
      v.srcObject = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 480 }, height: { ideal: 480 } },
      });
    } catch (e) {
      // Show fallback
      document.body.innerHTML = '<div class="fallback">No camera</div>';
    }
  }
})();
