// kiosk.js — Touchless Kiosk P2
// Reconocimiento de gestos con MediaPipe + voz con Web Speech API + Socket.IO

const socket = io({ query: { type: 'kiosk' } });

let menuData       = [];
let orderState     = {};
let cameraHidden   = false;

// Temporización de gestos
const HOLD_MS       = 800;   // ms para seleccionar con el dedo
const COOLDOWN_MS   = 1200;  // pausa entre gestos para evitar disparos dobles
const RESET_HOLD_MS = 2000;  // ms para el gesto de reset (V)

// Sistema de confirmación por frames.
// Un gesto solo se dispara si se mantiene estable durante CONFIRM_FRAMES frames
// consecutivos. Evita activaciones accidentales al pasar entre posturas.
const CONFIRM_FRAMES = 16;
let confirmGesture = null;
let confirmCount   = 0;

// Devuelve true la primera vez que el gesto lleva CONFIRM_FRAMES frames seguidos.
function gestureConfirmed(gesture) {
  if (gesture !== confirmGesture) {
    confirmGesture = gesture;
    confirmCount   = 1;
    return false;
  }
  confirmCount++;
  return confirmCount === CONFIRM_FRAMES;
}

let gestureHoldStart = null;
let gestureCooldown  = false;
let presenceDetected = false;

// Navegación por inclinación de muñeca.
// Mide el ángulo del eje muñeca(lm[0])→palma(lm[9]) respecto a la vertical.
// Si se mantiene inclinado más de TILT_ANGLE_DEG durante TILT_HOLD_MS, navega.
const TILT_ANGLE_DEG = 28;
const TILT_HOLD_MS   = 420;

let tiltDirection  = null;
let tiltStartTime  = null;
let tiltFired      = false;

function handleTilt(lm, gesture) {
  if (gesture === 'point' || gesture === 'thumb_up') {
    resetTilt();
    return;
  }

  const dx = lm[9].x - lm[0].x;
  const dy = lm[9].y - lm[0].y;
  const angleDeg = Math.atan2(dx, -dy) * (180 / Math.PI);

  // La cámara está espejada: inclinarse a la derecha da ángulo negativo.
  let currentTilt = null;
  if (angleDeg > TILT_ANGLE_DEG)  currentTilt = 'left';
  if (angleDeg < -TILT_ANGLE_DEG) currentTilt = 'right';

  if (currentTilt === null) { resetTilt(); return; }

  if (currentTilt !== tiltDirection) {
    tiltDirection = currentTilt;
    tiltStartTime = Date.now();
    tiltFired     = false;
    return;
  }

  if (!tiltFired && !gestureCooldown && (Date.now() - tiltStartTime) >= TILT_HOLD_MS) {
    socket.emit('gesture:navigate', { direction: tiltDirection });
    showToast(tiltDirection === 'right' ? 'Siguiente categoría ▶' : '◀ Categoría anterior');
    tiltFired = true;
    triggerCooldown();
    setTimeout(resetTilt, COOLDOWN_MS);
  }
}

function resetTilt() {
  tiltDirection = null;
  tiltStartTime = null;
  tiltFired     = false;
}

// Gesto de reset total: V mantenida RESET_HOLD_MS ms.
// Difícil de hacer accidentalmente; muestra progreso en el label de cámara.
let resetHoldStart = null;

function handleResetGesture(gesture) {
  if (gesture !== 'victory') {
    resetHoldStart = null;
    return;
  }

  if (resetHoldStart === null) {
    resetHoldStart = Date.now();
    return;
  }

  const elapsed  = Date.now() - resetHoldStart;
  const progress = Math.min(elapsed / RESET_HOLD_MS, 1);
  gestureLabel.textContent = `reset ${Math.round(progress * 100)}%`;

  if (elapsed >= RESET_HOLD_MS) {
    socket.emit('session:reset');
    showToast('Pedido eliminado');
    resetHoldStart = null;
    triggerCooldown();
  }
}

// Referencias al DOM
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


// Eventos de Socket.IO

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
  showToast('Bienvenido — señala un producto para añadirlo');
});

socket.on('ui:item-added', (item) => {
  showToast(item.emoji + ' ' + item.name + ' añadido');
});

socket.on('ui:confirm-prompt', () => {
  confirmModal.classList.remove('hidden');
  modalTotal.textContent = 'Total: ' + orderState.total.toFixed(2) + ' €';
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


// Renderizado de menú y pedido

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
      '<div class="item-price">' + item.price.toFixed(2) + ' €</div>' +
      '<div class="hold-ring" id="ring-' + item.id + '"></div>';
    card.addEventListener('click', () => selectItem(item.id));
    menuGrid.appendChild(card);
  });
}

function renderOrder() {
  if (!orderState.items || orderState.items.length === 0) {
    orderItemsEl.innerHTML = '<p class="empty-msg">Sin artículos todavía</p>';
    totalPriceEl.textContent = '0.00 €';
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
      '<span class="row-price">'  + (item.price * item.qty).toFixed(2) + ' €</span>' +
      '<button class="row-remove" onclick="removeItem(\'' + item.id + '\')">×</button>';
    orderItemsEl.appendChild(row);
  });

  const newTotal = orderState.total.toFixed(2) + ' €';
  if (totalPriceEl.textContent !== newTotal) {
    totalPriceEl.textContent = newTotal;
    totalPriceEl.classList.remove('bump');
    void totalPriceEl.offsetWidth; // fuerza reflow para reiniciar la animación
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
    modalTotal.textContent = 'Total: ' + orderState.total.toFixed(2) + ' €';
  } else {
    confirmModal.classList.add('hidden');
  }
}


// Acciones enviadas al servidor
function selectItem(id)    { socket.emit('gesture:select',   { itemId: id }); }
function sendNavigate(dir) { socket.emit('gesture:navigate', { direction: dir }); }
function sendConfirm()     { socket.emit('gesture:confirm'); }
function sendCancel()      { socket.emit('gesture:cancel'); }
function removeItem(id)    { socket.emit('order:remove-item', { itemId: id }); }


// Toast de notificación

let toastTimer;
function showToast(msg) {
  toast.textContent = msg;
  toast.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.add('hidden'), 2500);
}


// Utilidades geométricas para landmarks

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y, (a.z || 0) - (b.z || 0));
}

// Distancia muñeca–palma: normaliza el resto de medidas al tamaño de la mano.
function handSize(lm) {
  return dist(lm[0], lm[9]) || 0.001;
}

// True si la punta del dedo está claramente más lejos de la muñeca que su PIP.
function isFingerExtended(lm, tipIdx, pipIdx) {
  const sz = handSize(lm);
  return (dist(lm[tipIdx], lm[0]) - dist(lm[pipIdx], lm[0])) / sz > 0.13;
}

// True si la punta del dedo está cerca del centro de la palma.
function isFingerCurled(lm, tipIdx) {
  return dist(lm[tipIdx], lm[9]) / handSize(lm) < 0.85;
}

function isThumbExtended(lm) {
  const sz        = handSize(lm);
  const farEnough = (dist(lm[4], lm[0]) - dist(lm[3], lm[0])) / sz > 0.12;
  const spreadOut = dist(lm[4], lm[5]) / sz > 0.40;
  return farEnough && spreadOut;
}

// Pulgar arriba: pulgar extendido + los cuatro dedos cerrados + punta por encima de la muñeca.
function isThumbUp(lm) {
  if (!isThumbExtended(lm)) return false;

  if (!isFingerCurled(lm, 8))  return false;
  if (!isFingerCurled(lm, 12)) return false;
  if (!isFingerCurled(lm, 16)) return false;
  if (!isFingerCurled(lm, 20)) return false;

  if (isFingerExtended(lm, 8,  6))  return false;
  if (isFingerExtended(lm, 12, 10)) return false;
  if (isFingerExtended(lm, 16, 14)) return false;
  if (isFingerExtended(lm, 20, 18)) return false;

  if (lm[4].y > lm[0].y - 0.10) return false;
  if (lm[4].y > lm[2].y - 0.06) return false;
  if (lm[4].y > lm[5].y) return false;

  return true;
}

// Palma abierta: los cuatro dedos extendidos y el corazón genuinamente largo.
function isOpenPalm(lm) {
  if (!isFingerExtended(lm, 8,  6))  return false;
  if (!isFingerExtended(lm, 12, 10)) return false;
  if (!isFingerExtended(lm, 16, 14)) return false;
  if (!isFingerExtended(lm, 20, 18)) return false;
  if (dist(lm[12], lm[0]) / handSize(lm) < 1.4) return false;
  return true;
}

// Señalar: mide la linealidad del índice (lm[5]→8) en lugar de distancia a la muñeca,
// así funciona también cuando la mano apunta horizontalmente hacia la cámara.
function isPoint(lm) {
  if (isFingerExtended(lm, 12, 10)) return false;
  if (isFingerExtended(lm, 16, 14)) return false;
  if (isFingerExtended(lm, 20, 18)) return false;
  if (!isFingerCurled(lm, 12))      return false;
  if (!isFingerCurled(lm, 16))      return false;

  const A  = lm[5];
  const B  = lm[8];
  const ab = Math.hypot(B.x - A.x, B.y - A.y, (B.z || 0) - (A.z || 0));
  if (ab < 0.001) return false;

  // Distancia perpendicular del punto P a la recta A→B.
  function pointToLineDist(P) {
    const t = ((P.x-A.x)*(B.x-A.x) + (P.y-A.y)*(B.y-A.y) + ((P.z||0)-(A.z||0))*((B.z||0)-(A.z||0))) / (ab * ab);
    const dx = A.x + t*(B.x-A.x) - P.x;
    const dy = A.y + t*(B.y-A.y) - P.y;
    const dz = (A.z||0) + t*((B.z||0)-(A.z||0)) - (P.z||0);
    return Math.hypot(dx, dy, dz);
  }

  const sz = handSize(lm);
  if (pointToLineDist(lm[6]) / sz > 0.22) return false;
  if (pointToLineDist(lm[7]) / sz > 0.22) return false;
  if (ab / sz < 0.40) return false; // descarta dedos muy escorzados

  return true;
}

// Victory/V: índice y corazón extendidos y separados, anular y meñique recogidos.
function isVictory(lm) {
  if (!isFingerExtended(lm, 8,  6))  return false;
  if (!isFingerExtended(lm, 12, 10)) return false;
  if (isFingerExtended(lm,  16, 14)) return false;
  if (isFingerExtended(lm,  20, 18)) return false;
  if (!isFingerCurled(lm, 16))       return false;
  if (!isFingerCurled(lm, 20))       return false;
  if (dist(lm[8], lm[12]) / handSize(lm) < 0.35) return false;
  return true;
}

// El orden importa: victory antes de open_palm para no confundirlos.
function classifyGesture(lm) {
  if (isThumbUp(lm))  return 'thumb_up';
  if (isVictory(lm))  return 'victory';
  if (isOpenPalm(lm)) return 'open_palm';
  if (isPoint(lm))    return 'point';
  return 'other';
}

// Votación mayoritaria sobre los últimos N frames para suavizar ruido.
const GESTURE_HISTORY = [];
const HISTORY_SIZE    = 6;

function smoothedGesture(raw) {
  GESTURE_HISTORY.push(raw);
  if (GESTURE_HISTORY.length > HISTORY_SIZE) GESTURE_HISTORY.shift();
  const counts = {};
  for (const g of GESTURE_HISTORY) counts[g] = (counts[g] || 0) + 1;
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
}


// Inicialización de MediaPipe
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
  statusText.textContent = 'Cámara activa';
}

function onHandResults(results) {
  canvasEl.width  = videoEl.videoWidth  || 320;
  canvasEl.height = videoEl.videoHeight || 240;
  canvasCtx.clearRect(0, 0, canvasEl.width, canvasEl.height);

  if (!results.multiHandLandmarks || results.multiHandLandmarks.length === 0) {
    gestureLabel.textContent = '—';
    GESTURE_HISTORY.length = 0;
    confirmGesture = null;
    confirmCount   = 0;
    resetTilt();
    resetHoldStart = null;
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

  if (gesture !== 'victory') gestureLabel.textContent = gesture;

  handleTilt(lm, gesture);
  handleResetGesture(gesture);

  if (gestureCooldown) {
    if (gesture !== 'point') hidePointer();
    return;
  }

  // Señalar + mantener: tiene su propio sistema de hold por tiempo.
  // Reseteamos el contador de confirmación mientras dura el gesto.
  if (gesture === 'point') {
    confirmGesture = 'point';
    confirmCount   = CONFIRM_FRAMES; // el point no necesita el contador

    if (gestureHoldStart === null) {
      gestureHoldStart = Date.now();
      clearAllHoldRings();
    }

    const elapsed   = Date.now() - gestureHoldStart;
    const progress  = Math.min(elapsed / HOLD_MS, 1);
    const hoveredId = getHoveredCard(lm);

    if (hoveredId) {
      animateHoldRing(hoveredId, progress);
      if (elapsed >= HOLD_MS) {
        selectItem(hoveredId);
        animateCardSelect(hoveredId);
        hidePointer();
        triggerCooldown();
        gestureHoldStart = null;
      }
    } else {
      clearAllHoldRings();
    }
    return;
  }

  // Si salimos del point, limpiamos su estado.
  if (gestureHoldStart !== null) {
    gestureHoldStart = null;
    clearAllHoldRings();
    hidePointer();
  }

  // Pulgar arriba: confirmar. Requiere CONFIRM_FRAMES frames estables.
  if (gesture === 'thumb_up' && gestureConfirmed('thumb_up')) {
    sendConfirm();
    showToast('Confirmado 👍');
    triggerCooldown();
    return;
  }

  // Palma abierta: cancelar el último paso. Requiere CONFIRM_FRAMES frames estables.
  if (gesture === 'open_palm' && gestureConfirmed('open_palm')) {
    sendCancel();
    showToast('Cancelado');
    triggerCooldown();
    return;
  }

  // Para otros gestos seguimos acumulando el contador.
  if (gesture !== 'thumb_up' && gesture !== 'open_palm') {
    gestureConfirmed(gesture);
  }
}

function triggerCooldown() {
  gestureCooldown = true;
  confirmGesture  = null;
  confirmCount    = 0;
  setTimeout(() => { gestureCooldown = false; }, COOLDOWN_MS);
}

function clearAllHoldRings() {
  document.querySelectorAll('.hold-ring').forEach(r => r.style.display = 'none');
}


// Cursor de puntero gestual (sigue la punta del índice)

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

// getHoveredCard: usa la dirección del índice (lm[5]→lm[8]) proyectada un 40% más
// allá de la punta para detectar hacia dónde apunta realmente el dedo.
// El cursor visual se muestra en la punta real para que el usuario vea su posición.
const HIT_MARGIN = 40;

function getHoveredCard(lm) {
  const dx = lm[8].x - lm[5].x;
  const dy = lm[8].y - lm[5].y;

  const PROJ = 0.40;
  const projX = lm[8].x + dx * PROJ;
  const projY = lm[8].y + dy * PROJ;

  const screenX    = (1 - projX) * window.innerWidth;
  const screenY    = projY * window.innerHeight;
  const tipScreenX = (1 - lm[8].x) * window.innerWidth;
  const tipScreenY = lm[8].y * window.innerHeight;

  const ptr = getOrCreatePointer();
  ptr.style.display = 'block';
  ptr.style.left = tipScreenX + 'px';
  ptr.style.top  = tipScreenY + 'px';

  let found = null;
  document.querySelectorAll('.menu-card').forEach(card => {
    const rect = card.getBoundingClientRect();
    const hovered = screenX >= rect.left  - HIT_MARGIN
                 && screenX <= rect.right + HIT_MARGIN
                 && screenY >= rect.top   - HIT_MARGIN
                 && screenY <= rect.bottom + HIT_MARGIN;
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


// Reconocimiento de voz (Web Speech API).
// El navegador transcribe el audio y lo enviamos al servidor, que centraliza
// toda la lógica. Modo continuo con reinicio en onend para sobrevivir timeouts.
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
    const result = event.results[event.results.length - 1];
    if (result.isFinal) {
      socket.emit('voice:command', { transcript: result[0].transcript.trim() });
    }
  };

  recognition.onerror = (e) => {
    if (e.error !== 'no-speech' && e.error !== 'aborted') {
      console.warn('[voz error]', e.error);
    }
  };

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
    try { recognition.start(); } catch (_) {}
    document.getElementById('voice-label').textContent = 'Activa';
    document.getElementById('voice-btn').classList.add('listening');
    showToast('Voz activada. Di "hamburguesa", "agua", "confirmar"…');
  } else {
    recognition.stop();
    document.getElementById('voice-label').textContent = 'Voz';
    document.getElementById('voice-btn').classList.remove('listening');
  }
});


// Toggle de la previsualización de la cámara
function toggleCamera() {
  cameraHidden = !cameraHidden;
  document.getElementById('camera-container').classList.toggle('cam-hidden', cameraHidden);
}


// Arranque
async function init() {
  const res = await fetch('/api/menu');
  menuData  = await res.json();

  try {
    await initMediaPipe();
  } catch (e) {
    console.warn('MediaPipe no disponible:', e);
    statusText.textContent = 'Cámara no disponible';
  }

  initVoice();
}

init();