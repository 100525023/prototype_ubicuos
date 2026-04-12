// kiosk.js — Touchless Kiosk P2
// Gestos con MediaPipe Hands + voz con Web Speech API + Socket.IO

const socket = io({ query: { type: 'kiosk' } });

let menuData         = [];
let orderState       = {};
let cameraHidden     = false;
let presenceDetected = false;

// Temporización
// GESTURE_HOLD_MS: tiempo mínimo para activar thumb_up / open_palm.
// Es el único mecanismo anti-accidental: simple, visible y consistente.
const GESTURE_HOLD_MS = 600;
const POINT_HOLD_MS   = 800;
const RESET_HOLD_MS   = 2000;
const COOLDOWN_MS     = 1000;

let activeGesture   = null;
let holdStart       = null;
let gestureCooldown = false;


// Clasificación de gestos
//
// Para los 4 dedos normales usamos tip.y < pip.y (punta por encima del nudillo).
// Funciona bien porque ambos puntos del mismo dedo se proyectan igual bajo perspectiva.
//
// Para el PULGAR no usamos Y porque su eje de movimiento es horizontal.
// Usamos la distancia lateral entre la punta del pulgar (lm[4]) y la base del
// meñique (lm[17]): cuando el pulgar está extendido hacia fuera esa distancia
// es grande; cuando está recogido dentro del puño es pequeña.
// Normalizamos con el ancho de la palma (lm[5] a lm[17]) para ser independientes
// del tamaño de mano y la distancia a la cámara.
//
// Índices MediaPipe usados:
//   pulgar tip=4, mcp=2, base meñique=17, base índice=5
//   índice:  pip=6  tip=8
//   corazón: pip=10 tip=12
//   anular:  pip=14 tip=16
//   meñique: pip=18 tip=20

function up(lm, tip, pip) { return lm[tip].y < lm[pip].y; }
function dn(lm, tip, pip) { return lm[tip].y > lm[pip].y; }

function palmWidth(lm) {
  const dx = lm[5].x - lm[17].x;
  const dy = lm[5].y - lm[17].y;
  return Math.hypot(dx, dy) || 0.001;
}

function thumbSpread(lm) {
  const dx = lm[4].x - lm[17].x;
  const dy = lm[4].y - lm[17].y;
  return Math.hypot(dx, dy) / palmWidth(lm);
}

// Pulgar arriba: pulgar bien separado de la palma + los 4 dedos cerrados.
// El umbral 1.4 equivale a que la punta esté al menos 1.4× el ancho de la palma
// de distancia del lado del meñique — imposible de cumplir con el pulgar dentro.
function isThumbUp(lm) {
  if (thumbSpread(lm) < 1.4)  return false;
  if (up(lm, 8,  6))          return false;
  if (up(lm, 12, 10))         return false;
  if (up(lm, 16, 14))         return false;
  if (up(lm, 20, 18))         return false;
  return true;
}

// Palma abierta: los 4 dedos extendidos.
function isOpenPalm(lm) {
  return up(lm, 8, 6) && up(lm, 12, 10) && up(lm, 16, 14) && up(lm, 20, 18);
}

// Señalar: solo el índice extendido.
function isPoint(lm) {
  return up(lm, 8, 6) && dn(lm, 12, 10) && dn(lm, 16, 14) && dn(lm, 20, 18);
}

// Tres dedos: índice, corazón y anular extendidos, meñique cerrado.
// Gesto de navegación "anterior" (intuitivo: mostrar dedos para pasar página).
function isThreeFingers(lm) {
  return up(lm, 8, 6) && up(lm, 12, 10) && up(lm, 16, 14) && dn(lm, 20, 18);
}

// Victory/V: índice y corazón extendidos, anular y meñique cerrados.
// Gesto de navegación "siguiente".
function isVictory(lm) {
  return up(lm, 8, 6) && up(lm, 12, 10) && dn(lm, 16, 14) && dn(lm, 20, 18);
}

// El orden importa: gestos más específicos primero.
function classifyGesture(lm) {
  if (isThumbUp(lm))      return 'thumb_up';
  if (isThreeFingers(lm)) return 'three';
  if (isVictory(lm))      return 'victory';
  if (isOpenPalm(lm))     return 'open_palm';
  if (isPoint(lm))        return 'point';
  return 'other';
}


// Navegación por número de dedos.
// victory (2 dedos) → siguiente categoría.
// three   (3 dedos) → categoría anterior.
// Requiere mantener el gesto NAV_HOLD_MS ms para evitar accidentales.
const NAV_HOLD_MS = 500;

let navGesture = null;
let navStart   = null;
let navFired   = false;

function handleNav(gesture) {
  const isNav = gesture === 'victory' || gesture === 'three';
  if (!isNav) { navGesture = null; navStart = null; navFired = false; return; }
  if (gesture !== navGesture) {
    navGesture = gesture;
    navStart   = Date.now();
    navFired   = false;
    return;
  }
  if (navFired || gestureCooldown) return;
  const prog = Math.min((Date.now() - navStart) / NAV_HOLD_MS, 1);
  setProgressBar(prog);
  if (prog >= 1) {
    const dir = gesture === 'victory' ? 'right' : 'left';
    socket.emit('gesture:navigate', { direction: dir });
    showToast(dir === 'right' ? 'Siguiente categoría ▶' : '◀ Categoría anterior');
    navFired = true;
    triggerCooldown();
  }
}


// Hold universal: devuelve progreso 0-1 para el gesto activo.
// Si el gesto cambia, reinicia el contador.
function updateHold(gesture, ms) {
  if (gesture !== activeGesture) { activeGesture = gesture; holdStart = Date.now(); }
  return Math.min((Date.now() - holdStart) / ms, 1);
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


// Eventos Socket.IO

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
  modalTotal.textContent = orderState.total.toFixed(2) + ' €';
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


// Renderizado

function renderMenu() {
  const cat   = orderState.currentCategory || 'burgers';
  const items = menuData.filter(i => i.category === cat);
  menuGrid.innerHTML = '';
  items.forEach(item => {
    const card = document.createElement('div');
    card.className  = 'menu-card';
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
    void totalPriceEl.offsetWidth;
    totalPriceEl.classList.add('bump');
  }
}

function syncCategoryUI(cat) {
  categoryBtns.forEach(btn => btn.classList.toggle('active', btn.dataset.cat === cat));
}

function handleStatusChange(status) {
  if (status === 'confirming') {
    confirmModal.classList.remove('hidden');
    modalTotal.textContent = orderState.total.toFixed(2) + ' €';
  } else {
    confirmModal.classList.add('hidden');
  }
}


// Acciones al servidor
function selectItem(id)    { socket.emit('gesture:select',   { itemId: id }); }
function sendNavigate(dir) { socket.emit('gesture:navigate', { direction: dir }); }
function sendConfirm()     { socket.emit('gesture:confirm'); }
function sendCancel()      { socket.emit('gesture:cancel'); }
function removeItem(id)    { socket.emit('order:remove-item', { itemId: id }); }

let toastTimer;
function showToast(msg) {
  toast.textContent = msg;
  toast.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.add('hidden'), 2500);
}

function triggerCooldown() {
  gestureCooldown = true;
  activeGesture   = null;
  holdStart       = null;
  setTimeout(() => { gestureCooldown = false; }, COOLDOWN_MS);
}

function clearAllHoldRings() {
  document.querySelectorAll('.hold-ring').forEach(r => r.style.display = 'none');
}


// Cursor gestual y barra de progreso

let pointerEl    = null;
let progressBar  = null;

function getOrCreatePointer() {
  if (!pointerEl) {
    pointerEl = document.createElement('div');
    pointerEl.style.cssText =
      'position:fixed;width:20px;height:20px;border-radius:50%;' +
      'background:rgba(0,0,0,0.10);border:2px solid #111;' +
      'pointer-events:none;z-index:999;transform:translate(-50%,-50%);display:none;';
    document.body.appendChild(pointerEl);
  }
  return pointerEl;
}

function setProgressBar(pct) {
  if (!progressBar) {
    progressBar = document.createElement('div');
    progressBar.style.cssText =
      'position:fixed;bottom:0;left:0;height:4px;background:#111;z-index:998;pointer-events:none;width:0;transition:width 0.05s linear;';
    document.body.appendChild(progressBar);
  }
  progressBar.style.width = (pct * 100) + '%';
}

// Proyecta la dirección del índice (lm[5]→lm[8]) un 40% más allá de la punta
// para encontrar hacia dónde apunta realmente el dedo.
function getHoveredCard(lm) {
  const dx    = lm[8].x - lm[5].x;
  const dy    = lm[8].y - lm[5].y;
  const projX = lm[8].x + dx * 0.4;
  const projY = lm[8].y + dy * 0.4;

  const screenX    = (1 - projX) * window.innerWidth;
  const screenY    = projY * window.innerHeight;
  const tipScreenX = (1 - lm[8].x) * window.innerWidth;
  const tipScreenY = lm[8].y * window.innerHeight;

  const ptr = getOrCreatePointer();
  ptr.style.display = 'block';
  ptr.style.left    = tipScreenX + 'px';
  ptr.style.top     = tipScreenY + 'px';

  let found = null;
  document.querySelectorAll('.menu-card').forEach(card => {
    const r  = card.getBoundingClientRect();
    const ok = screenX >= r.left  - 40 && screenX <= r.right + 40
            && screenY >= r.top   - 40 && screenY <= r.bottom + 40;
    card.classList.toggle('hovered', ok);
    if (ok) found = card.dataset.id;
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
  ring.style.display    = 'block';
  ring.style.background = 'conic-gradient(#111 ' + (progress * 360) + 'deg, transparent 0deg)';
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


// MediaPipe

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
    minDetectionConfidence: 0.65,
    minTrackingConfidence:  0.5,
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
    activeGesture = null;
    holdStart     = null;
    navGesture    = null;
    navStart      = null;
    navFired      = false;
    hidePointer();
    setProgressBar(0);
    return;
  }

  const lm      = results.multiHandLandmarks[0];
  const gesture = classifyGesture(lm);

  drawConnectors(canvasCtx, lm, HAND_CONNECTIONS, { color: '#bbb', lineWidth: 1.5 });
  drawLandmarks(canvasCtx, lm, { color: '#444', lineWidth: 1, radius: 2 });

  if (!presenceDetected) {
    presenceDetected = true;
    socket.emit('gesture:presence');
  }

  gestureLabel.textContent = gesture === 'other' ? '—' : gesture;

  // Navegación por dedos: corre siempre en paralelo
  handleNav(gesture);

  if (gestureCooldown) {
    if (gesture !== 'point') hidePointer();
    setProgressBar(0);
    return;
  }

  // SEÑALAR + mantener: selecciona el producto apuntado
  if (gesture === 'point') {
    if (activeGesture !== 'point') {
      activeGesture = 'point';
      holdStart     = Date.now();
      clearAllHoldRings();
    }
    const elapsed   = Date.now() - holdStart;
    const progress  = Math.min(elapsed / POINT_HOLD_MS, 1);
    const hoveredId = getHoveredCard(lm);
    setProgressBar(0);
    if (hoveredId) {
      animateHoldRing(hoveredId, progress);
      if (elapsed >= POINT_HOLD_MS) {
        selectItem(hoveredId);
        animateCardSelect(hoveredId);
        hidePointer();
        triggerCooldown();
      }
    } else {
      clearAllHoldRings();
    }
    return;
  }

  if (activeGesture === 'point') {
    clearAllHoldRings();
    hidePointer();
  }

  // PULGAR ARRIBA: confirmar (barra de progreso global)
  if (gesture === 'thumb_up') {
    const prog = updateHold('thumb_up', GESTURE_HOLD_MS);
    setProgressBar(prog);
    if (prog >= 1) {
      sendConfirm();
      showToast('Confirmado 👍');
      triggerCooldown();
    }
    return;
  }

  // PALMA ABIERTA: cancelar último paso
  if (gesture === 'open_palm') {
    const prog = updateHold('open_palm', GESTURE_HOLD_MS);
    setProgressBar(prog);
    if (prog >= 1) {
      sendCancel();
      showToast('Cancelado');
      triggerCooldown();
    }
    return;
  }

  // Ningún gesto activo: limpiamos estado
  if (gesture !== 'victory' && gesture !== 'three') {
    activeGesture = null;
    holdStart     = null;
    setProgressBar(0);
  }
  hidePointer();
}


// Voz
let recognition;
let voiceActive = false;

function initVoice() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { document.getElementById('voice-btn').style.opacity = '0.35'; return; }
  recognition = new SR();
  recognition.lang            = 'es-ES';
  recognition.continuous      = true;
  recognition.interimResults  = false;
  recognition.maxAlternatives = 1;
  recognition.onresult = (e) => {
    const r = e.results[e.results.length - 1];
    if (r.isFinal) socket.emit('voice:command', { transcript: r[0].transcript.trim() });
  };
  recognition.onerror = (e) => {
    if (e.error !== 'no-speech' && e.error !== 'aborted') console.warn('[voz]', e.error);
  };
  recognition.onend = () => {
    if (voiceActive) try { recognition.start(); } catch (_) {}
  };
}

document.getElementById('voice-btn').addEventListener('click', () => {
  if (!recognition) { showToast('Voz no disponible en este navegador'); return; }
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

function toggleCamera() {
  cameraHidden = !cameraHidden;
  document.getElementById('camera-container').classList.toggle('cam-hidden', cameraHidden);
}

async function init() {
  const res = await fetch('/api/menu');
  menuData  = await res.json();
  try { await initMediaPipe(); }
  catch (e) { console.warn('MediaPipe no disponible:', e); statusText.textContent = 'Cámara no disponible'; }
  initVoice();
}

init();