// kiosk.js — Touchless Kiosk P2
// Gestos con MediaPipe Hands + voz con Web Speech API + Socket.IO

const socket = io({ query: { type: 'kiosk' } });

let menuData         = [];
let orderState       = {};
let cameraHidden     = false;
let presenceDetected = false;

// Temporización
const GESTURE_HOLD_MS = 700;   // thumb_up y open_palm
const POINT_HOLD_MS   = 900;
const RESET_HOLD_MS   = 2500;
const NAV_HOLD_MS     = 600;
const COOLDOWN_MS     = 1200;

let gestureCooldown = false;


// Clasificación de gestos
//
// Dedos normales: tip.y < pip.y → extendido. Estable bajo perspectiva porque
// ambos puntos del mismo dedo se deforman igual.
//
// Pulgar: su eje es horizontal, no vertical. Usamos DOS condiciones combinadas:
//   1. thumbSpread: distancia punta(lm[4]) – base meñique(lm[17]) normalizada
//      con el ancho de palma. Detecta si el pulgar está físicamente separado.
//   2. lm[4].y < lm[5].y - margen: la punta del pulgar está POR ENCIMA de la
//      base del índice. Esto elimina falsos positivos cuando el puño apunta
//      hacia la cámara o está de lado (en esos casos el pulgar queda al nivel
//      o por debajo de lm[5] aunque esté "separado" lateralmente).
// Ambas condiciones deben cumplirse a la vez.
//
// Índices MediaPipe:
//   pulgar: mcp=2, tip=4
//   índice: mcp=5, pip=6, tip=8
//   corazón: mcp=9, pip=10, tip=12
//   anular: pip=14, tip=16
//   meñique: mcp=17, pip=18, tip=20

function up(lm, tip, pip) { return lm[tip].y < lm[pip].y; }
function dn(lm, tip, pip) { return lm[tip].y > lm[pip].y; }

function palmWidth(lm) {
  return Math.hypot(lm[5].x - lm[17].x, lm[5].y - lm[17].y) || 0.001;
}

function thumbSpread(lm) {
  return Math.hypot(lm[4].x - lm[17].x, lm[4].y - lm[17].y) / palmWidth(lm);
}

// Pulgar arriba: separación lateral + punta claramente por encima de la base
// del índice + los 4 dedos cerrados.
// lm[4].y < lm[5].y - 0.04 es la clave: en un puño de frente o de lado
// el pulgar nunca supera ese umbral aunque parezca separado.
function isThumbUp(lm) {
  if (thumbSpread(lm) < 1.5)          return false;  // pulgar no suficientemente separado
  if (lm[4].y > lm[5].y - 0.04)       return false;  // punta no está por encima del índice mcp
  if (lm[4].y > lm[9].y)              return false;  // tampoco por encima del corazón mcp
  if (up(lm, 8,  6))                  return false;  // índice extendido → no es puño
  if (up(lm, 12, 10))                 return false;
  if (up(lm, 16, 14))                 return false;
  if (up(lm, 20, 18))                 return false;
  return true;
}

// Palma abierta: los 4 dedos extendidos.
function isOpenPalm(lm) {
  return up(lm, 8, 6) && up(lm, 12, 10) && up(lm, 16, 14) && up(lm, 20, 18);
}

// Señalar: solo el índice extendido, los demás cerrados.
function isPoint(lm) {
  return up(lm, 8, 6) && dn(lm, 12, 10) && dn(lm, 16, 14) && dn(lm, 20, 18);
}

// Victory/V: índice y corazón extendidos, anular y meñique cerrados. → siguiente
function isVictory(lm) {
  return up(lm, 8, 6) && up(lm, 12, 10) && dn(lm, 16, 14) && dn(lm, 20, 18);
}


// Puño cerrado: ningún dedo extendido. → reset (mantenido)
function isFist(lm) {
  return dn(lm, 8, 6) && dn(lm, 12, 10) && dn(lm, 16, 14) && dn(lm, 20, 18)
      && thumbSpread(lm) < 1.1;  // pulgar también recogido
}

// El orden importa: más específicos primero para evitar ambigüedades.
function classifyGesture(lm) {
  if (isThumbUp(lm))  return 'thumb_up';
  if (isVictory(lm))  return 'victory';
  if (isOpenPalm(lm)) return 'open_palm';
  if (isFist(lm))     return 'fist';
  if (isPoint(lm))    return 'point';
  return 'other';
}


// Navegación: V con cualquier mano.
// Mano derecha del usuario → siguiente, mano izquierda → anterior.
// La cámara está espejada, así que MediaPipe etiqueta al revés:
//   handedness 'Right' = mano izquierda real del usuario → 'left'
//   handedness 'Left'  = mano derecha real del usuario   → 'right'
let navEntryStart = null;
let navHoldStart  = null;
let navFired      = false;

function handleNav(gesture, handedness) {
  if (gesture !== 'victory') {
    navEntryStart = null;
    navHoldStart  = null;
    navFired      = false;
    return;
  }
  if (navFired || gestureCooldown) return;

  // Fase de entrada
  if (navEntryStart === null) { navEntryStart = Date.now(); return; }
  if (navHoldStart === null) {
    const entryProg = Math.min((Date.now() - navEntryStart) / ENTRY_MS, 1);
    setProgressBarColor('entry');
    setProgressBar(entryProg);
    if (entryProg < 1) return;
    navHoldStart = Date.now();
  }

  // Fase de hold
  const prog = Math.min((Date.now() - navHoldStart) / NAV_HOLD_MS, 1);
  setProgressBarColor('hold');
  setProgressBar(prog);
  if (prog >= 1) {
    const dir = handedness === 'Left' ? 'right' : 'left';
    socket.emit('gesture:navigate', { direction: dir });
    showToast(dir === 'right' ? 'Siguiente categoría ▶' : '◀ Categoría anterior');
    navFired = true;
    triggerCooldown();
  }
}


// Temporización de gestos discretos.
// Cada gesto pasa por dos fases antes de activarse:
//   1. ENTRADA (ENTRY_MS): el gesto debe mantenerse este tiempo sin interrupciones
//      antes de que empiece a contar el hold. Filtra gestos de paso.
//   2. HOLD: el tiempo de confirmación propiamente dicho.
// La barra de progreso muestra la fase de hold; durante la entrada aparece en gris.
const ENTRY_MS          = 400;
const HOLD_TOLERANCE_MS = 200;  // margen para frames rogue sin reiniciar el hold

let activeGesture        = null;
let entryStart           = null;  // cuándo empezó la fase de entrada del gesto activo
let holdStart            = null;  // cuándo empezó la fase de hold (tras superar ENTRY_MS)
let holdInterruptGesture = null;
let holdInterruptStart   = null;

function updateHold(gesture, ms) {
  // Gesto distinto al activo
  if (gesture !== activeGesture) {
    if (gesture !== holdInterruptGesture) {
      holdInterruptGesture = gesture;
      holdInterruptStart   = Date.now();
    }
    // Dentro del margen de tolerancia: ignoramos el frame rogue
    if (Date.now() - holdInterruptStart < HOLD_TOLERANCE_MS) {
      return holdStart ? Math.min((Date.now() - holdStart) / ms, 1) : 0;
    }
    // Fuera del margen: cambiamos de gesto activo y reiniciamos
    activeGesture        = gesture;
    entryStart           = Date.now();
    holdStart            = null;
    holdInterruptGesture = null;
    holdInterruptStart   = null;
    setProgressBarColor('entry');
    return 0;
  }

  // Gesto correcto
  holdInterruptGesture = null;
  holdInterruptStart   = null;

  // Fase de entrada: aún no ha pasado ENTRY_MS
  if (holdStart === null) {
    const entryProg = Math.min((Date.now() - entryStart) / ENTRY_MS, 1);
    setProgressBarColor('entry');
    setProgressBar(entryProg);
    if (entryProg < 1) return 0;
    holdStart = Date.now();  // entrada superada, arranca el hold
  }

  setProgressBarColor('hold');
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
  gestureCooldown      = true;
  activeGesture        = null;
  entryStart           = null;
  holdStart            = null;
  holdInterruptGesture = null;
  holdInterruptStart   = null;
  setTimeout(() => { gestureCooldown = false; }, COOLDOWN_MS);
}

function clearAllHoldRings() {
  document.querySelectorAll('.hold-ring').forEach(r => r.style.display = 'none');
}


// Cursor gestual y barra de progreso

let pointerEl   = null;
let progressBar = null;

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
      'position:fixed;bottom:0;left:0;height:4px;background:#111;' +
      'z-index:998;pointer-events:none;width:0;transition:width 0.06s linear;';
    document.body.appendChild(progressBar);
  }
  progressBar.style.width = (pct * 100) + '%';
}

// 'entry' → gris (esperando intención), 'hold' → negro (confirmando)
function setProgressBarColor(phase) {
  if (!progressBar) return;
  progressBar.style.background = phase === 'entry' ? '#bbb' : '#111';
}

// Proyecta la dirección lm[5]→lm[8] un 40% más allá para detectar
// hacia dónde apunta el dedo, no solo dónde está la punta.
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
    const ok = screenX >= r.left - 40 && screenX <= r.right  + 40
            && screenY >= r.top  - 40 && screenY <= r.bottom + 40;
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
    minDetectionConfidence: 0.7,
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
    activeGesture        = null;
    entryStart           = null;
    holdStart            = null;
    holdInterruptGesture = null;
    holdInterruptStart   = null;
    navEntryStart = null;
    navHoldStart  = null;
    navFired      = false;
    hidePointer();
    setProgressBar(0);
    return;
  }

  const lm         = results.multiHandLandmarks[0];
  const handedness = results.multiHandedness?.[0]?.label ?? 'Right';
  const gesture    = classifyGesture(lm);

  drawConnectors(canvasCtx, lm, HAND_CONNECTIONS, { color: '#bbb', lineWidth: 1.5 });
  drawLandmarks(canvasCtx, lm, { color: '#444', lineWidth: 1, radius: 2 });

  if (!presenceDetected) {
    presenceDetected = true;
    socket.emit('gesture:presence');
  }

  gestureLabel.textContent = gesture === 'other' ? '—' : gesture;

  handleNav(gesture, handedness);

  if (gestureCooldown) {
    if (gesture !== 'point') hidePointer();
    setProgressBar(0);
    return;
  }

  // SEÑALAR + mantener: selecciona el producto apuntado
  if (gesture === 'point') {
    if (activeGesture !== 'point') {
      activeGesture = 'point';
      entryStart    = Date.now();
      holdStart     = null;
      clearAllHoldRings();
    }

    // Fase de entrada: esperamos ENTRY_MS antes de empezar a contar
    if (holdStart === null) {
      const entryProg = Math.min((Date.now() - entryStart) / ENTRY_MS, 1);
      setProgressBarColor('entry');
      setProgressBar(entryProg);
      getHoveredCard(lm); // mostramos el cursor pero sin anillo todavía
      if (entryProg < 1) return;
      holdStart = Date.now();
    }

    const elapsed   = Date.now() - holdStart;
    const progress  = Math.min(elapsed / POINT_HOLD_MS, 1);
    const hoveredId = getHoveredCard(lm);
    setProgressBarColor('hold');
    setProgressBar(0); // el punto usa el anillo de la tarjeta, no la barra global
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

  // PULGAR ARRIBA: confirmar
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

  // PUÑO CERRADO mantenido: reset total del pedido
  if (gesture === 'fist') {
    const prog = updateHold('fist', RESET_HOLD_MS);
    setProgressBar(prog);
    gestureLabel.textContent = 'reset ' + Math.round(prog * 100) + '%';
    if (prog >= 1) {
      socket.emit('session:reset');
      showToast('Pedido eliminado');
      triggerCooldown();
    }
    return;
  }

  if (gesture !== 'victory') {
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
