# Touchless Kiosk — SIU P2

**Sistemas Interactivos y Ubicuos · Grupo 9**  
Adam Kowalczyk Holtsova · Mohamed Rida Chahdaoui Moujib · David Benito Gil

---

## Descripción

Quiosco de comida rápida sin contacto táctil, controlado mediante gestos de mano capturados por webcam (MediaPipe Hands), comandos de voz (Web Speech API) y sincronización en tiempo real entre dispositivos (Socket.IO).

---

## Requisitos

- Node.js v18 o superior
- Chrome o Edge (necesitan WebRTC y Web Speech API; Firefox no soporta la API de voz)
- Webcam para la detección de gestos
- Red local compartida si se quiere usar la pantalla display en otro dispositivo

---

## Instalación y arranque

```bash
cd touchless-kiosk
npm install
npm start
```

El servidor arranca en http://localhost:3000

---

## Pantallas del sistema

| Pantalla | URL | Uso |
|---|---|---|
| Kiosk | `http://localhost:3000/kiosk` | Pantalla principal de pedido con cámara y gestos |
| Display | `http://localhost:3000/display` | Pantalla secundaria para el mostrador |

Para acceder al display desde otro dispositivo en la misma red, sustituye `localhost` por la IP del servidor (por ejemplo: `http://192.168.1.X:3000/display`).

---

## Gestos

| Gesto | Acción |
|---|---|
| Presencia (muñeca detectada) | Inicia la sesión automáticamente |
| Señalar con el índice y mantener ~0.8 s | Selecciona el producto sobre el que apuntas |
| Inclinar la muñeca hacia un lado | Cambia de categoría (izquierda / derecha) |
| Pulgar arriba | Confirma selección o pago |
| Palma abierta | Cancela el último paso |
| V (índice + corazón) mantenida 2 s | Elimina todo el pedido — difícil de activar accidentalmente |

La navegación por inclinación de muñeca funciona midiendo el ángulo del eje muñeca–palma respecto a la vertical. Basta con inclinar la mano unos 28 grados durante medio segundo; no hace falta hacer ningún movimiento brusco.

El gesto de reset total (V mantenida) requiere mantener los dos dedos extendidos y separados durante dos segundos seguidos. El porcentaje de progreso aparece en el indicador de la cámara.

---

## Comandos de voz

Activa el micrófono con el botón de la pantalla kiosk y di:

- Nombre del producto: "burger", "cola", "fries"...
- Categoría: "burgers", "drinks", "sides", "desserts"
- Navegación: "siguiente" / "next"
- Confirmar: "confirmar" / "pagar" / "confirm"
- Cancelar: "cancelar" / "atrás" / "cancel"

---

## Arquitectura

```
[Webcam / Micrófono]
        |
[MediaPipe Hands / Web Speech API]
        |
[Socket.IO Client — Kiosk]
        |  WebSocket
[Node.js + Express + Socket.IO — Server :3000]
        |  WebSocket broadcast
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
│   │   └── index.html    # Pantalla secundaria (TV / mostrador)
│   ├── css/
│   │   └── shared.css    # Estilos compartidos
│   └── js/
│       └── kiosk.js      # Lógica de gestos + voz + Socket.IO cliente
├── package.json
└── README.md
```
