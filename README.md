# TouchKiosk — SIU P2

**Sistemas Interactivos y Ubicuos · Grupo 9**  
Adam Kowalczyk Holtsova · Mohamed Rida Chahdaoui Moujib · David Benito Gil

Quiosco de comida rápida sin contacto táctil. El usuario interactúa mediante gestos capturados por webcam (MediaPipe Hands) y comandos de voz (Web Speech API). El estado del pedido se sincroniza en tiempo real entre el kiosk y la pantalla de mostrador mediante Socket.IO.

## Requisitos

- Node.js v18 o superior
- Chrome o Edge (Firefox no soporta Web Speech API)
- Webcam

## Arranque

```bash
npm install
npm start
```

El servidor arranca en `http://localhost:3000`.

## Pantallas

| Pantalla | URL |
|---|---|
| Kiosk (interacción del cliente) | `http://localhost:3000/kiosk` |
| Display (pantalla de mostrador) | `http://localhost:3000/display` |

Para mostrar el display en otro dispositivo de la misma red, reemplaza `localhost` por la IP local del servidor.

## Gestos disponibles

| Gesto | Acción |
|---|---|
| Mostrar la palma a la cámara | Inicia la sesión |
| Señalar con el índice y mantener | Selecciona el producto apuntado |
| Señalar la flecha ◀ o ▶ y mantener | Cambia de categoría |
| ✌️ V con mano derecha y mantener | Siguiente categoría |
| ✌️ V con mano izquierda y mantener | Categoría anterior |
| 👍 Pulgar arriba y mantener | Confirma / paga |
| ✋ Palma abierta y mantener | Cancela el último paso |
| ✊ Puño cerrado 2.5 s | Borra todo el pedido |

Todos los gestos muestran una barra de progreso en la parte inferior de la pantalla mientras se mantienen.

## Control por voz

Activa el micrófono con el botón de la pantalla kiosk. Comandos reconocidos:

- **Productos:** "hamburguesa" (añade Big Burger por defecto), "cheese burger", "veggie", "doble", "cola", "patatas", "helado"…
- **Categorías:** "bebidas", "postres", "acompañamientos"
- **Navegación:** "siguiente", "anterior"
- **Acciones:** "confirmar", "pagar", "cancelar"

## Funcionalidades destacadas

- **Control por voz** — pedido completo mediante reconocimiento de voz en español
- **Display en tiempo real** — pantalla secundaria con el estado del pedido e historial de los últimos 5 pedidos confirmados
- **Reset por gesto** — puño cerrado mantenido 2.5 s borra el pedido completo sin necesidad de tocar nada

## Arquitectura

```
[Webcam / Micrófono]
        │
[MediaPipe Hands / Web Speech API]
        │
[Socket.IO Client — Kiosk]
        │
[Node.js + Express + Socket.IO — :3000]
        │
[Socket.IO Client — Display]
```

## Estructura del proyecto

```
touchless-kiosk/
├── server/
│   └── index.js
├── public/
│   ├── kiosk/
│   │   └── index.html
│   ├── display/
│   │   └── index.html
│   ├── css/
│   │   └── shared.css
│   └── js/
│       └── kiosk.js
└── package.json
```
