# AGENTS.md — waves-alerts-bot

Guía operativa rápida para trabajar en este repo.

## Regla obligatoria antes de tocar código
- **Leer este archivo siempre antes de realizar cualquier cambio**.

## Objetivo del proyecto
- Bot de Telegram para alertas de surf.
- Fuente principal de forecast: backend `waves-db-backend`.
- Enfoque actual: evitar spam con deduplicación por ventana y mantener mensajes de alerta claros.

## Convenciones de desarrollo
- Cambios pequeños y verificables.
- Mantener compatibilidad con flujos existentes del bot.
- Priorizar claridad sobre complejidad.
- Si se toca lógica de alertas/scheduler, añadir o actualizar tests.

## Commits (obligatorio)
- **Cada cambio realizado debe tener su propio commit**.
- **Todos los mensajes de commit deben estar en inglés**.
- **Los commits deben ser de tipo conventional commit**.
- Evitar commits “mezcla” con cambios no relacionados.

## Checklist mínimo antes de cerrar un cambio
1. `npm test`
2. `npm run build`
3. Confirmar que el cambio está aislado y con commit propio.

## Áreas sensibles
- `src/check-runner.ts`: matching, dedupe y decisión de envío.
- `src/scheduler.ts`: timing de ejecución (HH:10 Europe/Madrid).
- `src/index.ts`: integración bot/flujo de creación.
- `src/storage.ts`: persistencia de alertas.

## Notas de producto vigentes
- Scheduler: cada hora al minuto `:10` (Europe/Madrid).
- Sin cooldown temporal (se deduplica por ventana).
- Para `tidePreference = high`, aplicar ventana `pleamar ±3h`.
- Limpiar mensajes intermedios del wizard de creación de alerta.
