# Venezuela Exchange Rates API

API serverless para recopilar, almacenar y servir las tasas de cambio de Venezuela (**BCV USD**, **BCV EUR** y **Yadio USDT**).

---

## Endpoints

> **Autenticación:** Todos los endpoints bajo `/api/*` requieren una API Key en la cabecera `X-API-Key: <token>` o `Authorization: Bearer <token>`.

### 1. `GET /api/rates`
Listado paginado de tasas registradas. Admite queries opcionales: `page` (default 1), `limit` (default 10), `currency` (`BCV_USD | BCV_EUR | YD_USD`) y `days` (1-365). Incluye `buy_rate` y `sell_rate` (precio de compra y venta en Binance P2P vía Yadio para `YD_USD`, o `null` para BCV/fallback).

**Respuesta:**
```json
{
  "rates": [
    {
      "id": 5,
      "rate": 1074.35,
      "buy_rate": 1079.5,
      "sell_rate": 1071.2,
      "currency": "YD_USD",
      "name": "USDT",
      "source": "YADIO",
      "created_at": "2026-11-15T04:00:07.742Z"
    },
    {
      "id": 4,
      "rate": 1072.51,
      "buy_rate": 1077.8,
      "sell_rate": 1069.9,
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
      "buy_rate": null,
      "sell_rate": null,
      "currency": "BCV_USD",
      "name": "Dólar",
      "source": "BCV",
      "created_at": "2026-11-14T22:29:29.843Z",
      "isFallback": true
    },
    {
      "id": 5,
      "rate": 1074.35,
      "buy_rate": 1079.5,
      "sell_rate": 1071.2,
      "currency": "YD_USD",
      "name": "USDT",
      "source": "YADIO",
      "created_at": "2026-11-15T04:00:07.742Z",
      "isFallback": false
    }
  ],
  "usdt_p2p_tiers": {
    "currency": "YD_USD",
    "source": "YADIO_BINANCE_P2P",
    "min_usdt": 5,
    "min_ves": 5371.75,
    "base_rate": 1074.35,
    "updated_at": "2026-11-15T04:00:07.742Z",
    "tiers": [
      {
        "tier_key": "tier_5",
        "label": "Mínimo (5 USDT)",
        "bucket": "small",
        "ref_usdt": 5,
        "amount_ves": 5371.75,
        "buy_rate": 1082.4,
        "sell_rate": 1068.1,
        "avg_rate": 1075.25,
        "sample_count_buy": 12,
        "sample_count_sell": 10,
        "is_fallback": false
      }
    ]
  }
}
```

---

### 3. `GET /api/rates/usdt/tiers`
Curva de tramos vigentes de USDT Binance P2P por monto en VES almacenados en D1 (ideal para caché offline en aplicaciones móviles). Si la tabla de tramos aún está vacía tras migrar, hace fallback al último `YD_USD` registrado.

**Respuesta:**
```json
{
  "currency": "YD_USD",
  "source": "YADIO_BINANCE_P2P",
  "min_usdt": 5,
  "min_ves": 5371.75,
  "base_rate": 1074.35,
  "updated_at": "2026-11-15T04:00:07.742Z",
  "tiers": [
    {
      "tier_key": "tier_5",
      "label": "Mínimo (5 USDT)",
      "bucket": "small",
      "ref_usdt": 5,
      "amount_ves": 5371.75,
      "buy_rate": 1082.4,
      "sell_rate": 1068.1,
      "avg_rate": 1075.25,
      "sample_count_buy": 12,
      "sample_count_sell": 10,
      "is_fallback": false
    }
  ]
}
```

---

### 4. `GET /api/rates/usdt/by-amount?ves=<number>`
Resuelve server-side sobre D1 las tasas de compra, venta y promedio de USDT Binance P2P para un monto específico en bolívares (`ves > 0`). Montos menores o iguales al piso de 5 USDT usan `tier_5` (`clamped_min`); montos por encima del tramo grande usan `unfiltered` (`unfiltered_max`).

**Respuesta:**
```json
{
  "requested_ves": 35000,
  "matched_tier_key": "tier_35",
  "bucket": "small",
  "match_type": "nearest_tier",
  "buy_rate": 1079.5,
  "sell_rate": 1071.2,
  "avg_rate": 1075.35,
  "min_ves": 5371.75,
  "updated_at": "2026-11-15T04:00:07.742Z"
}
```

---

### 5. `GET /api/rates/:currency`
Último valor registrado para la moneda especificada (`BCV_USD`, `BCV_EUR` o `YD_USD`).

**Respuesta:**
```json
{
  "rate": {
    "id": 1,
    "rate": 914.02,
    "buy_rate": null,
    "sell_rate": null,
    "currency": "BCV_USD",
    "name": "Dólar",
    "source": "BCV",
    "created_at": "2026-11-14T22:29:29.843Z"
  }
}
```

---

### 6. `GET /api/rates/:currency/all`
Histórico paginado filtrado por moneda (`BCV_USD`, `BCV_EUR` o `YD_USD`). Admite `page`, `limit` y `days`.

**Respuesta:**
```json
{
  "rates": [
    {
      "id": 1,
      "rate": 914.02,
      "buy_rate": null,
      "sell_rate": null,
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

### 7. `POST /api/sync`
Sincronización manual inmediata. Admite `source` por query (`?source=all|bcv|yadio`) o JSON body (`{ "source": "all|bcv|yadio" }`), por defecto `all`.

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
      "buy_rate": 1076.4,
      "sell_rate": 1068.9,
      "currency": "YD_USD",
      "name": "USDT",
      "source": "YADIO"
    }
  ],
  "durationMs": 536,
  "p2pTiersCount": 7
}
```

<!--
## Información Técnica para Desarrollo

### Arquitectura
- Runtime: Cloudflare Workers + Hono + Zod (@hono/zod-validator)
- Base de datos: Cloudflare D1 (SQLite serverless) con migraciones en migrations/0001_initial_schema.sql, migrations/0002_add_buy_sell_rates.sql y migrations/0003_add_usdt_p2p_tiers.sql
- Cron Triggers:
  - 0 10 * * 1-5 (6:00 AM America/Caracas, lunes a viernes): Scraping BCV con HTMLRewriter nativo.
  - 0 */4 * * * (cada 4 horas): Consulta a https://api.yadio.io/rate/ves/usd y anuncios Binance P2P vía https://api.yadio.io/market/ads.
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
