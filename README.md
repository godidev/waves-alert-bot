# waves-alerts-bot

Bot de Telegram para alertas de mar usando tu API de waves.

## Setup
```bash
npm install
cp .env.example .env
# rellena TELEGRAM_BOT_TOKEN
npm run dev
```

## Scripts
```bash
npm run dev
npm test
npm run build
npm run check
npm start
```

## Comandos
- `/start`
- `/setalert` (modo guiado paso a paso)
- `/listalerts`
- `/deletealert <id>`
- `/cancel`

## Flujo guiado `/setalert`
1. Nombre de alerta
2. Altura (selección múltiple por valores)
3. Energía (preset: baja/media/alta/muy alta)
4. Periodo (selección múltiple por rangos desde 8s)
5. Viento (8 opciones: N/NE/E/SE/S/SW/W/NW, selección múltiple o ANY)
6. Puerto de marea (Bermeo/Bilbao)
7. Preferencia de marea (ANY/Baja/Media/Alta)
8. Confirmación

Al terminar, el bot limpia los mensajes intermedios del wizard y deja solo la confirmación final.

## Scheduler
- Ejecución fija cada hora en el minuto `:10`.
- Timezone: `Europe/Madrid`.
- Si el bot arranca en otro minuto, calcula automáticamente el siguiente `HH:10`.

## Lógica de alertas
- Spot fijo por ahora: `sopelana`.
- Ventana de luz: desde las 05:00 hasta 1h después de la puesta de sol (hora local).
- Solo alerta cuando hay una racha mínima de horas consecutivas cumpliendo condiciones (`MIN_CONSECUTIVE_HOURS`, default `2`).
- **Sin cooldown temporal**: el control anti-spam se hace por deduplicación de ventana.

### Deduplicación por ventana (en memoria)
Por combinación `chat_id + spot + perfil` se guarda última ventana enviada:
- No envía si la ventana nueva es igual.
- No envía si está contenida dentro de la anterior.
- Sí envía si amplía por delante/detrás o si está desplazada.

> Caché en memoria (no persistente).

### Marea alta (`tidePreference = high`)
- Busca la pleamar más próxima.
- Aplica ventana teórica `pleamar ±3h`.
- Solo evalúa registros dentro de esa ventana.
- Intersecta con condiciones de olas/viento/energía.
- Si no queda intersección, no se envía alerta.

## Mensaje de alerta
Formato actual:
- Fecha
- Rango horario
- Cuánto falta para empezar
- Swell, energía y viento
- Bajamar más cercana + altura
- Pleamar más cercana + altura

## PM2 (producción)
```bash
# arrancar con ecosystem
pm2 start ecosystem.config.cjs

# ver estado/logs
pm2 status waves-alerts-bot
pm2 logs waves-alerts-bot

# aplicar cambios de config
pm2 restart ecosystem.config.cjs --only waves-alerts-bot

# persistir procesos
pm2 save
```

## Almacenamiento
- Alertas en `data/alerts.json`.
- El bot convierte selecciones múltiples en rangos internos para evaluar alertas.
