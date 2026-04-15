const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const path    = require('path');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

// Servimos los archivos estáticos de la carpeta public y registramos las rutas principales.
// redirect:false evita 301 automáticos en rutas tipo /kiosk o /display.
app.use(express.static(path.join(__dirname, '../public'), { redirect: false }));
app.get('/',        (_, res) => res.sendFile(path.join(__dirname, '../public/kiosk/index.html')));
app.get('/kiosk',   (_, res) => res.sendFile(path.join(__dirname, '../public/kiosk/index.html')));
app.get('/display', (_, res) => res.sendFile(path.join(__dirname, '../public/display/index.html')));
app.get('/api/menu', (_, res) => res.json(getMenu()));


// El estado del pedido vive aquí, en el servidor. Es la única fuente de verdad:
// todos los clientes (kiosk y display) trabajan con este objeto y reciben sus
// actualizaciones via broadcast. El historial guarda los últimos 5 pedidos.
let orderState   = freshState();
let orderHistory = [];

// Estado inicial de un pedido vacío. Se llama al arrancar y al finalizar cada sesión.
function freshState() {
  return { items: [], total: 0, status: 'idle', currentCategory: 'burgers' };
}

// Recalcula el total a partir de los artículos actuales. Siempre llamar
// después de añadir, quitar o modificar cantidades.
function recalcTotal() {
  orderState.total = orderState.items.reduce((s, i) => s + i.price * i.qty, 0);
}

// Manda el estado completo a todos los clientes conectados.
function broadcast() {
  io.emit('state:sync', orderState);
}

// Notifica el historial actualizado a todos los clientes.
function broadcastHistory() {
  io.emit('order:history', orderHistory);
}


// Aquí gestionamos cada cliente que se conecta. Tanto el kiosk como el display
// pasan por aquí; el tipo de cliente viene en el query de la conexión.
io.on('connection', (socket) => {
  const clientType = socket.handshake.query.type || 'desconocido';
  console.log(`[+] ${clientType} conectado: ${socket.id}`);

  // Al conectar mandamos el estado actual para que el cliente se sincronice
  // aunque se haya unido en mitad de una sesión.
  socket.emit('state:sync', orderState);
  socket.emit('order:history', orderHistory);

  // El cliente muestra la palma → activamos la sesión y damos la bienvenida.
  socket.on('gesture:presence', () => {
    if (orderState.status === 'idle') {
      orderState.status = 'browsing';
      broadcast();
      io.emit('ui:welcome');
    }
  });

  // El usuario navega entre categorías. La dirección puede ser 'right' (siguiente)
  // o 'left' (anterior); usamos módulo para que la lista sea circular.
  socket.on('gesture:navigate', (payload = {}) => {
    const direction = payload?.direction;
    if (direction !== 'right' && direction !== 'left') return;

    const cats = ['burgers', 'drinks', 'sides', 'desserts'];
    const i    = cats.indexOf(orderState.currentCategory);
    const idx  = i >= 0 ? i : 0;
    orderState.currentCategory = direction === 'right'
      ? cats[(idx + 1) % cats.length]
      : cats[(idx - 1 + cats.length) % cats.length];
    broadcast();
  });

  // El usuario salta directamente a una categoría apuntando con el dedo.
  socket.on('gesture:set-category', (payload = {}) => {
    const valid = ['burgers', 'drinks', 'sides', 'desserts'];
    const cat   = typeof payload?.category === 'string' ? payload.category : '';
    if (!valid.includes(cat)) return;
    orderState.currentCategory = cat;
    if (orderState.status === 'idle') orderState.status = 'browsing';
    broadcast();
  });

  // El usuario selecciona un producto. Si ya estaba en el pedido, incrementamos
  // la cantidad en lugar de duplicar la línea.
  socket.on('gesture:select', (payload = {}) => {
    const itemId = typeof payload?.itemId === 'string' ? payload.itemId : '';
    if (!itemId) return;

    const item = getMenu().find(m => m.id === itemId);
    if (!item) return;
    const existing = orderState.items.find(i => i.id === itemId);
    if (existing) {
      existing.qty += 1;
    } else {
      orderState.items.push({ ...item, qty: 1 });
    }
    recalcTotal();
    orderState.status = 'ordering';
    broadcast();
    io.emit('ui:item-added', item);
  });

  // El gesto de confirmación funciona en dos pasos: primero pide confirmación
  // y, si ya está en modo confirming, finaliza el pedido. El evento también
  // se reemite para que el display anime el gesto correspondiente.
  socket.on('gesture:confirm', () => {
    io.emit('gesture:confirm');

    if (orderState.status === 'ordering') {
      orderState.status = 'confirming';
      broadcast();
      io.emit('ui:confirm-prompt');
    } else if (orderState.status === 'confirming') {
      finaliseOrder();
    }
  });

  // Cancelar deshace el último paso sin vaciar todo el pedido:
  // si estaba confirmando, vuelve al pedido; si estaba pidiendo, elimina
  // el último artículo; si no hay nada que deshacer, reinicia la sesión.
  socket.on('gesture:cancel', () => {
    if (orderState.status === 'confirming') {
      orderState.status = 'ordering';
    } else if (orderState.status === 'ordering' && orderState.items.length > 0) {
      orderState.items.pop();
      recalcTotal();
      if (orderState.items.length === 0) orderState.status = 'browsing';
    } else {
      orderState = freshState();
    }
    broadcast();
  });

  // Elimina un artículo concreto del pedido (se usa desde el botón × de la UI).
  socket.on('order:remove-item', (payload = {}) => {
    const itemId = typeof payload?.itemId === 'string' ? payload.itemId : '';
    if (!itemId) return;

    orderState.items = orderState.items.filter(i => i.id !== itemId);
    recalcTotal();
    if (orderState.items.length === 0) orderState.status = 'browsing';
    broadcast();
  });

  // El cliente envía la transcripción de voz en crudo; nosotros la procesamos
  // aquí para mantener toda la lógica de negocio en el servidor.
  socket.on('voice:command', (payload = {}) => {
    const transcript = typeof payload?.transcript === 'string' ? payload.transcript.trim() : '';
    if (!transcript) return;

    const text = transcript.toLowerCase();
    console.log('[voz]', text);
    io.emit('ui:voice-feedback', { transcript });
    handleVoice(text);
  });

  // Reinicio completo: vacía el pedido y vuelve a la pantalla inicial.
  socket.on('session:reset', () => {
    orderState = freshState();
    broadcast();
  });

  socket.on('disconnect', () => {
    console.log(`[-] ${clientType} desconectado: ${socket.id}`);
  });
});


// Finaliza el pedido: genera un número, lo guarda en el historial (máximo 5),
// notifica a todos y reinicia el estado. El broadcast final se retrasa 4 segundos
// para que las pantallas puedan mostrar la animación de pedido completado.
function finaliseOrder() {
  const orderNumber = Math.floor(Math.random() * 90) + 10;

  orderHistory.unshift({
    number:    orderNumber,
    items:     orderState.items.map(i => ({ name: i.name, emoji: i.emoji, qty: i.qty })),
    total:     orderState.total,
    timestamp: new Date().toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' }),
  });
  if (orderHistory.length > 5) orderHistory.pop();

  io.emit('ui:order-done', { orderNumber, total: orderState.total });
  broadcastHistory();
  orderState = freshState();
  setTimeout(broadcast, 4000);
}


// Procesa los comandos de voz que llegan del kiosk. El orden de los bloques
// importa: primero navegación (que no añade artículos), luego confirmación,
// luego cancelación, luego salto a categoría y, por último, artículos concretos.
function handleVoice(text) {
  const cats = ['burgers', 'drinks', 'sides', 'desserts'];

  if (/siguiente|next|adelante|avanzar/.test(text)) {
    const i = cats.indexOf(orderState.currentCategory);
    orderState.currentCategory = cats[(i + 1) % cats.length];
    if (orderState.status === 'idle') orderState.status = 'browsing';
    broadcast();
    return;
  }

  if (/anterior|atrás|atras|volver|back|previous/.test(text)) {
    const i = cats.indexOf(orderState.currentCategory);
    orderState.currentCategory = cats[(i - 1 + cats.length) % cats.length];
    broadcast();
    return;
  }

  if (/confirmar|confirm|pagar|pay/.test(text)) {
    if (orderState.status === 'ordering') {
      orderState.status = 'confirming';
      broadcast();
      io.emit('ui:confirm-prompt');
    } else if (orderState.status === 'confirming') {
      finaliseOrder();
    }
    return;
  }

  if (/cancelar|cancel|borrar|eliminar/.test(text)) {
    if (orderState.status === 'confirming') {
      orderState.status = 'ordering';
    } else if (orderState.status === 'ordering' && orderState.items.length > 0) {
      orderState.items.pop();
      recalcTotal();
      if (orderState.items.length === 0) orderState.status = 'browsing';
    } else {
      orderState = freshState();
    }
    broadcast();
    return;
  }

  // Detectamos si el texto pide ir a una categoría. Si además coincide con un
  // artículo concreto, dejamos que la sección de artículos lo maneje para no
  // cambiar de categoría cuando el usuario solo quiere pedir algo.
  const catKeywords = {
    burgers:  /burger|hamburguesa|hamburgesa/,
    drinks:   /drink|bebida|refresco|beber|agua|cola|zumo|batido/,
    sides:    /side|acompañamiento|patata|fry|fries/,
    desserts: /dessert|postre|dulce|helado|brownie/,
  };
  for (const [cat, rx] of Object.entries(catKeywords)) {
    if (rx.test(text)) {
      const isItemCommand = itemAliases().some(({ rx: irx }) => irx.test(text));
      if (!isItemCommand) {
        orderState.currentCategory = cat;
        if (orderState.status === 'idle') orderState.status = 'browsing';
        broadcast();
        return;
      }
      break;
    }
  }

  // Intentamos añadir un artículo por su nombre o alias de voz.
  const menu = getMenu();
  for (const { id, rx } of itemAliases()) {
    if (rx.test(text)) {
      const item = menu.find(m => m.id === id);
      if (!item) continue;
      const existing = orderState.items.find(i => i.id === id);
      if (existing) {
        existing.qty += 1;
      } else {
        orderState.items.push({ ...item, qty: 1 });
      }
      recalcTotal();
      orderState.status = 'ordering';
      broadcast();
      io.emit('ui:item-added', item);
      return;
    }
  }

  // Si la transcripción no coincide con ningún comando, el feedback visual
  // de la barra de voz ya es suficiente para que el usuario lo sepa.
}

// Tabla de aliases de voz para cada artículo del menú. Las expresiones regulares
// aceptan variantes en español e inglés para que el reconocimiento sea más tolerante.
function itemAliases() {
  return [
    // Ponemos primero burgers específicas para que "hamburguesa doble"
    // no se quede en la coincidencia genérica de "hamburguesa".
    { id: 'b2', rx: /cheese burger|hamburguesa con queso|burger con queso|cheese|queso/i },
    { id: 'b3', rx: /veggie burger|hamburguesa vegetariana|veggie|vegetariana|vegetal/i },
    { id: 'b4', rx: /double stack|hamburguesa doble|burger doble|double|doble/i },
    { id: 'b1', rx: /big burger|\bhamburguesa\b|\bburger\b|big/i },
    { id: 'd1', rx: /\bcola\b|coca cola|coca/i },
    { id: 'd2', rx: /orange juice|zumo de naranja|zumo naranja|naranja/i },
    { id: 'd3', rx: /\bagua\b|water/i },
    { id: 'd4', rx: /milkshake|batido|shake/i },
    { id: 's1', rx: /french fries|patatas fritas|patatas|fries|papas/i },
    { id: 's2', rx: /onion rings|aros de cebolla|cebolla|aros/i },
    { id: 's3', rx: /nuggets|nugget|pollo/i },
    { id: 's4', rx: /coleslaw|ensalada col/i },
    { id: 'x1', rx: /ice cream|helado/i },
    { id: 'x2', rx: /brownie/i },
    { id: 'x3', rx: /apple pie|tarta de manzana|manzana/i },
  ];
}


// Catálogo de productos. En un proyecto real esto vendría de una base de datos,
// pero para el prototipo lo tenemos aquí directamente.
function getMenu() {
  return [
    { id: 'b1', category: 'burgers',  name: 'Big Burger',    price: 8.99,  emoji: '🍔' },
    { id: 'b2', category: 'burgers',  name: 'Cheese Burger', price: 7.49,  emoji: '🧀' },
    { id: 'b3', category: 'burgers',  name: 'Veggie Burger', price: 6.99,  emoji: '🥗' },
    { id: 'b4', category: 'burgers',  name: 'Double Stack',  price: 10.99, emoji: '🍔' },
    { id: 'd1', category: 'drinks',   name: 'Cola',          price: 2.49,  emoji: '🥤' },
    { id: 'd2', category: 'drinks',   name: 'Orange Juice',  price: 2.99,  emoji: '🍊' },
    { id: 'd3', category: 'drinks',   name: 'Water',         price: 1.49,  emoji: '💧' },
    { id: 'd4', category: 'drinks',   name: 'Milkshake',     price: 3.99,  emoji: '🥛' },
    { id: 's1', category: 'sides',    name: 'French Fries',  price: 3.49,  emoji: '🍟' },
    { id: 's2', category: 'sides',    name: 'Onion Rings',   price: 3.99,  emoji: '🧅' },
    { id: 's3', category: 'sides',    name: 'Nuggets x6',    price: 4.49,  emoji: '🍗' },
    { id: 's4', category: 'sides',    name: 'Coleslaw',      price: 2.49,  emoji: '🥗' },
    { id: 'x1', category: 'desserts', name: 'Ice Cream',     price: 2.99,  emoji: '🍦' },
    { id: 'x2', category: 'desserts', name: 'Brownie',       price: 3.49,  emoji: '🍫' },
    { id: 'x3', category: 'desserts', name: 'Apple Pie',     price: 3.29,  emoji: '🥧' },
  ];
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\nTouchKiosk en http://localhost:${PORT}`);
  console.log(`  Kiosk:   http://localhost:${PORT}/kiosk`);
  console.log(`  Display: http://localhost:${PORT}/display\n`);
});
