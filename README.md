# Venezuela Exchange Rates API

API serverless para recopilar, almacenar y servir las tasas de cambio de Venezuela (**BCV USD**, **BCV EUR** y **Yadio USDT**).

---

## Endpoints

> **Autenticación:** Todos los endpoints bajo `/api/*` requieren una API Key en la cabecera `X-API-Key: <token>` o `Authorization: Bearer <token>`.

### 1. `GET /api/rates`
Listado paginado de tasas registradas. Admite queries opcionales: `page` (default 1), `limit` (default 10), `currency` (`BCV_USD | BCV_EUR | YD_USD`) y `days` (1-365).

**Respuesta:**
```json
{
  "rates": [
    {
      "id": 5,
      "rate": 1074.35,
      "currency": "YD_USD",
      "name": "USDT",
      "source": "YADIO",
      "created_at": "2026-11-15T04:00:07.742Z"
    },
    {
      "id": 4,
      "rate": 1072.51,
      "currency": "YD_USD",
      "name": "USDT",
      "source": "YADIO",
      "created_at": "2026-11-15T00:00:07.685Z"
    }
  ],
  "pagination": {
    "currentPage": 1,
    "totalPages": 1,
    "totalItems": 5,
    "itemsPerPage": 10
  }
}
```

---

### 2. `GET /api/rates/today`
Tasas más recientes del día actual en hora de Venezuela (`America/Caracas`, UTC-4). Si no hay tasa de hoy para BCV (fines de semana o feriados), hace fallback a la última tasa disponible marcando `isFallback: true`.

**Respuesta:**
```json
{
  "rates": [
    {
      "id": 1,
      "rate": 914.02,
      "currency": "BCV_USD",
      "name": "Dólar",
      "source": "BCV",
      "created_at": "2026-11-14T22:29:29.843Z",
      "isFallback": true
    }
  ]
}
```

---

### 3. `GET /api/rates/:currency`
Último valor registrado para la moneda especificada (`BCV_USD`, `BCV_EUR` o `YD_USD`).

**Respuesta:**
```json
{
  "rate": {
    "id": 1,
    "rate": 914.02,
    "currency": "BCV_USD",
    "name": "Dólar",
    "source": "BCV",
    "created_at": "2026-11-14T22:29:29.843Z"
  }
}
```

---

### 4. `GET /api/rates/:currency/all`
Histórico paginado filtrado por moneda (`BCV_USD`, `BCV_EUR` o `YD_USD`). Admite `page`, `limit` y `days`.

**Respuesta:**
```json
{
  "rates": [
    {
      "id": 1,
      "rate": 914.02,
      "currency": "BCV_USD",
      "name": "Dólar",
      "source": "BCV",
      "created_at": "2026-11-14T22:29:29.843Z"
    }
  ],
  "pagination": {
    "currentPage": 1,
    "totalPages": 1,
    "totalItems": 1,
    "itemsPerPage": 10
  }
}
```

---

### 5. `POST /api/sync`
Sincronización manual inmediata. Admite query opcional `source`: `all` (default), `bcv` o `yadio`.

**Respuesta (`source=all`):**
```json
{
  "source": "all",
  "syncedCount": 3,
  "rates": [
    {
      "rate": 914.02,
      "currency": "BCV_USD",
      "name": "Dólar",
      "source": "BCV"
    },
    {
      "rate": 1010.56,
      "currency": "BCV_EUR",
      "name": "Euro",
      "source": "BCV"
    },
    {
      "rate": 1071.62,
      "currency": "YD_USD",
      "name": "USDT",
      "source": "YADIO"
    }
  ],
  "durationMs": 536
}
```

<!--
## Información Técnica para Desarrollo

### Arquitectura
- Runtime: Cloudflare Workers + Hono + Zod (@hono/zod-validator)
- Base de datos: Cloudflare D1 (SQLite serverless) con migraciones en migrations/0001_initial_schema.sql
- Cron Triggers:
  - 0 10 * * 1-5 (6:00 AM America/Caracas, lunes a viernes): Scraping BCV con HTMLRewriter nativo.
  - 0 */4 * * * (cada 4 horas): Consulta a https://api.yadio.io/rate/ves/usd.
- Seguridad:
  - API Key timing-safe (SHA-256 + crypto.subtle.timingSafeEqual) vía X-API-Key o Authorization: Bearer. Soporta rotación de claves separadas por coma en API_SECRET_KEYS.
  - CORS estricto por allowlist (ALLOWED_ORIGINS).
  - Rate limiting nativo en memoria por IP y cabeceras de seguridad HTTP.

### Configuración Inicial
1. Instalar dependencias:
   pnpm install

2. Crear la base de datos D1 en Cloudflare y actualizar database_id en wrangler.jsonc:
   npx wrangler d1 create rates-db
   npx wrangler d1 migrations apply rates-db --local
   npx wrangler d1 migrations apply rates-db --remote

3. Configurar secretos locales (.dev.vars basado en .dev.vars.example) y en producción:
   cp .dev.vars.example .dev.vars
   npx wrangler secret put API_SECRET_KEYS
   npx wrangler secret put ALLOWED_ORIGINS

### Comandos
- Desarrollo local: pnpm run dev
- Verificación de tipos: pnpm run typecheck (npx tsc --noEmit)
- Tests automatizados: pnpm test (npx vitest run)
- Despliegue: pnpm run deploy

### Otros Endpoints
- GET /health (Público): Verifica conectividad con D1 (SELECT 1).
-->
