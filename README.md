# Venezuela Exchange Rates API (Cloudflare Workers + Hono + D1)

API serverless de alto rendimiento para recopilar, almacenar en Cloudflare D1 y servir las tasas de cambio de Venezuela (**BCV USD**, **BCV EUR** y **Yadio USDT**).

## Arquitectura

- **Runtime:** Cloudflare Workers + Hono + Zod (`@hono/zod-validator`)
- **Base de datos:** Cloudflare D1 (SQLite serverless) con migraciones en `migrations/0001_initial_schema.sql`
- **Cron Triggers:**
  - `0 10 * * 1-5` (6:00 AM `America/Caracas`, lunes a viernes): Scraping BCV con `HTMLRewriter` nativo.
  - `0 */4 * * *` (cada 4 horas): Consulta a `https://api.yadio.io/rate/ves/usd`.
- **Seguridad:**
  - API Key timing-safe (`SHA-256` + `crypto.subtle.timingSafeEqual`) vía `X-API-Key` o `Authorization: Bearer`. Soporta rotación de claves separadas por coma en `API_SECRET_KEYS`.
  - CORS estricto por allowlist (`ALLOWED_ORIGINS`).
  - Rate limiting nativo en memoria por IP y cabeceras de seguridad HTTP.

## Configuración Inicial

1. Instalar dependencias:
   ```bash
   pnpm install
   ```

2. Crear la base de datos D1 en Cloudflare y actualizar `database_id` en `wrangler.jsonc`:
   ```bash
   npx wrangler d1 create rates-db
   npx wrangler d1 migrations apply rates-db --local
   npx wrangler d1 migrations apply rates-db --remote
   ```

3. Configurar secretos locales (`.dev.vars` basado en `.dev.vars.example`) y en producción:
   ```bash
   cp .dev.vars.example .dev.vars
   npx wrangler secret put API_SECRET_KEYS
   npx wrangler secret put ALLOWED_ORIGINS
   ```

## Comandos

- Desarrollo local: `pnpm run dev`
- Verificación de tipos: `pnpm run typecheck` (`npx tsc --noEmit`)
- Tests automatizados: `pnpm test` (`npx vitest run`)
- Despliegue: `pnpm run deploy`

## Endpoints

| Método | Ruta | Auth | Descripción |
| :--- | :--- | :--- | :--- |
| `GET` | `/health` | Público | Verifica conectividad con D1 (`SELECT 1`). |
| `GET` | `/api/rates` | API Key | Listado paginado (`page`, `limit`, `days`, `currency`). |
| `GET` | `/api/rates/today` | API Key | Tasas del día (`America/Caracas`, UTC-4) con fallback histórico (`isFallback: true`). |
| `GET` | `/api/rates/:currency` | API Key | Última tasa de `BCV_USD`, `BCV_EUR` o `YD_USD`. |
| `GET` | `/api/rates/:currency/all` | API Key | Histórico paginado filtrado por moneda. |
| `POST` | `/api/sync` | API Key | Sincronización manual (`source=all\|bcv\|yadio`). |
