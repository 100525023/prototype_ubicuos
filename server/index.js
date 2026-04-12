const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const path    = require('path');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, '../public')));
app.get('/',        (_, res) => res.sendFile(path.join(__dirname, '../public/kiosk/index.html')));
app.get('/kiosk',   (_, res) => res.sendFile(path.join(__dirname, '../public/kiosk/index.html')));
app.get('/display', (_, res) => res.sendFile(path.join(__dirname, '../public/display/index.html')));
app.get('/api/menu', (_, res) => res.json(getMenu()));


// Shared order state — single source of truth for all connected clients

let orderState = freshState();

function freshState() {
  return { items: [], total: 0, status: 'idle', currentCategory: 'burgers' };
}

function recalcTotal() {
  orderState.total = orderState.items.reduce((s, i) => s + i.price * i.qty, 0);
}

function broadcast() {
  io.emit('state:sync', orderState);
}


// Socket event handlers

io.on('connection', (socket) => {
  const clientType = socket.handshake.query.type || 'unknown';
  console.log(`[+] ${clientType} connected: ${socket.id}`);

  // Send full state immediately on connect so new screens are in sync
  socket.emit('state:sync', orderState);

  socket.on('gesture:presence', () => {
    if (orderState.status === 'idle') {
      orderState.status = 'browsing';
      broadcast();
      io.emit('ui:welcome');
    }
  });

  socket.on('gesture:navigate', ({ direction }) => {
    const cats = ['burgers', 'drinks', 'sides', 'desserts'];
    const i    = cats.indexOf(orderState.currentCategory);
    orderState.currentCategory = direction === 'right'
      ? cats[(i + 1) % cats.length]
      : cats[(i - 1 + cats.length) % cats.length];
    broadcast();
  });

  socket.on('gesture:select', ({ itemId }) => {
    const item = getMenu().find(m => m.id === itemId);
    if (!item) return;
    const existing = orderState.items.find(i => i.id === itemId);
    if (existing) { existing.qty += 1; } else { orderState.items.push({ ...item, qty: 1 }); }
    recalcTotal();
    orderState.status = 'ordering';
    broadcast();
    io.emit('ui:item-added', item);
  });

  socket.on('gesture:confirm', () => {
    if (orderState.status === 'ordering') {
      orderState.status = 'confirming';
      broadcast();
      io.emit('ui:confirm-prompt');
    } else if (orderState.status === 'confirming') {
      finaliseOrder();
    }
  });

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

  socket.on('order:remove-item', ({ itemId }) => {
    orderState.items = orderState.items.filter(i => i.id !== itemId);
    recalcTotal();
    if (orderState.items.length === 0) orderState.status = 'browsing';
    broadcast();
  });

  socket.on('voice:command', ({ transcript }) => {
    const text = transcript.toLowerCase().trim();
    console.log('[voice]', text);
    io.emit('ui:voice-feedback', { transcript });
    handleVoice(text);
  });

  socket.on('session:reset', () => {
    orderState = freshState();
    broadcast();
  });

  socket.on('disconnect', () => {
    console.log(`[-] ${clientType} disconnected: ${socket.id}`);
  });
});


// Order finalisation

function finaliseOrder() {
  const orderNumber = Math.floor(Math.random() * 90) + 10;
  io.emit('ui:order-done', { orderNumber, total: orderState.total });
  orderState = freshState();
  setTimeout(broadcast, 4000);
}


// Voice command handler
//
// All mutations happen directly on orderState here — no socket re-emitting,
// which on the server side just echoes back to that one client and does nothing.
// Regex matching covers Spanish and English phrasing for every command.

function handleVoice(text) {
  const cats = ['burgers', 'drinks', 'sides', 'desserts'];

  // "siguiente" / "anterior" — step through categories
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

  // Confirm / pay
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

  // Cancel
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

  // Jump to a category by name (Spanish + English)
  const catKeywords = {
    burgers:  /burger|hamburguesa|hamburgesa/,
    drinks:   /drink|bebida|refresco|beber|agua|cola|zumo|batido/,
    sides:    /side|acompañamiento|patata|fry|fries/,
    desserts: /dessert|postre|dulce|helado|brownie/,
  };
  for (const [cat, rx] of Object.entries(catKeywords)) {
    if (rx.test(text)) {
      // Only switch category if it's not also an item command — check items first below
      // by breaking out of this block and falling through to item matching.
      // Exception: if text is purely a category word with no item detail, switch now.
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

  // Add an item by spoken name
  const menu = getMenu();
  for (const { id, rx } of itemAliases()) {
    if (rx.test(text)) {
      const item = menu.find(m => m.id === id);
      if (!item) continue;
      const existing = orderState.items.find(i => i.id === id);
      if (existing) { existing.qty += 1; } else { orderState.items.push({ ...item, qty: 1 }); }
      recalcTotal();
      orderState.status = 'ordering';
      broadcast();
      io.emit('ui:item-added', item);
      return;
    }
  }

  // Nothing matched — the transcript feedback already shown to the user is enough
}

function itemAliases() {
  return [
    { id: 'b1', rx: /big burger|big/i },
    { id: 'b2', rx: /cheese burger|cheese|queso/i },
    { id: 'b3', rx: /veggie burger|veggie|vegetariana|vegetal/i },
    { id: 'b4', rx: /double stack|double|doble/i },
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


// Menu data

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
  console.log(`\n🚀 TouchKiosk on http://localhost:${PORT}`);
  console.log(`   Kiosk:   http://localhost:${PORT}/kiosk`);
  console.log(`   Display: http://localhost:${PORT}/display\n`);
});
