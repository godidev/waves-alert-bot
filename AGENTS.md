# AGENTS.md — waves-alerts-bot

Guía operativa rápida para trabajar en este repo.

## Regla obligatoria antes de tocar código
- **Leer este archivo siempre antes de realizar cualquier cambio**.

## Objetivo del proyecto
- Bot de Telegram para alertas de surf.
- Fuente principal de forecast: backend `waves-db-backend` (por defecto `https://waves-db-backend.vercel.app`).
- Enfoque actual: evitar spam con deduplicación por ventana y mantener mensajes de alerta claros.

## Stack técnico
- **Runtime**: Node.js con ESM (`"type": "module"` en package.json).
- **Lenguaje**: TypeScript 5.x, modo estricto.
- **Bot framework**: grammy.
- **Proceso**: PM2 en producción (`ecosystem.config.cjs`), `tsx watch` en desarrollo.
- **Linting**: ESLint 9 (flat config con `defineConfig`) + typescript-eslint + eslint-config-prettier.
- **Formatting**: Prettier (`singleQuote: true`, `semi: false`).
- **Tests**: `node --import tsx --test` (test runner nativo de Node).

## Estructura del proyecto
```
src/
  index.ts              — entrada principal, setup del bot, handlers, scheduler
  core/
    types.ts            — tipos core (AlertRule, SurfForecast, WindRange)
    utils.ts            — funciones puras (totalWaveHeight, degreesToCardinal, normalizeAngle, nextId)
    time.ts             — utilidades de fecha/hora Europe/Madrid
    scheduler.ts        — scheduler horario (:10 Europe/Madrid)
    alert-engine.ts     — matching de alertas, ventanas consecutivas, mareas, mensaje de alerta
    check-runner.ts     — orquestación: matching + dedupe + envío
  bot/
    bot-options.ts      — constantes y tipos del wizard (opciones, DraftAlert)
    bot-ui.ts           — constructores de InlineKeyboard
    bot-helpers.ts      — helpers de negocio (API, caches, conversión draft→alert)
    flow-cleanup.ts     — limpieza de mensajes del wizard
  infra/
    storage.ts          — persistencia JSON con migración
    check-logger.ts     — log de cada check run (últimas 48h, persistido en JSON)
tests/
  *.test.ts         — tests unitarios (imports desde ../src/)
data/
  alerts.json       — almacén de alertas (no commitear datos reales)
  check-log.json    — log rotativo de checks (auto-generado, max 48 entradas)
```

## Convenciones de desarrollo
- Cambios pequeños y verificables.
- Mantener compatibilidad con flujos existentes del bot.
- Priorizar claridad sobre complejidad.
- Si se toca lógica de alertas/scheduler, añadir o actualizar tests.
- Evitar `any`; usar tipos concretos o genéricos.
- Funciones puras reutilizables van en `utils.ts`.
- Constantes compartidas (opciones del wizard, sectores de viento) van en `bot-options.ts`.

## Commits (obligatorio)
- **Cada cambio realizado debe tener su propio commit**.
- **Todos los mensajes de commit deben estar en inglés**.
- **Los commits deben ser de tipo conventional commit**.
- Evitar commits "mezcla" con cambios no relacionados.

## Scripts disponibles
| Script              | Uso                                              |
|---------------------|--------------------------------------------------|
| `npm run dev`       | Desarrollo con hot-reload (`tsx watch`)           |
| `npm start`         | Producción (requiere `npm run build` previo)      |
| `npm run build`     | Compilar TypeScript a `dist/`                     |
| `npm test`          | Ejecutar tests unitarios                          |
| `npm run lint`      | Verificar ESLint                                  |
| `npm run lint:fix`  | Corregir ESLint automáticamente                   |
| `npm run format`    | Formatear con Prettier                            |
| `npm run check`     | `test` + `build`                                  |
| `npm run check:ci`  | `lint` + `format:check` + `test` + `build`        |

## Checklist mínimo antes de cerrar un cambio
1. `npm run lint`
2. `npm test`
3. `npm run build`
4. Confirmar que el cambio está aislado y con commit propio.

## Áreas sensibles
- `src/core/check-runner.ts`: matching, dedupe y decisión de envío.
- `src/core/scheduler.ts`: timing de ejecución (HH:10 Europe/Madrid).
- `src/index.ts`: integración bot/flujo de creación.
- `src/infra/storage.ts`: persistencia de alertas (migración de formato legacy).
- `src/core/alert-engine.ts`: lógica de matching y construcción de mensajes.

## Variables de entorno
| Variable                | Requerida | Descripción                                |
|-------------------------|-----------|--------------------------------------------|
| `TELEGRAM_BOT_TOKEN`   | Sí        | Token del bot de Telegram                  |
| `BACKEND_API_URL`      | No        | URL del backend (default: waves-db-backend en Vercel) |
| `MIN_CONSECUTIVE_HOURS`| No        | Horas consecutivas mínimas para alerta (default: 2)   |
| `DEV_CHAT_ID`          | No        | Chat ID del desarrollador para comandos de diagnóstico y notificaciones de error |

## Notas de producto vigentes
- Scheduler: cada hora al minuto `:10` (Europe/Madrid).
- Sin cooldown temporal (se deduplica por ventana).
- Para `tidePreference = high`, aplicar ventana `pleamar ±3h`.
- Limpiar mensajes intermedios del wizard de creación de alerta.
- Spot por defecto: `sopelana`.
- `MIN_CONSECUTIVE_HOURS` configurable por env (default: 2).

## Comandos dev (ocultos, requieren DEV_CHAT_ID)
- `/status` — uptime, alertas totales, spots activos, entradas en dedupe map, último check.
- `/checklog` — últimas 10 entradas del check-runner log.
- `/runnow` — forzar ejecución inmediata del check-runner.
- `/alerts_all` — listar todas las alertas de todos los usuarios (vista admin).
- Notificación automática al DEV_CHAT_ID cuando hay errores en `bot.catch` o en check runs.
