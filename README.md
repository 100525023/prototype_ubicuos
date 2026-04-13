# Touchless Kiosk — SIU P2

**Sistemas Interactivos y Ubicuos · Grupo 9**  
Adam Kowalczyk Holtsova · Mohamed Rida Chahdaoui Moujib · David Benito Gil

Quiosco de comida rápida sin contacto táctil. Gestos por webcam (MediaPipe Hands), voz (Web Speech API) y sincronización en tiempo real entre dispositivos (Socket.IO).

## Requisitos

- Node.js v18 o superior
- Chrome o Edge (Firefox no soporta Web Speech API)
- Webcam

## Arranque

```bash
npm install
npm start
```

Servidor en `http://localhost:3000`

## Pantallas

| Pantalla | URL |
|---|---|
| Kiosk (interacción) | `http://localhost:3000/kiosk` |
| Display (mostrador) | `http://localhost:3000/display` |

Para el display en otro dispositivo, sustituye `localhost` por la IP del servidor.

## Gestos

| Gesto | Acción |
|---|---|
| Acercarse a la cámara | Inicia la sesión |
| Señalar con el índice y mantener | Selecciona el producto apuntado |
| ✌️ V con mano derecha y mantener | Siguiente categoría |
| ✌️ V con mano izquierda y mantener | Categoría anterior |
| 👍 Pulgar arriba y mantener | Confirma / paga |
| ✋ Palma abierta y mantener | Cancela el último paso |
| ✊ Puño cerrado 2.5 s | Borra todo el pedido |

Todos los gestos muestran una barra de progreso en la parte inferior de la pantalla.

## Voz

Activa el micrófono con el botón de la pantalla kiosk. Comandos disponibles:

- Productos: "hamburguesa", "cola", "patatas", "helado"...
- Categorías: "bebidas", "postres", "acompañamientos"
- Navegación: "siguiente", "anterior"
- Acción: "confirmar", "pagar", "cancelar"

## Funcionalidades adicionales

- **Voz**: control completo del pedido por reconocimiento de voz en español
- **Display en tiempo real**: pantalla secundaria con estado del pedido e historial de los últimos 5 pedidos confirmados
- **Reset por gesto**: puño cerrado mantenido 2.5 s borra el pedido completo

## Arquitectura

```
[Webcam / Micrófono]
        |
[MediaPipe / Web Speech API]
        |
[Socket.IO Client — Kiosk]
        |
[Node.js + Express + Socket.IO — :3000]
        |
[Socket.IO Client — Display]
```

## Estructura

```
touchless-kiosk/
├── server/index.js
├── public/
│   ├── kiosk/index.html
│   ├── display/index.html
│   ├── css/shared.css
│   └── js/kiosk.js
└── package.json
```
