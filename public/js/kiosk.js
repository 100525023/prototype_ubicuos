// kiosk.js — Touchless Kiosk P2
// Gestos con MediaPipe Hands + voz con Web Speech API + Socket.IO

const socket = io({ query: { type: 'kiosk' } });

let menuData         = [];
let orderState       = {};
let cameraHidden     = false;
let presenceDetected = false;

// Tiempos de hold para cada tipo de gesto. El de seleccionar producto es el más
// largo a propósito: queremos que el usuario tenga tiempo de apuntar con calma.
const GESTURE_HOLD_MS   = 700;
const POINT_HOLD_MS     = 1300;
const POINT_NAV_HOLD_MS = 900;
const RESET_HOLD_MS     = 2500;
const NAV_HOLD_MS       = 600;
const COOLDOWN_MS       = 1200;

let gestureCooldown = false;


// Clasificamos el gesto a partir de los landmarks de MediaPipe.
//
// Para dedos normales comparamos tip.y con pip.y: si la punta está más arriba
// en pantalla (coordenada y más pequeña), el dedo está extendido.
//
// El pulgar es especial porque su eje es horizontal, no vertical. Usamos dos
// condiciones juntas para evitar falsos positivos cuando el puño apunta a cámara:
//   1. thumbSpread: distancia normalizada entre punta del pulgar y base del meñique.
//      Nos dice si el pulgar está físicamente separado de la mano.
//   2. lm[4].y < lm[5].y - margen: la punta del pulgar está claramente por
//      encima de la base del índice. En un puño de frente o ladeado el pulgar
//      nunca supera ese umbral aunque parezca separado lateralmente.
//
// Índices MediaPipe de referencia:
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

function isThumbUp(lm) {
  if (thumbSpread(lm) < 1.5)    return false;
  if (lm[4].y > lm[5].y - 0.04) return false;
  if (lm[4].y > lm[9].y)        return false;
  if (up(lm, 8,  6))             return false;
  if (up(lm, 12, 10))            return false;
  if (up(lm, 16, 14))            return false;
  if (up(lm, 20, 18))            return false;
  return true;
}

function isOpenPalm(lm) {
  return up(lm, 8, 6) && up(lm, 12, 10) && up(lm, 16, 14) && up(lm, 20, 18);
}

// Solo el índice extendido; el resto doblados.
function isPoint(lm) {
  return up(lm, 8, 6) && dn(lm, 12, 10) && dn(lm, 16, 14) && dn(lm, 20, 18);
}

// Índice y corazón extendidos → gesto V para navegar categorías.
function isVictory(lm) {
  return up(lm, 8, 6) && up(lm, 12, 10) && dn(lm, 16, 14) && dn(lm, 20, 18);
}

// Todos los dedos doblados y el pulgar recogido → reset total del pedido.
function isFist(lm) {
  return dn(lm, 8, 6) && dn(lm, 12, 10) && dn(lm, 16, 14) && dn(lm, 20, 18)
      && thumbSpread(lm) < 1.1;
}

// Los gestos más específicos van primero para evitar que uno más genérico
// los "gane" cuando varios podrían encajar a la vez.
function classifyGesture(lm) {
  if (isThumbUp(lm))  return 'thumb_up';
  if (isVictory(lm))  return 'victory';
  if (isOpenPalm(lm)) return 'open_palm';
  if (isFist(lm))     return 'fist';
  if (isPoint(lm))    return 'point';
  return 'other';
}


// Navegación con el gesto V. La cámara está espejada, así que MediaPipe
// etiqueta las manos al revés respecto a lo que ve el usuario:
//   handedness 'Right' = mano izquierda real del usuario → navega hacia la izquierda
//   handedness 'Left'  = mano derecha real del usuario   → navega hacia la derecha
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

  if (navEntryStart === null) { navEntryStart = Date.now(); return; }
  if (navHoldStart === null) {
    const entryProg = Math.min((Date.now() - navEntryStart) / ENTRY_MS, 1);
    setProgressBarColor('entry');
    setProgressBar(entryProg);
    if (entryProg < 1) return;
    navHoldStart = Date.now();
  }

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


// Sistema de temporización de gestos con dos fases.
//
// Cada gesto pasa por una fase de "entrada" antes de que empiece a contar
// el hold real. Esto evita que un movimiento de paso dispare acciones.
//
// Fase 1 — entrada (ENTRY_MS): el gesto debe mantenerse este tiempo sin
//   cambiar. La barra de progreso se muestra en gris durante esta fase.
// Fase 2 — hold: el tiempo de confirmación propiamente dicho. La barra
//   cambia a negro/rojo para indicar que la acción está a punto de dispararse.
//
// También hay una pequeña tolerancia (HOLD_TOLERANCE_MS) para frames sueltos
// con un gesto distinto (ruido del modelo) que no reinicien el hold.

const ENTRY_MS          = 500;
const HOLD_TOLERANCE_MS = 200;

let activeGesture        = null;
let entryStart           = null;
let holdStart            = null;
let holdInterruptGesture = null;
let holdInterruptStart   = null;
let pointTargetKey       = null;

function updateHold(gesture, ms) {
  if (gesture !== activeGesture) {
    if (gesture !== holdInterruptGesture) {
      holdInterruptGesture = gesture;
      holdInterruptStart   = Date.now();
    }
    // Dentro del margen de tolerancia ignoramos el frame anómalo.
    if (Date.now() - holdInterruptStart < HOLD_TOLERANCE_MS) {
      return holdStart ? Math.min((Date.now() - holdStart) / ms, 1) : 0;
    }
    // Fuera del margen: cambiamos de gesto y reiniciamos todo.
    activeGesture        = gesture;
    entryStart           = Date.now();
    holdStart            = null;
    holdInterruptGesture = null;
    holdInterruptStart   = null;
    setProgressBarColor('entry');
    return 0;
  }

  holdInterruptGesture = null;
  holdInterruptStart   = null;

  // Todavía en fase de entrada: esperamos a que pase ENTRY_MS.
  if (holdStart === null) {
    const entryProg = Math.min((Date.now() - entryStart) / ENTRY_MS, 1);
    setProgressBarColor('entry');
    setProgressBar(entryProg);
    if (entryProg < 1) return 0;
    holdStart = Date.now();
  }

  setProgressBarColor('hold');
  return Math.min((Date.now() - holdStart) / ms, 1);
}


// Referencias al DOM que usaremos a lo largo del módulo.
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


// Eventos de Socket.IO: el servidor nos manda el estado y nosotros renderizamos.

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
  // Volvemos a la pantalla de bienvenida después de mostrar el número unos segundos.
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


// Renderizado de la cuadrícula de productos según la categoría activa.
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

// Renderiza el panel lateral del pedido. Si está vacío muestra un mensaje
// y resetea el total; si no, construye una fila por artículo.
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
  // Animamos el total con un pequeño bump cuando cambia de valor.
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


// Funciones que emiten acciones al servidor.
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

// Después de disparar una acción bloqueamos nuevos gestos durante COOLDOWN_MS
// para evitar dobles disparos y resetear todo el estado de temporización.
function triggerCooldown() {
  gestureCooldown      = true;
  activeGesture        = null;
  entryStart           = null;
  holdStart            = null;
  holdInterruptGesture = null;
  holdInterruptStart   = null;
  pointTargetKey       = null;
  setTimeout(() => { gestureCooldown = false; }, COOLDOWN_MS);
}

function clearAllHoldRings() {
  document.querySelectorAll('.hold-ring').forEach(r => r.style.display = 'none');
}


// Cursor gestual y barra de progreso global. Los creamos dinámicamente
// la primera vez que se necesitan para no contaminar el HTML con elementos
// que solo existen si hay cámara.

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

// Gris durante la fase de entrada, rojo de marca durante la fase de hold.
function setProgressBarColor(phase) {
  if (!progressBar) return;
  progressBar.style.background = phase === 'entry' ? '#bbb' : 'var(--brand, #c94a1a)';
}

// Calcula hacia dónde apunta el dedo proyectando la dirección lm[5]→lm[8]
// un 40% más allá de la punta. Esto hace que el usuario pueda apuntar a
// tarjetas sin necesidad de situar el dedo exactamente encima.
// También aplica un remapeo para compensar que las esquinas de la cámara
// no se mapean de forma lineal al espacio de pantalla.
function getPointTarget(lm) {
  const MAP_X_GAIN   = 1.10;
  const MAP_Y_GAIN   = 1.45;
  const MAP_X_OFFSET = 0.00;
  const MAP_Y_OFFSET = -0.03;

  function remapNorm(v, gain, offset) {
    const mapped = ((v - 0.5) * gain) + 0.5 + offset;
    return Math.max(0, Math.min(1, mapped));
  }

  const dx    = lm[8].x - lm[5].x;
  const dy    = lm[8].y - lm[5].y;
  const projX = lm[8].x + dx * 0.4;
  const projY = lm[8].y + dy * 0.4;

  const projXMapped = remapNorm(projX,   MAP_X_GAIN, MAP_X_OFFSET);
  const projYMapped = remapNorm(projY,   MAP_Y_GAIN, MAP_Y_OFFSET);
  const tipXMapped  = remapNorm(lm[8].x, MAP_X_GAIN, MAP_X_OFFSET);
  const tipYMapped  = remapNorm(lm[8].y, MAP_Y_GAIN, MAP_Y_OFFSET);

  // La cámara está espejada, así que invertimos el eje X al proyectar al viewport.
  const screenX    = (1 - projXMapped) * window.innerWidth;
  const screenY    = projYMapped * window.innerHeight;
  const tipScreenX = (1 - tipXMapped) * window.innerWidth;
  const tipScreenY = tipYMapped * window.innerHeight;

  const ptr = getOrCreatePointer();
  ptr.style.display = 'block';
  ptr.style.left    = tipScreenX + 'px';
  ptr.style.top     = tipScreenY + 'px';

  // Buscamos el producto más cercano al punto proyectado dentro de un margen.
  let itemFound     = null;
  let itemBestScore = Infinity;
  const ITEM_HIT_MARGIN = 28;

  document.querySelectorAll('.menu-card').forEach(card => {
    const r  = card.getBoundingClientRect();
    const ok = screenX >= r.left - ITEM_HIT_MARGIN && screenX <= r.right  + ITEM_HIT_MARGIN
            && screenY >= r.top  - ITEM_HIT_MARGIN && screenY <= r.bottom + ITEM_HIT_MARGIN;
    if (ok) {
      const cx    = r.left + r.width / 2;
      const cy    = r.top  + r.height / 2;
      const score = Math.hypot(screenX - cx, screenY - cy);
      if (score < itemBestScore) { itemBestScore = score; itemFound = card.dataset.id; }
    }
  });

  // También comprobamos si el usuario apunta a las flechas de navegación.
  let navFound     = null;
  let navBestScore = Infinity;
  const NAV_HIT_MARGIN_X = 34;
  const NAV_HIT_MARGIN_Y = 90;

  document.querySelectorAll('.arrow-btn[data-nav]').forEach(btn => {
    const r  = btn.getBoundingClientRect();
    const ok = screenX >= r.left - NAV_HIT_MARGIN_X && screenX <= r.right  + NAV_HIT_MARGIN_X
            && screenY >= r.top  - NAV_HIT_MARGIN_Y && screenY <= r.bottom + NAV_HIT_MARGIN_Y;
    if (ok) {
      const cx    = r.left + r.width / 2;
      const cy    = r.top  + r.height / 2;
      const score = Math.hypot(screenX - cx, screenY - cy);
      if (score < navBestScore) { navBestScore = score; navFound = btn.dataset.nav; }
    }
  });

  // Si hay ambos objetivos posibles, ganamos el más cercano al punto proyectado.
  let target = null;
  if (itemFound && navFound) {
    target = itemBestScore <= navBestScore
      ? { kind: 'item', value: itemFound }
      : { kind: 'nav',  value: navFound };
  } else if (itemFound) {
    target = { kind: 'item', value: itemFound };
  } else if (navFound) {
    target = { kind: 'nav', value: navFound };
  }

  // Actualizamos el estado visual de hover en tarjetas y flechas.
  document.querySelectorAll('.menu-card').forEach(card => {
    card.classList.toggle('hovered', target?.kind === 'item' && card.dataset.id === target.value);
  });
  document.querySelectorAll('.arrow-btn[data-nav]').forEach(btn => {
    btn.classList.toggle('hovered', target?.kind === 'nav' && btn.dataset.nav === target.value);
  });
  return target;
}

function hidePointer() {
  if (pointerEl) pointerEl.style.display = 'none';
  document.querySelectorAll('.menu-card').forEach(c => c.classList.remove('hovered'));
  document.querySelectorAll('.arrow-btn[data-nav]').forEach(b => b.classList.remove('hovered'));
}

// Dibuja el anillo de progreso en la tarjeta del producto mientras el usuario mantiene el gesto.
function animateHoldRing(id, progress) {
  const ring = document.getElementById('ring-' + id);
  if (!ring) return;
  ring.style.display    = 'block';
  ring.style.background = 'conic-gradient(#111 ' + (progress * 360) + 'deg, transparent 0deg)';
}

// Flash de confirmación cuando el artículo se añade al pedido.
function animateCardSelect(id) {
  const card = document.querySelector('.menu-card[data-id="' + id + '"]');
  if (card) {
    card.classList.add('selected-flash');
    setTimeout(() => card.classList.remove('selected-flash'), 600);
  }
  const ring = document.getElementById('ring-' + id);
  if (ring) ring.style.display = 'none';
}


// Inicialización de MediaPipe Hands. Cargamos el modelo desde la CDN de jsDelivr
// y arrancamos la cámara con resolución reducida para mejorar el rendimiento.
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

// Recibe los resultados de MediaPipe frame a frame y aplica la lógica de gestos.
function onHandResults(results) {
  canvasEl.width  = videoEl.videoWidth  || 320;
  canvasEl.height = videoEl.videoHeight || 240;
  canvasCtx.clearRect(0, 0, canvasEl.width, canvasEl.height);

  if (!results.multiHandLandmarks || results.multiHandLandmarks.length === 0) {
    // Sin mano en cámara: reseteamos todo el estado de temporización.
    gestureLabel.textContent = '—';
    activeGesture        = null;
    entryStart           = null;
    holdStart            = null;
    holdInterruptGesture = null;
    holdInterruptStart   = null;
    pointTargetKey       = null;
    navEntryStart = null;
    navHoldStart  = null;
    navFired      = false;
    clearAllHoldRings();
    hidePointer();
    setProgressBar(0);
    return;
  }

  const lm         = results.multiHandLandmarks[0];
  const handedness = results.multiHandedness?.[0]?.label ?? 'Right';
  const gesture    = classifyGesture(lm);

  drawConnectors(canvasCtx, lm, HAND_CONNECTIONS, { color: '#bbb', lineWidth: 1.5 });
  drawLandmarks(canvasCtx, lm, { color: '#444', lineWidth: 1, radius: 2 });

  // Arrancamos la sesión en cuanto detectamos una palma abierta por primera vez.
  if (!presenceDetected && gesture === 'open_palm') {
    presenceDetected = true;
    socket.emit('gesture:presence');
  }

  gestureLabel.textContent = gesture === 'other' ? '—' : gesture;

  // La navegación V se gestiona aparte porque puede coexistir con otros gestos.
  handleNav(gesture, handedness);

  if (gestureCooldown) {
    if (gesture !== 'point') hidePointer();
    setProgressBar(0);
    return;
  }

  // Gesto de señalar: el usuario apunta a un producto o a una flecha.
  if (gesture === 'point') {
    const target    = getPointTarget(lm);
    const targetKey = target ? (target.kind + ':' + target.value) : null;

    if (!target) {
      activeGesture  = 'point';
      pointTargetKey = null;
      entryStart     = Date.now();
      holdStart      = null;
      clearAllHoldRings();
      setProgressBarColor('entry');
      setProgressBar(0);
      return;
    }

    // Si el usuario cambia de objetivo reiniciamos el hold para evitar
    // que seleccione el producto incorrecto por inercia.
    if (activeGesture !== 'point' || pointTargetKey !== targetKey) {
      activeGesture  = 'point';
      pointTargetKey = targetKey;
      entryStart     = Date.now();
      holdStart      = null;
      clearAllHoldRings();
    }

    if (holdStart === null) {
      const entryProg = Math.min((Date.now() - entryStart) / ENTRY_MS, 1);
      setProgressBarColor('entry');
      setProgressBar(entryProg);
      if (entryProg < 1) return;
      holdStart = Date.now();
    }

    const elapsed  = Date.now() - holdStart;
    const holdMs   = target.kind === 'nav' ? POINT_NAV_HOLD_MS : POINT_HOLD_MS;
    const progress = Math.min(elapsed / holdMs, 1);
    setProgressBarColor('hold');
    if (target.kind === 'item') {
      setProgressBar(0);
      animateHoldRing(target.value, progress);
    } else {
      clearAllHoldRings();
      setProgressBar(progress);
    }

    if (elapsed >= holdMs) {
      if (target.kind === 'item') {
        selectItem(target.value);
        animateCardSelect(target.value);
      } else {
        sendNavigate(target.value);
        showToast(target.value === 'right' ? 'Siguiente categoría ▶' : '◀ Categoría anterior');
      }
      hidePointer();
      triggerCooldown();
    }
    return;
  }

  if (activeGesture === 'point') {
    pointTargetKey = null;
    clearAllHoldRings();
    hidePointer();
  }

  // Pulgar arriba → confirma o pasa al modal de pago.
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

  // Palma abierta → cancela el último paso.
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

  // Puño mantenido más tiempo → borra todo el pedido y empieza de cero.
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


// Control por voz con la Web Speech API. Solo funciona en Chrome y Edge.
// Si el navegador no lo soporta, deshabilitamos visualmente el botón.
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
  // Reiniciamos automáticamente si el reconocimiento para en modo continuo.
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

// Punto de entrada: cargamos el menú, iniciamos MediaPipe y configuramos la voz.
async function init() {
  const res = await fetch('/api/menu');
  menuData  = await res.json();
  try { await initMediaPipe(); }
  catch (e) { console.warn('MediaPipe no disponible:', e); statusText.textContent = 'Cámara no disponible'; }
  initVoice();
}

init();
