# waves-alerts-bot

Bot de Telegram para alertas de mar usando tu API de waves.

## Setup
```bash
npm ci
cp .env.example .env
# rellena TELEGRAM_BOT_TOKEN
npm run dev
```

## Comandos
- `/start`
- `/setalert spot=sopelana wave=0.8-1.6 period=8-14 wind=240-300 cooldown=180`
- `/listalerts`
- `/deletealert <id>`

## Notas
- El bot revisa condiciones cada `CHECK_INTERVAL_MIN` (default 30).
- Guarda alertas en `data/alerts.json`.
- `wind` es opcional y se define como rango de ángulo (`0-360`).
- Soporta rango normal (`240-300`) y rango circular (`300-40`).
