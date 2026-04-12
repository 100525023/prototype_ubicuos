// kiosk.js -- Touchless Kiosk P2
// MediaPipe gesture recognition + Web Speech API voice + Socket.IO

const socket = io({ query: { type: 'kiosk' } });

// App state
let menuData       = [];
let orderState     = {};
let cameraHidden   = false;

// Gesture tracking
let lastGesture      = null;
let gestureHoldStart = null;
let gestureCooldown  = false;
let presenceDetected = false;

// Fist-swipe navigation state.
// The user swipes their closed fist horizontally in the air.
// We measure frame-to-frame velocity and total travel.
// A swipe fires once both thresholds are crossed, then cooldown prevents double-fire.
let swipeOriginX  = null;   // wrist X when movement began
let swipePrevX    = null;   // wrist X previous frame
let swipeArmed    = false;  // true once speed threshold crossed at least once
let swipeFired    = false;  // true once the swipe has been sent (prevents repeat)

const HOLD_MS         = 800;
const COOLDOWN_MS     = 1200;
const SWIPE_MIN_DIST  = 0.16;   // minimum total normalised X travel to count as a swipe
const SWIPE_MIN_SPEED = 0.010;  // minimum per-frame speed to arm the swipe

// DOM references
const overlayIdle     = document.getElementById('overlay-idle');
const overlayDone     = document.getElementById('overlay-done');
const appEl           = document.getElementById('app');
const menuGrid        = document.getElementById('menu-grid');
const orderItemsEl    = document.getElementById('order-items');
const totalPriceEl    = document.getElementById('order-total-price');
const gestureLabel    = document.getElementById('gesture-label');
const statusText      = document.getElementById('status-text');
const confirmModal    = document.getElementById('confirm-modal');
const modalTotal      = document.getElementById('modal-total-price');
const toast           = document.getElementById('toast');
const voiceBar        = document.getElementById('voice-bar');
const voiceTranscript = document.getElementById('voice-transcript');
const categoryBtns    = document.querySelectorAll('.cat-btn');


// Socket events

socket.on('state:sync', (state) => {
  orderState = state;
  renderMenu();
  renderOrder();
  syncCategoryUI(state.currentCategory);
  handleStatusChange(state.status);
});

socket.on('ui:welcome', () => {
  overlayIdle.classList.remove('active');
  appEl.classList.remove('hidden');
  showToast('Bienvenido -- senala un producto para anadirlo');
});

socket.on('ui:item-added', (item) => {
  showToast(item.emoji + ' ' + item.name + ' anadido');
});

socket.on('ui:confirm-prompt', () => {
  confirmModal.classList.remove('hidden');
  modalTotal.textContent = 'Total: ' + orderState.total.toFixed(2) + ' EUR';
});

socket.on('ui:order-done', ({ orderNumber }) => {
  confirmModal.classList.add('hidden');
  document.getElementById('done-number').textContent = '#' + orderNumber;
  overlayDone.classList.add('active');
  appEl.classList.add('hidden');
  setTimeout(() => {
    overlayDone.classList.remove('active');
    overlayIdle.classList.add('active');
    presenceDetected = false;
  }, 5000);
});

socket.on('ui:voice-feedback', ({ transcript }) => {
  voiceTranscript.textContent = transcript;
  voiceBar.classList.remove('hidden');
  setTimeout(() => voiceBar.classList.add('hidden'), 3000);
});

socket.on('trigger:cancel', () => sendCancel());


// Rendering

function renderMenu() {
  const cat   = orderState.currentCategory || 'burgers';
  const items = menuData.filter(i => i.category === cat);
  menuGrid.innerHTML = '';
  items.forEach(item => {
    const card = document.createElement('div');
    card.className = 'menu-card';
    card.dataset.id = item.id;
    card.innerHTML =
      '<div class="item-emoji">' + item.emoji + '</div>' +
      '<div class="item-name">'  + item.name  + '</div>' +
      '<div class="item-price">' + item.price.toFixed(2) + ' EUR</div>' +
      '<div class="hold-ring" id="ring-' + item.id + '"></div>';
    card.addEventListener('click', () => selectItem(item.id));
    menuGrid.appendChild(card);
  });
}

function renderOrder() {
  if (!orderState.items || orderState.items.length === 0) {
    orderItemsEl.innerHTML = '<p class="empty-msg">Sin articulos todavia</p>';
    totalPriceEl.textContent = '0.00 EUR';
    return;
  }
  orderItemsEl.innerHTML = '';
  orderState.items.forEach(item => {
    const row = document.createElement('div');
    row.className = 'order-row';
    row.innerHTML =
      '<span class="row-emoji">'  + item.emoji + '</span>' +
      '<span class="row-name">'   + item.name  + '</span>' +
      '<span class="row-qty">x'   + item.qty   + '</span>' +
      '<span class="row-price">'  + (item.price * item.qty).toFixed(2) + ' EUR</span>' +
      '<button class="row-remove" onclick="removeItem(\'' + item.id + '\')">x</button>';
    orderItemsEl.appendChild(row);
  });
  const newTotal = orderState.total.toFixed(2) + ' EUR';
  if (totalPriceEl.textContent !== newTotal) {
    totalPriceEl.textContent = newTotal;
    totalPriceEl.classList.remove('bump');
    void totalPriceEl.offsetWidth;
    totalPriceEl.classList.add('bump');
  }
}

function syncCategoryUI(cat) {
  categoryBtns.forEach(btn => {
    btn.classList.toggle('active', btn.dataset.cat === cat);
  });
}

function handleStatusChange(status) {
  if (status === 'confirming') {
    confirmModal.classList.remove('hidden');
    modalTotal.textContent = 'Total: ' + orderState.total.toFixed(2) + ' EUR';
  } else {
    confirmModal.classList.add('hidden');
  }
}


// Server actions

function selectItem(id)    { socket.emit('gesture:select',   { itemId: id }); }
function sendNavigate(dir) { socket.emit('gesture:navigate', { direction: dir }); }
function sendConfirm()     { socket.emit('gesture:confirm'); }
function sendCancel()      { socket.emit('gesture:cancel'); }
function removeItem(id)    { socket.emit('order:remove-item', { itemId: id }); }


// Toast

let toastTimer;
function showToast(msg) {
  toast.textContent = msg;
  toast.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.add('hidden'), 2500);
}


// Geometry helpers

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y, (a.z || 0) - (b.z || 0));
}

function handSize(lm) {
  return dist(lm[0], lm[9]) || 0.001;
}

// A finger is extended when its tip is clearly farther from the wrist than its PIP.
// Threshold 0.13 -- conservative, fewer false positives.
function isFingerExtended(lm, tipIdx, pipIdx) {
  const sz = handSize(lm);
  return (dist(lm[tipIdx], lm[0]) - dist(lm[pipIdx], lm[0])) / sz > 0.13;
}

// Positive curl check: tip is close to the palm center.
// Used in thumb_up to ensure fingers are genuinely closed, not just short of extended.
function isFingerCurled(lm, tipIdx) {
  return dist(lm[tipIdx], lm[9]) / handSize(lm) < 0.85;
}

function isThumbExtended(lm) {
  const sz        = handSize(lm);
  const farEnough = (dist(lm[4], lm[0]) - dist(lm[3], lm[0])) / sz > 0.12;
  const spreadOut = dist(lm[4], lm[5]) / sz > 0.40;
  return farEnough && spreadOut;
}

// Thumb up -- seven independent checks.
// Each one eliminates a specific false-positive scenario (loose fist, side thumb, etc.)
function isThumbUp(lm) {
  if (!isThumbExtended(lm)) return false;

  // All four fingers must be actively curled close to the palm
  if (!isFingerCurled(lm, 8))  return false;
  if (!isFingerCurled(lm, 12)) return false;
  if (!isFingerCurled(lm, 16)) return false;
  if (!isFingerCurled(lm, 20)) return false;

  // Belt-and-suspenders: also fail the extension test
  if (isFingerExtended(lm, 8,  6))  return false;
  if (isFingerExtended(lm, 12, 10)) return false;
  if (isFingerExtended(lm, 16, 14)) return false;
  if (isFingerExtended(lm, 20, 18)) return false;

  // Thumb tip must be well above the wrist
  if (lm[4].y > lm[0].y - 0.10) return false;
  // Thumb tip above its own MCP (rules out sideways thumbs)
  if (lm[4].y > lm[2].y - 0.06) return false;
  // Thumb tip above the index MCP (confirms upward direction)
  if (lm[4].y > lm[5].y) return false;

  return true;
}

// Open palm: all four fingers clearly extended and far from a curl
function isOpenPalm(lm) {
  if (!isFingerExtended(lm, 8,  6))  return false;
  if (!isFingerExtended(lm, 12, 10)) return false;
  if (!isFingerExtended(lm, 16, 14)) return false;
  if (!isFingerExtended(lm, 20, 18)) return false;
  // Middle finger must be genuinely far out (not a half-open hand)
  if (dist(lm[12], lm[0]) / handSize(lm) < 1.4) return false;
  return true;
}

// Point: index extended, middle and ring positively curled, all others in
function isPoint(lm) {
  if (!isFingerExtended(lm, 8,  6))  return false;
  if (isFingerExtended(lm,  12, 10)) return false;
  if (isFingerExtended(lm,  16, 14)) return false;
  if (isFingerExtended(lm,  20, 18)) return false;
  if (!isFingerCurled(lm, 12))       return false;
  if (!isFingerCurled(lm, 16))       return false;
  return true;
}

// Fist: all four fingers curled and not extended
function isFist(lm) {
  if (isFingerExtended(lm, 8,  6))  return false;
  if (isFingerExtended(lm, 12, 10)) return false;
  if (isFingerExtended(lm, 16, 14)) return false;
  if (isFingerExtended(lm, 20, 18)) return false;
  return true;
}

function classifyGesture(lm) {
  if (isThumbUp(lm))  return 'thumb_up';
  if (isOpenPalm(lm)) return 'open_palm';
  if (isPoint(lm))    return 'point';
  if (isFist(lm))     return 'fist';
  return 'other';
}

// Majority vote over recent frames -- smooths out single-frame noise.
// 8 frames gives good stability without too much latency.
const GESTURE_HISTORY = [];

function smoothedGesture(raw) {
  GESTURE_HISTORY.push(raw);
  if (GESTURE_HISTORY.length > 8) GESTURE_HISTORY.shift();
  const counts = {};
  for (const g of GESTURE_HISTORY) counts[g] = (counts[g] || 0) + 1;
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
}


// Fist-swipe navigation
//
// The user closes their fist and sweeps it left or right in front of the camera.
// We track the wrist landmark (lm[0]) X position across frames.
// Two conditions must both be met before we fire:
//   1. Per-frame speed crossed SWIPE_MIN_SPEED at least once (intentional movement)
//   2. Total travel from origin crossed SWIPE_MIN_DIST (enough distance)
// The camera feed is mirrored, so positive X delta = user moving left = "left" in UI.

function handleSwipe(lm, gesture) {
  // Swipe only works with a closed fist -- clear state for any other gesture
  if (gesture !== 'fist') {
    swipeOriginX = null;
    swipePrevX   = null;
    swipeArmed   = false;
    swipeFired   = false;
    return;
  }

  const wx = lm[0].x;  // normalised 0-1, mirrored

  if (swipeOriginX === null) {
    swipeOriginX = wx;
    swipePrevX   = wx;
    swipeArmed   = false;
    swipeFired   = false;
    return;
  }

  const speed = Math.abs(wx - swipePrevX);
  const total = wx - swipeOriginX;  // negative = user moved right (mirrored)

  // Arm once speed threshold is crossed
  if (speed > SWIPE_MIN_SPEED) swipeArmed = true;

  // Fire once armed and enough total distance covered
  if (swipeArmed && !swipeFired && !gestureCooldown && Math.abs(total) > SWIPE_MIN_DIST) {
    // Mirrored feed: moving right (positive delta in camera) = user moved left
    const direction = total > 0 ? 'left' : 'right';
    socket.emit('gesture:navigate', { direction });
    showToast(direction === 'right' ? 'Siguiente categoria' : 'Categoria anterior');
    swipeFired = true;
    triggerCooldown();
    // Reset after a beat so the user can do another swipe
    setTimeout(() => {
      swipeOriginX = null;
      swipePrevX   = null;
      swipeArmed   = false;
      swipeFired   = false;
    }, COOLDOWN_MS);
  }

  swipePrevX = wx;
}


// MediaPipe setup

let hands;
const videoEl   = document.getElementById('webcam');
const canvasEl  = document.getElementById('gesture-canvas');
const canvasCtx = canvasEl.getContext('2d');

async function initMediaPipe() {
  hands = new Hands({
    locateFile: file => 'https://cdn.jsdelivr.net/npm/@mediapipe/hands/' + file,
  });
  hands.setOptions({
    maxNumHands:            1,
    modelComplexity:        1,
    minDetectionConfidence: 0.72,
    minTrackingConfidence:  0.55,
  });
  hands.onResults(onHandResults);

  const camera = new Camera(videoEl, {
    onFrame: async () => { await hands.send({ image: videoEl }); },
    width: 320, height: 240,
  });
  camera.start();
  statusText.textContent = 'Camara activa';
}

function onHandResults(results) {
  canvasEl.width  = videoEl.videoWidth  || 320;
  canvasEl.height = videoEl.videoHeight || 240;
  canvasCtx.clearRect(0, 0, canvasEl.width, canvasEl.height);

  if (!results.multiHandLandmarks || results.multiHandLandmarks.length === 0) {
    gestureLabel.textContent = '--';
    GESTURE_HISTORY.length = 0;
    swipeOriginX = null;
    swipePrevX   = null;
    swipeArmed   = false;
    swipeFired   = false;
    hidePointer();
    return;
  }

  const lm = results.multiHandLandmarks[0];

  drawConnectors(canvasCtx, lm, HAND_CONNECTIONS, { color: '#bbb', lineWidth: 1.5 });
  drawLandmarks(canvasCtx, lm, { color: '#444', lineWidth: 1, radius: 2 });

  if (!presenceDetected) {
    presenceDetected = true;
    socket.emit('gesture:presence');
  }

  const rawGesture = classifyGesture(lm);
  const gesture    = smoothedGesture(rawGesture);
  gestureLabel.textContent = gesture;

  // Navigation is handled independently -- runs every frame
  handleSwipe(lm, gesture);

  if (gestureCooldown) {
    if (gesture !== 'point') hidePointer();
    return;
  }

  if (gesture === 'fist' || gesture === 'other') {
    if (lastGesture === 'point') {
      gestureHoldStart = null;
      clearAllHoldRings();
      hidePointer();
    }
    lastGesture = gesture;
    return;
  }

  // Point + hold to select
  if (gesture === 'point') {
    if (lastGesture !== 'point') {
      gestureHoldStart = Date.now();
      lastGesture = 'point';
      clearAllHoldRings();
    } else {
      const elapsed   = Date.now() - gestureHoldStart;
      const progress  = Math.min(elapsed / HOLD_MS, 1);
      const hoveredId = getHoveredCard(lm[8]);
      if (hoveredId) {
        animateHoldRing(hoveredId, progress);
        if (elapsed >= HOLD_MS) {
          selectItem(hoveredId);
          animateCardSelect(hoveredId);
          hidePointer();
          triggerCooldown();
          gestureHoldStart = null;
          lastGesture      = null;
        }
      } else {
        clearAllHoldRings();
      }
    }
    return;
  }

  // Thumb up confirms
  if (gesture === 'thumb_up' && lastGesture !== 'thumb_up') {
    lastGesture = 'thumb_up';
    sendConfirm();
    showToast('Confirmado');
    triggerCooldown();
    return;
  }

  // Open palm cancels
  if (gesture === 'open_palm' && lastGesture !== 'open_palm') {
    lastGesture = 'open_palm';
    sendCancel();
    showToast('Cancelado');
    triggerCooldown();
    return;
  }

  lastGesture = gesture;
}

function triggerCooldown() {
  gestureCooldown = true;
  setTimeout(() => { gestureCooldown = false; lastGesture = null; }, COOLDOWN_MS);
}

function clearAllHoldRings() {
  document.querySelectorAll('.hold-ring').forEach(r => r.style.display = 'none');
}


// Pointer cursor -- follows the index fingertip while pointing

let pointerEl = null;

function getOrCreatePointer() {
  if (!pointerEl) {
    pointerEl = document.createElement('div');
    pointerEl.id = 'gesture-pointer';
    pointerEl.style.cssText =
      'position:fixed;width:22px;height:22px;border-radius:50%;' +
      'background:rgba(0,0,0,0.10);border:2px solid #111;' +
      'pointer-events:none;z-index:999;transform:translate(-50%,-50%);display:none;';
    document.body.appendChild(pointerEl);
  }
  return pointerEl;
}

function getHoveredCard(indexTip) {
  // Flip X because the camera feed is mirrored
  const screenX = (1 - indexTip.x) * window.innerWidth;
  const screenY = indexTip.y * window.innerHeight;

  const ptr = getOrCreatePointer();
  ptr.style.display = 'block';
  ptr.style.left = screenX + 'px';
  ptr.style.top  = screenY + 'px';

  let found = null;
  document.querySelectorAll('.menu-card').forEach(card => {
    const rect    = card.getBoundingClientRect();
    const hovered = screenX >= rect.left && screenX <= rect.right
                 && screenY >= rect.top  && screenY <= rect.bottom;
    card.classList.toggle('hovered', hovered);
    if (hovered) found = card.dataset.id;
  });
  return found;
}

function hidePointer() {
  if (pointerEl) pointerEl.style.display = 'none';
  document.querySelectorAll('.menu-card').forEach(c => c.classList.remove('hovered'));
}

function animateHoldRing(id, progress) {
  const ring = document.getElementById('ring-' + id);
  if (!ring) return;
  ring.style.display = 'block';
  ring.style.background =
    'conic-gradient(#111 ' + (progress * 360) + 'deg, transparent 0deg)';
}

function animateCardSelect(id) {
  const card = document.querySelector('.menu-card[data-id="' + id + '"]');
  if (card) {
    card.classList.add('selected-flash');
    setTimeout(() => card.classList.remove('selected-flash'), 600);
  }
  const ring = document.getElementById('ring-' + id);
  if (ring) ring.style.display = 'none';
}


// Voice recognition via Web Speech API
// The browser sends audio to the recognition engine which returns transcripts.
// We emit the transcript to the server where all command logic lives.
// Using continuous mode keeps the mic open; we restart on end to handle timeouts.

let recognition;
let voiceActive = false;

function initVoice() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    document.getElementById('voice-btn').style.opacity = '0.35';
    document.getElementById('voice-btn').title = 'Tu navegador no soporta reconocimiento de voz';
    return;
  }

  recognition = new SR();
  recognition.lang            = 'es-ES';
  recognition.continuous      = true;
  recognition.interimResults  = false;
  recognition.maxAlternatives = 1;

  recognition.onresult = (event) => {
    // Take the last result (most recent utterance)
    const result = event.results[event.results.length - 1];
    if (result.isFinal) {
      const transcript = result[0].transcript.trim();
      socket.emit('voice:command', { transcript });
    }
  };

  recognition.onerror = (e) => {
    // 'no-speech' and 'aborted' are normal -- don't log them as errors
    if (e.error !== 'no-speech' && e.error !== 'aborted') {
      console.warn('[voice error]', e.error);
    }
  };

  // Keep recognition alive as long as voice mode is on
  recognition.onend = () => {
    if (voiceActive) {
      try { recognition.start(); } catch (_) {}
    }
  };
}

document.getElementById('voice-btn').addEventListener('click', () => {
  if (!recognition) {
    showToast('Reconocimiento de voz no disponible en este navegador');
    return;
  }
  voiceActive = !voiceActive;
  if (voiceActive) {
    try {
      recognition.start();
    } catch (_) {
      // Already running -- that's fine
    }
    document.getElementById('voice-label').textContent = 'Activa';
    document.getElementById('voice-btn').classList.add('listening');
    showToast('Voz activada. Di "hamburguesa", "agua", "confirmar"...');
  } else {
    recognition.stop();
    document.getElementById('voice-label').textContent = 'Voz';
    document.getElementById('voice-btn').classList.remove('listening');
  }
});


// Camera preview toggle

function toggleCamera() {
  cameraHidden = !cameraHidden;
  document.getElementById('camera-container').classList.toggle('cam-hidden', cameraHidden);
}


// Boot

async function init() {
  const res = await fetch('/api/menu');
  menuData  = await res.json();

  try {
    await initMediaPipe();
  } catch (e) {
    console.warn('MediaPipe failed:', e);
    statusText.textContent = 'Camara no disponible';
  }

  initVoice();
}

init();
