// Screencast - Floating Webcam Bubble (Content Script)
// Injects into the active tab during tab-mode recording

if (window.__screencastInjected) {
  // Already injected
} else {
  window.__screencastInjected = true;
}

let bubbleHost = null;
let shadowRoot = null;
let bubbleStream = null;
let currentSize = 'medium';
const SIZES = { small: 100, medium: 150, large: 200 };

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'showBubble') {
    createBubble(message.cameraId).then(() => sendResponse({ success: true }));
    return true; // async
  }
  if (message.action === 'removeBubble') {
    removeBubble();
    sendResponse({ success: true });
  }
});

async function createBubble(cameraId) {
  removeBubble();

  // Create host element
  bubbleHost = document.createElement('div');
  bubbleHost.id = 'screencast-bubble-host';
  bubbleHost.style.cssText = 'all:initial;position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;pointer-events:none;';
  document.documentElement.appendChild(bubbleHost);

  // Attach Shadow DOM
  shadowRoot = bubbleHost.attachShadow({ mode: 'open' });

  // Styles
  const style = document.createElement('style');
  style.textContent = `
    * { margin: 0; padding: 0; box-sizing: border-box; }

    .bubble {
      position: fixed;
      bottom: 24px;
      left: 24px;
      width: ${SIZES[currentSize]}px;
      height: ${SIZES[currentSize]}px;
      z-index: 2147483647;
      cursor: grab;
      pointer-events: auto;
      border-radius: 50%;
      overflow: visible;
      user-select: none;
      transition: width 0.2s ease, height 0.2s ease;
    }

    .bubble.dragging { cursor: grabbing; }

    .video-mask {
      width: 100%;
      height: 100%;
      border-radius: 50%;
      overflow: hidden;
      box-shadow: 0 4px 24px rgba(0,0,0,0.4), 0 0 0 3px rgba(255,255,255,0.9);
      transition: box-shadow 0.2s;
    }

    .bubble:hover .video-mask {
      box-shadow: 0 4px 24px rgba(0,0,0,0.5), 0 0 0 3px rgba(255,255,255,1);
    }

    .bubble.dragging .video-mask {
      box-shadow: 0 8px 32px rgba(0,0,0,0.6), 0 0 0 3px rgba(255,255,255,1);
    }

    video {
      width: 100%;
      height: 100%;
      object-fit: cover;
      transform: scaleX(-1);
      pointer-events: none;
      display: block;
    }

    .controls {
      position: absolute;
      top: -36px;
      left: 50%;
      transform: translateX(-50%);
      display: none;
      gap: 2px;
      background: rgba(0,0,0,0.85);
      border-radius: 6px;
      padding: 4px;
      pointer-events: auto;
    }

    .bubble:hover .controls { display: flex; }

    .size-btn {
      width: 26px;
      height: 26px;
      border: none;
      background: transparent;
      color: #fff;
      font-size: 11px;
      font-weight: 600;
      cursor: pointer;
      border-radius: 4px;
      font-family: -apple-system, sans-serif;
    }

    .size-btn:hover { background: rgba(255,255,255,0.2); }
    .size-btn.active { background: rgba(255,255,255,0.3); }
  `;
  shadowRoot.appendChild(style);

  // Bubble container
  const bubble = document.createElement('div');
  bubble.className = 'bubble';

  // Size controls
  const controls = document.createElement('div');
  controls.className = 'controls';
  ['small', 'medium', 'large'].forEach(size => {
    const btn = document.createElement('button');
    btn.className = `size-btn ${size === currentSize ? 'active' : ''}`;
    btn.textContent = size[0].toUpperCase();
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      currentSize = size;
      const px = SIZES[size];
      bubble.style.width = px + 'px';
      bubble.style.height = px + 'px';
      controls.querySelectorAll('.size-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
    controls.appendChild(btn);
  });
  bubble.appendChild(controls);

  // Video mask + video
  const mask = document.createElement('div');
  mask.className = 'video-mask';
  const video = document.createElement('video');
  video.autoplay = true;
  video.playsInline = true;
  video.muted = true;
  mask.appendChild(video);
  bubble.appendChild(mask);

  shadowRoot.appendChild(bubble);

  // Start webcam
  if (cameraId) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { deviceId: { exact: cameraId }, width: { ideal: 480 }, height: { ideal: 480 } },
      });
      bubbleStream = stream;
      video.srcObject = stream;
    } catch (err) {
      console.error('[Screencast] Webcam failed:', err);
    }
  }

  // Dragging
  let isDragging = false;
  let offsetX = 0, offsetY = 0;

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
    const size = SIZES[currentSize];
    let x = Math.max(0, Math.min(window.innerWidth - size, e.clientX - offsetX));
    let y = Math.max(0, Math.min(window.innerHeight - size, e.clientY - offsetY));
    bubble.style.left = x + 'px';
    bubble.style.top = y + 'px';
    bubble.style.bottom = 'auto';
  });

  document.addEventListener('mouseup', () => {
    if (isDragging) {
      isDragging = false;
      bubble.classList.remove('dragging');
    }
  });
}

function removeBubble() {
  if (bubbleStream) {
    bubbleStream.getTracks().forEach(t => t.stop());
    bubbleStream = null;
  }
  if (bubbleHost) {
    bubbleHost.remove();
    bubbleHost = null;
    shadowRoot = null;
  }
}
