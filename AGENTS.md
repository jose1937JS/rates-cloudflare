# AGENTS.md — `rates-api` (Venezuela Exchange Rates Worker)

Contexto técnico estructurado para agentes de IA. Describe arquitectura, contratos, flujo de datos, invariantes, límites conocidos y guía de depuración/mejora del proyecto.

---

## 1. Meta & Stack

```yaml
name: "rates-api"
runtime: "Cloudflare Workers (compatibility_date: 2024-04-01, flags: nodejs_compat)"
framework: "Hono ^4.13.16 + @hono/zod-validator ^0.9.1 + Zod ^4.6.7"
language: "TypeScript ^7.0.2 (strict: true, noEmit: true, @cloudflare/workers-types)"
database: "Cloudflare D1 (SQLite serverless, binding: DB, db_name: rates-db)"
package_manager: "pnpm (pnpm-lock.yaml + pnpm-workspace.yaml)"
testing: "Vitest ^4.1.12 (Node runtime con D1 in-memory mock y fetch stub)"
observability: "Workers logs enabled (head_sampling_rate: 1, invocation_logs: true)"
```

---

## 2. Invariantes & Reglas Críticas (Gates)

1. **Package Manager (`pnpm` obligatorio):**
   - Usar siempre `pnpm` (`pnpm add`, `pnpm install`). Nunca ejecutar `npm install` (arborist falla sobre `node_modules/.pnpm`).
   - No eliminar `packages: ['.']` de `pnpm-workspace.yaml` (pnpm 10+ en Cloudflare Workers Builds falla con `packages field missing or empty`).
2. **Orden de Rutas en `src/routes/rates.ts`:**
   - `GET /today` DEBE permanecer registrado antes de `GET /:currency`; de lo contrario `/today` entra en `/:currency` y falla validación Zod con `400`.
3. **Consultas D1:**
   - Usar exclusivamente prepared statements (`.prepare(...).bind(...)`) y `db.batch([...])` para inserciones múltiples (`ratesRepository.insertBatch`).
4. **Zona Horaria:**
   - Almacenamiento en D1: siempre ISO-8601 UTC (`strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`).
   - Lógica de negocio diaria (`/api/rates/today`): `America/Caracas` (`UTC-4`) vía `getCaracasStartOfDayUtcIso()`.
5. **Verificación obligatoria tras cambios:**
   - Ejecutar `pnpm run typecheck && pnpm test` (`tsc --noEmit` + `vitest run`) antes de dar por terminado cualquier cambio.

---

## 3. Mapa de Archivos y Símbolos

```text
.
├── migrations/
│   ├── 0001_initial_schema.sql      # Tablas rates, sync_logs e índices DESC
│   └── 0002_add_buy_sell_rates.sql  # Columnas opcionales buy_rate y sell_rate en rates
├── src/
│   ├── index.ts                     # Hono `app`, cadena de middlewares, export `{ fetch, scheduled }`
│   ├── types/env.ts                 # `Env`, `Currency`, `RateSource`, `SyncSource`, DTOs
│   ├── schemas/rates.schema.ts      # `currencyEnum`, `currencyParamSchema`, `ratesQuerySchema`,
│   │                                # `currencyHistoryQuerySchema`, `syncQuerySchema`
│   ├── db/rates.repository.ts       # `getCaracasStartOfDayUtcIso`, `ratesRepository`
│   │                                # (ping, insertBatch, logSync, findPaginated, findLatestByCurrency, findTodayWithFallback)
│   ├── middleware/
│   │   ├── security-headers.ts      # `securityHeadersMiddleware` (nosniff, DENY, CSP none, HSTS)
│   │   ├── cors.ts                  # `corsMiddleware` (allowlist en `ALLOWED_ORIGINS`)
│   │   ├── rate-limit.ts            # `rateLimitMiddleware`, `resetRateLimitStore` (Map por IP en memoria)
│   │   └── auth.ts                  # `authMiddleware` (SHA-256 + timingSafeEqual sobre `API_SECRET_KEYS`)
│   ├── routes/
│   │   ├── health.ts                # `healthRoutes` -> GET /health (SELECT 1 en D1)
│   │   ├── rates.ts                 # `ratesRoutes`  -> GET /, /today, /:currency, /:currency/all
│   │   ├── sync.ts                  # `syncRoutes`   -> POST / (?source o JSON body: all|bcv|yadio)
│   └── services/
│       ├── bcv.service.ts           # `fetchBcvRates`, `BcvScrapeError` (HTMLRewriter + fallback regex/depth)
│       ├── yadio.service.ts         # `fetchYadioRate`, `YadioServiceError` (JSON + 1 retry)
│       └── sync.service.ts          # `syncService.sync`, `SyncResult` (orquestador + sync_logs)
├── tests/
│   ├── auth-cors.test.ts            # Auth 401/200, key rotation, CORS 204/403, headers, rate limit 429
│   ├── rates-api.test.ts            # Endpoints HTTP + mock `InMemoryD1Database` + timezone Caracas
│   ├── scrapers.test.ts             # BCV HTMLRewriter/fallback/miles + Yadio retry/sanity
│   └── scheduled.test.ts            # Enrutamiento de `event.cron` -> bcv | yadio | all
├── wrangler.jsonc                   # Binding DB, crons, observability, vars por defecto
├── tsconfig.json                    # Strict TS + @cloudflare/workers-types
├── pnpm-workspace.yaml              # `packages: ['.']` + allowBuilds (`esbuild`, `workerd`)
└── .dev.vars.example                # Plantilla de secretos locales
```

---

## 4. Flujo de Ejecución y Arquitectura

### 4.1. Pipeline HTTP (`src/index.ts`)

```text
Request
  │
  ├─► 1. securityHeadersMiddleware   (post-next: X-Content-Type-Options, X-Frame-Options, Referrer-Policy, CSP, HSTS)
  ├─► 2. corsMiddleware              (si hay `Origin`: valida `ALLOWED_ORIGINS` -> 403 si no está; 204 en OPTIONS;
  │                                   si NO hay `Origin`, pasa directo para backends/apps nativas)
  ├─► 3. rateLimitMiddleware         (por `CF-Connecting-IP` / `X-Forwarded-For`; inyecta X-RateLimit-*; 429 si > max)
  ├─► 4. authMiddleware [solo /api/*] (`X-API-Key` o `Authorization: Bearer` vs `API_SECRET_KEYS` separado por comas;
  │                                   SHA-256 + `crypto.subtle.timingSafeEqual`; 401 si falta/no coincide)
  └─► 5. Router Hono
        ├── GET  /health                (público; `SELECT 1 AS ok` -> 200 o 503)
        ├── GET  /api/rates             (query Zod: `page=1`, `limit=10..100`, `days=1..365`, `currency?`)
        ├── GET  /api/rates/today       (hoy Caracas UTC-4; fallback a último histórico con `isFallback: true`)
        ├── GET  /api/rates/:currency   (último registro o 404)
        ├── GET  /api/rates/:currency/all (histórico paginado por moneda)
        └── POST /api/sync              (query o JSON body Zod: `source=all|bcv|yadio`; 200 o 502 si falla upstream)
```

### 4.2. Flujo Cron Triggers (`scheduled` en `src/index.ts`)

| Expresión Cron | Horario VET (`UTC-4`) | Acción | Fuente |
| :--- | :--- | :--- | :--- |
| `0 10 * * 1-5` | 6:00 AM Lun–Vie | `syncService.sync(env, 'bcv')` | `https://www.bcv.org.ve/terminos-condiciones` |
| `0 */4 * * *` | Cada 4 horas todos los días | `syncService.sync(env, 'yadio')` | `https://api.yadio.io/rate/ves/usd` + `/market/ads` (Binance P2P) |
| Cualquier otro | Manual / prueba | `syncService.sync(env, 'all')` | Ambos |

### 4.3. Esquema Cloudflare D1 (`migrations/`)

- **`rates`** (`0001_initial_schema.sql` + `0002_add_buy_sell_rates.sql`):
  - `id` (`INTEGER PK AUTOINCREMENT`), `rate` (`REAL > 0`), `buy_rate` (`REAL NULL > 0`), `sell_rate` (`REAL NULL > 0`), `currency` (`'BCV_USD' | 'BCV_EUR' | 'YD_USD'`), `name` (`TEXT`), `source` (`'BCV' | 'YADIO'`), `created_at` (`TEXT`, UTC ISO-8601).
  - `buy_rate` y `sell_rate` son `NULL` para `BCV_USD`/`BCV_EUR` (o en `YD_USD` si falla el endpoint P2P) y almacenan la mediana Binance P2P VES para `YD_USD`.
  - Índice: `idx_rates_currency_created_at (currency, created_at DESC)`.
- **`sync_logs`**:
  - `id` (`INTEGER PK AUTOINCREMENT`), `source` (`'BCV' | 'YADIO' | 'ALL'`), `status` (`'SUCCESS' | 'ERROR'`), `message` (`TEXT`), `duration_ms` (`INTEGER`), `created_at` (`TEXT`, UTC ISO-8601).
  - Índice: `idx_sync_logs_created_at (created_at DESC)`.

### 4.4. Servicios de Ingesta

- **BCV (`src/services/bcv.service.ts`):**
  - Timeout `10_000ms` (`AbortSignal.timeout`) en primario (`https://www.bcv.org.ve/terminos-condiciones`) con respaldo automático JSON a `https://rates.dolarvzla.com/bcv/current.json` ante errores del origen (como `HTTP 526` por cadena SSL incompleta de `bcv.org.ve` en Cloudflare Workers).
  - Primario extrae `#dolar strong` / `#dolar` y `#euro strong` / `#euro` usando `HTMLRewriter` en `workerd` o `extractTagContentByIdFallback` en Node.
  - Normalización (`parseSanitizedRate` / `normalizeValidatedRate`): elimina espacios; si contiene `,`, elimina `.` (miles) y convierte `,` a `.` (`1.010,56078251` -> `1010.56`); redondea a 2 decimales.
  - Sanidad: regex `/^\d+(\.\d+)?$/` y rango estricto `1 < rate < 100_000`. Lanza `BcvScrapeError` solo si fallan tanto el origen BCV como el respaldo.
- **Yadio (`src/services/yadio.service.ts`):**
  - Ejecuta en paralelo el fetch principal (`/rate/ves/usd`, timeout `8_000ms`, soporta `{ rate }` o `{ data: { rate } }`) junto a `/market/ads?asset=USDT&currency=VES&side={buy|sell}&limit=50` (timeout `6_000ms`).
  - El fetch principal realiza 1 reintento automático tras `250ms` únicamente en errores de red/timeout o HTTP `>= 500`. NO reintenta `4xx`, JSON inválido ni fallos de sanidad (`!Number.isFinite(rate) || rate <= 1`).
  - Para compra (`side=buy`) y venta (`side=sell`), filtra exclusivamente anuncios de Binance P2P (`binance_native_v1 != null` o `ad_url` contiene `binance`) y calcula la mediana redondeada a 2 decimales (`buy_rate`, `sell_rate`).
  - Degradación controlada: si falla `/market/ads` o no hay anuncios de Binance, retorna `buy_rate: null` / `sell_rate: null` sin abortar la sincronización de `rate`. Lanza `YadioServiceError` solo si falla la tasa principal.
- **Orquestador (`src/services/sync.service.ts`):**
  - Ejecuta fuentes solicitadas, persiste vía `ratesRepository.insertBatch` (`db.batch`), y registra `SUCCESS` o `ERROR` en `sync_logs` con `duration_ms`.

---

## 5. Variables de Entorno y Configuración (`Env`)

| Variable | Origen en Prod | Valor Actual / Default | Uso |
| :--- | :--- | :--- | :--- |
| `DB` | Binding D1 (`wrangler.jsonc`) | `rates-db` | Base de datos SQLite D1 |
| `API_SECRET_KEYS` | Cloudflare Secret / `.dev.vars` | *(sin default)* | Claves válidas separadas por `,` (soporta rotación sin downtime) |
| `ALLOWED_ORIGINS` | `wrangler.jsonc` `vars` | `http://localhost:3000,https://kaironshop.com` | Orígenes CORS permitidos separados por `,` |
| `RATE_LIMIT_MAX` | `wrangler.jsonc` `vars` | `"10"` (código fallback: `60`) | Máximo de peticiones por ventana por IP |
| `RATE_LIMIT_WINDOW_MS` | `wrangler.jsonc` `vars` | `"60000"` | Ventana del rate limiter en ms |

---

## 6. Fallos Conocidos, Edge Cases y Oportunidades de Mejora

Esta sección documenta limitaciones reales del código actual para facilitar debugging y mejoras futuras:

1. **Rate Limiter en memoria por isolate (`src/middleware/rate-limit.ts`):**
   - `rateLimitStore` es un `Map` local al isolate del Worker; no es global entre PoPs ni persiste entre reciclajes de isolate. Además, `RATE_LIMIT_MAX` en `wrangler.jsonc` está en `"10"` req/min (más estricto que el fallback `60` del código) y se aplica *antes* de `authMiddleware` (afectando también a `/health` y peticiones sin key).
   - *Mejora posible:* migrar a Cloudflare Rate Limiting Binding nativo o Durable Objects si se requiere límite global estricto, o ajustar `RATE_LIMIT_MAX` en `wrangler.jsonc`.
2. **Resiliencia parcial en `syncService.sync(env, 'all')` (`src/services/sync.service.ts`):**
   - `fetchBcvRates()` y `fetchYadioRate()` corren en paralelo (`Promise.all`). Las fuentes exitosas se persisten vía `insertBatch` aunque la otra falle; si hubo al menos un error, se registra `ERROR` en `sync_logs` y se lanza el error (`502`).
   - Si `env.DB` falla dentro de `catch` al llamar `ratesRepository.logSync(...)`, esa excepción ocultará el error original de scraping.
3. **Límites y formato del parser BCV (`src/services/bcv.service.ts`):**
   - Cota superior fija `parsed >= 100_000` y cota inferior `parsed <= 1`: si la tasa supera `100_000` o tras una reconversión monetaria baja de `1`, lanzará `BcvScrapeError`.
   - Si BCV devolviera un número sin coma pero con punto de miles (ej. `"1.010"`), al no cumplir `normalized.includes(',')` se interpretaría como `1.01`.
4. **Filtro `days` vs `today` en `src/db/rates.repository.ts`:**
   - `findTodayWithFallback` alinea exactamente al inicio del día en `America/Caracas` (`UTC-4`). En cambio, `findPaginated` con `?days=N` calcula una ventana móvil `Date.now() - days * 86_400_000` en UTC, no medianoche de Caracas.
5. **Validación Zod y errores HTTP:**
   - En `src/routes/rates.ts` y `src/routes/sync.ts`, `@hono/zod-validator` usa su respuesta por defecto (`400`) y no hay `app.onError` global en `src/index.ts` (excepciones no capturadas fuera de `/api/sync` devuelven error genérico 500 de Hono).
6. **Observabilidad de `sync_logs`:**
   - `sync_logs` se escribe en D1 pero no existe endpoint HTTP para consultarlo (solo vía `wrangler d1 execute` o consola D1 de Cloudflare).
7. **Tests en Node vs `workerd`:**
   - `@cloudflare/vitest-pool-workers` está en `devDependencies`, pero no existe `vitest.config.ts` configurado con el pool de Workers. `pnpm test` corre en Node usando `InMemoryD1Database` (`tests/rates-api.test.ts`), mocks de `fetch` y mock de `HTMLRewriter`. El SQL real de D1 y el runtime `workerd` deben validarse con `wrangler dev` / D1 local.

---

## 7. Guía Rápida de Diagnóstico y Comandos

| Síntoma | Causa más probable | Dónde revisar |
| :--- | :--- | :--- |
| `401 Unauthorized` | Falta `X-API-Key`/`Bearer`, `API_SECRET_KEYS` vacío en Cloudflare Secrets/Local | `src/middleware/auth.ts`, `.dev.vars` |
| `403 Forbidden: Origin not allowed` | Cabecera `Origin` presente y no listada en `ALLOWED_ORIGINS` | `src/middleware/cors.ts`, `wrangler.jsonc` |
| `429 Too Many Requests` | IP excedió `RATE_LIMIT_MAX` (`10`/min en `wrangler.jsonc`) | `src/middleware/rate-limit.ts`, `wrangler.jsonc` |
| `502` en `POST /api/sync` (`BcvScrapeError`) | BCV cambió selectores `#dolar`/`#euro`, timeout 10s, o formato fuera de `1..100000` | `src/services/bcv.service.ts` |
| `502` en `POST /api/sync` (`YadioServiceError`) | API de Yadio caída tras 1 retry, o `rate <= 1` | `src/services/yadio.service.ts` |
| Fallo `pnpm install --frozen-lockfile` en CI | Falta `packages: ['.']` en `pnpm-workspace.yaml` o lockfile desactualizado | `pnpm-workspace.yaml`, `pnpm-lock.yaml` |

```bash
pnpm run typecheck                         # tsc --noEmit
pnpm test                                  # vitest run (suites en tests/)
pnpm run dev                               # wrangler dev local
pnpm run cf-typegen                        # regenerar tipos si cambian bindings en wrangler.jsonc
npx wrangler d1 migrations apply rates-db --local
npx wrangler d1 execute rates-db --remote --command "SELECT * FROM sync_logs ORDER BY id DESC LIMIT 10;"
```
