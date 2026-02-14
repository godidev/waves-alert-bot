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
1. Altura mínima / máxima
2. Energía mínima / máxima
3. Periodo mínimo / máximo
4. Viento (8 opciones: N/NE/E/SE/S/SW/W/NW con grados y flecha)

## Notas
- Spot fijo por ahora: `sopela`.
- El bot revisa condiciones cada `CHECK_INTERVAL_MIN` (default 30).
- Guarda alertas en `data/alerts.json`.
- Viento se guarda como rango numérico de ángulo (0-360), incluyendo rangos circulares.
