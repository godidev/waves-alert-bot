# waves-alerts-bot

Bot de Telegram para alertas de mar usando tu API de waves.

## Setup
```bash
npm install
cp .env.example .env
# rellena TELEGRAM_BOT_TOKEN
npm run dev
```

## Comandos
- `/start`
- `/setalert` (modo guiado paso a paso)
- `/listalerts`
- `/deletealert <id>`
- `/cancel`

## Flujo guiado `/setalert`
1. Altura (selección múltiple por valores)
2. Energía (preset: baja/media/alta/muy alta)
3. Periodo (selección múltiple por rangos desde 8s)
4. Viento (8 opciones: N/NE/E/SE/S/SW/W/NW, selección múltiple)

## Notas
- Spot fijo por ahora: `sopela`.
- El bot revisa condiciones cada `CHECK_INTERVAL_MIN` (default 30).
- Guarda alertas en `data/alerts.json`.
- El bot convierte selecciones múltiples en rangos internos para evaluar alertas.
