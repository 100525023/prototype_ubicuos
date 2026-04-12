# 🍔 Touchless Kiosk — SIU P2

**Sistemas Interactivos y Ubicuos · Grupo 9**  
Adam Kowalczyk Holtsova · Mohamed Rida Chahdaoui Moujib · David Benito Gil

---

## Descripción

Quiosco de comida rápida **sin contacto táctil**, controlado mediante:
- 👍 **Gestos de mano** (MediaPipe Hands via webcam)
- 🎙️ **Comandos de voz** (Web Speech API)
- 📡 **Sincronización en tiempo real** entre dispositivos (Socket.IO)

---

## Requisitos

- **Node.js** v18 o superior
- Navegador con soporte WebRTC + Web Speech API (Chrome/Edge recomendado)
- Webcam (para detección de gestos)
- Red local compartida para multi-dispositivo

---

## Instalación y ejecución

```bash
# 1. Clonar / descomprimir el proyecto
cd touchless-kiosk

# 2. Instalar dependencias
npm install

# 3. Arrancar el servidor
npm start
```

El servidor arranca en **http://localhost:3000**

---

## URLs del sistema

| Pantalla | URL | Descripción |
|---|---|---|
| Kiosk (interacción) | `http://localhost:3000/kiosk` | Pantalla de pedido con cámara y gestos |
| Display (TV/mostrador) | `http://localhost:3000/display` | Pantalla secundaria con resumen del pedido |

Para acceder desde otro dispositivo en la misma red, sustituye `localhost` por la IP del servidor (p.ej. `http://192.168.1.X:3000/display`).

---

## Gestos implementados

| Gesto | Acción |
|---|---|
| 🚶 Presencia (wrist detectado) | Inicia la sesión automáticamente |
| ☝️ Señalar + mantener ~0.8s | Selecciona el producto sobre el que apuntas |
| ✌️ Deslizar lateralmente | Cambia de categoría (izq/der) |
| 👍 Pulgar arriba | Confirma selección / pago |
| ✋ Palma abierta | Cancela / vuelve atrás |

---

## Comandos de voz

Activa el micrófono con el botón 🎙️ de la pantalla kiosk y di:

- **Nombre del producto**: `"burger"`, `"cola"`, `"fries"`...
- **Categoría**: `"burgers"`, `"drinks"`, `"sides"`, `"desserts"`
- **Navegación**: `"siguiente"` / `"next"`
- **Confirmar**: `"confirmar"` / `"pagar"` / `"confirm"`
- **Cancelar**: `"cancelar"` / `"atrás"` / `"cancel"`

---

## Arquitectura

```
[Webcam / Micrófono]
        │
[MediaPipe Hands / Web Speech API]
        │
[Socket.IO Client — Kiosk]
        │  WebSocket (TCP)
[Node.js + Express + Socket.IO — Server :3000]
        │  WebSocket broadcast
[Socket.IO Client — Display]
```

---

## Estructura del proyecto

```
touchless-kiosk/
├── server/
│   └── index.js          # Servidor Node.js + Express + Socket.IO
├── public/
│   ├── kiosk/
│   │   └── index.html    # Pantalla de interacción (gestos + voz)
│   ├── display/
│   │   └── index.html    # Pantalla secundaria (TV/mostrador)
│   ├── css/
│   │   └── kiosk.css     # Estilos pantalla kiosk
│   └── js/
│       └── kiosk.js      # Lógica gestos + voz + Socket.IO cliente
├── package.json
└── README.md
```
