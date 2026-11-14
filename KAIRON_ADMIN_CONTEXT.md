# SISTEMA: SUPER-ADMIN CONTROL CENTER (`super-admin` / `kairon-admin`)

Documento maestro estructurado para consumo por Modelos de Lenguaje (LLMs) como contexto técnico, arquitectónico, funcional y normativo integral del panel administrativo central (`super-admin`) del ecosistema SaaS **Kaironshop / Super-Catalog**.

> **Nota de ecosistema:** Este proyecto convive con el proyecto hermano `catalogo-dinamico` (documentado en `KAIRON_SHOP_CONTEXT.md`). Ambos comparten la misma base de datos **Cloudflare D1** y operan bajo esquemas complementarios. Cualquier cambio de esquema, hashing de contraseñas, permisos RBAC de tenants, estados de suscripción o tokens de impersonación debe mantenerse 100% compatible con `catalogo-dinamico`.

---

## 1. META INFORMACIÓN & STACK TECNOLÓGICO

```yaml
project_name: "super-admin"
worker_name: "kairon-admin"
type: "Backoffice SaaS Multi-Tenant (Control de Inquilinos, Conciliación de Pagos, P&L, Tasas, Comunicados, Auditoría, Operadores e Impersonación)"
runtime: "Cloudflare Workers / Pages (OpenNext Cloudflare adapter @opennextjs/cloudflare ^1.20.13)"
framework: "Next.js 16.4.2 (App Router, Streaming SSR, Server Components, Server Actions, Webpack build) + React 19.3.0"
language: "TypeScript 5 (Strict Mode)"
package_manager: "pnpm 11.22.0"
dev_port: 3100
styling: "Tailwind CSS v4 (@tailwindcss/postcss, @tailwindcss/turbopack) + Sistema de diseño TailAdmin (Dark por defecto / Light toggle) + tw-animate-css + Lucide Icons"
state_and_caching: "Streaming SSR (<Suspense>) + Next.js Client Router Cache (experimental.staleTimes: dynamic 600s / static 900s) + Server Actions (unwrapAction + revalidatePath)"
database: "Cloudflare D1 (SQLite Serverless compartido con catalogo-dinamico; binding `DB`, database_name `kairon-db`)"
forms_validation: "React Hook Form ^7.90.0 + @hookform/resolvers ^6.0.0 + Zod ^4.6.7"
date_engine: "Day.js ^1.11.23 (UTC en almacenamiento SQLite, America/Caracas UTC-4 para negocio y visualización)"
export_engine: "xlsx ^0.18.5 (Exportación cliente de reportes P&L multi-hoja)"
security: "PBKDF2-HMAC-SHA512 Web Crypto (constant-time XOR) + Sesiones opacas SHA-256 en D1 (`__Host-saas_super_session` en prod) + Cloudflare Turnstile + Rate Limiting en D1 (`login_attempts`) + Bitácora inmutable con Triggers SQLite + Headers CSP/HSTS/XFO"
```

---

## 2. REGLAS OBLIGATORIAS DE DESARROLLO Y ARQUITECTURA

### 2.1. Regla de Next.js 16.4.2 (`AGENTS.md`)
- Esta versión de Next.js (`16.4.2`) tiene cambios respecto a versiones previas. Antes de implementar o modificar APIs de framework (routing, `cookies()`, `headers()`, `searchParams`, `params`, Server Actions, `<Link>` / `useLinkStatus`, `loading.tsx`, config), consultar las guías en `node_modules/next/dist/docs/`.
- No eliminar ni editar manualmente el bloque `<!-- BEGIN:nextjs-agent-rules -->` en `AGENTS.md` (lo regenera `next dev`).
- En `page.tsx` y Route Handlers dinámicos (`tenants/[tenantId]`), `params` y `searchParams` son `Promise<...>` y deben resolverse con `await`.

### 2.2. Reglas de Base de Datos Compartida (D1) y Compatibilidad con `catalogo-dinamico`
1. **Propiedad de Tablas:**
   - **Tablas exclusivas de `super-admin`** (definidas en `schema-superadmin.sql`): `saas_super_admins`, `saas_super_sessions`, `saas_expenses`, `saas_audit_logs`, `rates`, `rate_history`.
   - **Tablas pertenecientes a `catalogo-dinamico`** (consumidas por `super-admin` sin alterar su DDL): `tenants`, `tenant_domains`, `roles`, `role_permissions`, `users`, `user_sessions`, `login_attempts`, `store_settings`, `products`, `orders`, `tenant_subscription_payments`, `saas_plans`, `saas_plan_features`, `saas_payment_accounts`, `saas_announcements`, `saas_impersonation_tokens`.
   - **Prohibición crítica:** `reset-superadmin.sql` y migraciones de `super-admin` NUNCA deben eliminar o truncar tablas de `catalogo-dinamico` (incluidas `saas_announcements` y `saas_impersonation_tokens`, aunque lleven prefijo `saas_`). `reset-superadmin.sql` solo limpia triggers e incluye `rate_history`, `rates`, `saas_audit_logs`, `saas_expenses`, `saas_super_sessions`, `saas_super_admins`.
2. **Compatibilidad Criptográfica (`lib/auth/crypto.ts`):**
   - Algoritmo obligatorio: **PBKDF2-HMAC-SHA512**, `100_000` iteraciones, salt de `32 bytes`, key de `64 bytes` (512 bits), formato `salt_hex:hash_hex`, comparación constant-time XOR (`timingSafeEqual`).
   - Debe mantenerse idéntico al de `catalogo-dinamico/lib/auth/crypto.ts` porque `super-admin` provisiona `users.password_hash` y resetea claves de usuarios de tiendas.
3. **Compatibilidad de RBAC de Tenants (`lib/actions/tenants.ts`):**
   - `ALL_18_PERMISSIONS` y `DEFAULT_TEMPLATES` (`Administrador`, `Cajero`, `Inventario`) deben mantenerse sincronizados con `catalogo-dinamico/lib/auth/permissions.ts`.
   - El rol `Dueño` (`is_owner = 1`) siempre recibe los 18 permisos al provisionar un tenant, y `store_settings` inicializa `admin_theme = 'orange'`.
4. **Atomicidad en D1:**
   - Operaciones multi-tabla (provisionar tenant completo, aprobar pago + activar/extender tenant, registrar pago manual + activar tenant, desactivar usuario/operador + revocar sesiones, suspender tenant + revocar sesiones, actualizar tasa + insertar `rate_history`) deben ejecutarse mediante `await db.batch([...])`.

### 2.3. Arquitectura de Streaming SSR, Caching y Server Actions
1. **Streaming SSR con `<Suspense>` + Consultas `server-only` (`lib/queries/*.ts`):**
   - Toda consulta SQL de lectura vive encapsulada en `lib/queries/*.ts` (`import "server-only"`) con consultas paralelas vía `Promise.all(...)` directamente contra D1 desde Server Components, sin exponer endpoints JSON `/api/panel/*` en el navegador.
   - `app/(panel)/layout.tsx` valida sesión (`requireSuperAdmin()`), calcula `getPendingPaymentsCountQuery()` en servidor y renderiza `<Sidebar admin={admin} pendingPaymentsCount={pendingPaymentsCount} />`.
   - Cada `page.tsx` bajo `app/(panel)/**/` es un componente síncrono que delega el trabajo asíncrono a un Server Component hijo (`*Content`) envuelto en `<Suspense fallback={<GlobalLoader variant="view" label="..." />}>`:
     - El `page.tsx` **nunca** ejecuta `await` bloqueantes antes de `<Suspense>` (pasa `params` / `searchParams` como `Promise` cuando aplica), permitiendo que Next.js cambie de ruta al instante y muestre el skeleton dentro de la vista destino mientras D1 responde por streaming RSC.
     - Dentro de `*Content`, siempre se invoca `await requireSuperAdmin("<area>")` antes de consultar D1 con `lib/queries/*.ts` y pasar `{ admin, data }` como props a `*Client.tsx`.
     - En `app/(panel)/tenants/[tenantId]/page.tsx`, si la tienda no existe se llama `notFound()` renderizando `app/(panel)/tenants/[tenantId]/not-found.tsx`.
2. **Client Router Cache (`next.config.ts`) e Invalidación (`revalidatePath`):**
   - `open-next.config.ts` utiliza `defineCloudflareConfig({})` sin binding incremental KV/R2 (`incrementalCache` / `tagCache` en modo `"dummy"`), por lo que el almacenamiento en caché de vistas visitadas recae en el **Client Router Cache** nativo de Next.js configurado en `next.config.ts`: `experimental.staleTimes: { dynamic: 600, static: 900 }` (10 min para segmentos dinámicos del panel, 15 min para estáticos), evitando lecturas repetidas a D1 al navegar entre vistas recientes.
   - Toda mutación en `lib/actions/*.ts` invoca `revalidatePath(...)` sobre las rutas y layouts impactados (ej. `payments.ts` revalida `/`, `/pagos`, `/dashboard`, `/finanzas`, `/tenants` y `/tenants/[id]`) para invalidar la caché del Router al completar acciones; en cliente las vistas usan `unwrapAction<T>()` (`lib/utils.ts`) directamente sin hooks intermedios, y los botones manuales de refresco/cambio de rango (`DashboardClient`, `PaymentsClient`, `RatesClient`) usan `useTransition` + `router.refresh()` / `router.replace()` (y `useOptimistic` en `DashboardClient`).

### 2.4. Loader Global de Vistas (`GlobalLoader` + `loading.tsx`)
1. **Componente Visual (`components/ui/GlobalLoader.tsx`):**
   - Skeleton loader gris claro animado (`animate-pulse` en bloques de cabecera, 4 tarjetas KPI y tabla de filas) acompañado de barra de progreso indeterminada superior (`animate-kairon-progress` en `app/globals.css`), sin retardos artificiales ni duraciones mínimas forzadas.
   - Variantes `view` (flujo dentro de `<main>`), `overlay` (`fixed inset-y-0 left-64 right-0 z-30` sobre `<main>` manteniendo la `Sidebar` visible e interactiva) y `fullscreen` (`fixed inset-0 z-50` para transiciones raíz), con atributos accesibles (`role="status"`, `aria-live="polite"`, `aria-busy="true"`).
2. **Cobertura de Carga Directa por Vista (Cero Duplicación):**
   - **Streaming / Suspense de rutas App Router:** `app/loading.tsx` (`variant="fullscreen"`), `app/(panel)/loading.tsx` (`variant="view"`) y los límites `<Suspense fallback={<GlobalLoader variant="view" />}>` en cada `app/(panel)/**/page.tsx`, sin loaders duplicados en `Sidebar` ni overlays redundantes en layout. El loading de acciones en modales se muestra exclusivamente en su botón de confirmación (`isPending`).

### 2.5. Reglas de Fechas y Zona Horaria (`lib/date.ts`, `lib/constants.ts`)
- **Almacenamiento en D1:** SIEMPRE en UTC formato SQLite `'YYYY-MM-DD HH:MM:SS'` (`toSqlDateTime()`).
- **Zona horaria del negocio:** `America/Caracas` (`UTC-4`, `BUSINESS_TIMEZONE`).
- **Cortes de periodo (`periodStartSql`):** Calculan `startOf('day' | 'month' | 'year')` en `America/Caracas` y luego convierten a `.utc().format('YYYY-MM-DD HH:MM:SS')`.
- **Fechas de calendario (`YYYY-MM-DD`):** `parseDbDate` las fija a mediodía UTC (`T12:00:00Z`) para evitar desfase *off-by-one* en UTC-4; `toSqlDateEndOfDay` las convierte a `23:59:59` en `America/Caracas` pasado a UTC.
- **Timestamps UNIX:** `saas_super_sessions`, `saas_impersonation_tokens`, `login_attempts` y `last_login_at` almacenan segundos epoch (`Math.floor(Date.now() / 1000)`). `parseDbDate` y `fmtUnix` distinguen automáticamente segundos vs milisegundos (`< 100_000_000_000`).
- **Regla de Membresía:** `1 mes = 30 días` exactos (`DAYS_PER_MEMBERSHIP_MONTH = 30`), aplicado vía `addSubscriptionMonths()`. Periodo de prueba estándar: **14 días** gratuitos (`DEFAULT_TRIAL_DAYS = 14`).
- **Precios y Ciclos SaaS (`DEFAULT_PLAN_PRICES`, `BILLING_PERIODS`):**
  - **Plan Básico:** Mensual `$11.99`, Semestral (6m, 10% OFF) `$64.75` (`$10.79/mes`), Anual (12m, 20% OFF) `$115.10` (`$9.59/mes`).
  - **Plan Pro:** Mensual `$23.99`, Semestral (6m, 10% OFF) `$129.55` (`$21.59/mes`), Anual (12m, 20% OFF) `$230.30` (`$19.19/mes`).
  - **Límites cuantitativos de plan (`saas_plans`):** `max_products` (50 / 500), `max_users` (1 / 3), `max_categories` (30 / 100), `max_variants_per_product` (5 / 15), `max_images_per_product` (5 / 8).
- **Base de renovación (`resolveSubscriptionBaseDate`):** Si `plan_expires_at` existe y es futuro, suma sobre esa fecha; si ya venció o es nulo, suma desde `now`.
- **Upgrade proporcional Básico → Pro (`calculateSubscriptionPeriod`):**
  - *Caso A (explícito en notas):* Si `payment.notes` contiene `= <N> días totales`, usa exactamente `<N>` días desde `now`.
  - *Caso B (prorrateo automático con descuentos de ciclo):* Si `current_plan === 'basic'` y `targetPlanSlug === 'pro'` con expiración futura, calcula el valor diario remanente de Básico según el ciclo contratado (`mensual`, `semestral` o `anual`), lo divide entre el costo diario de Pro y suma `monthsToCredit * 30`.
  - *Caso C (regular):* Suma `monthsToCredit * 30` días sobre `resolveSubscriptionBaseDate`.

### 2.6. Reglas de Seguridad, Validación Dual, RBAC y Auditoría
1. **Autenticación y Sesiones (`lib/auth/session.ts`, `lib/auth/guards.ts`):**
   - No existe `proxy.ts` ni `middleware.ts`. Toda protección ocurre en Server Components (`app/(panel)/layout.tsx`, `app/(panel)/**/page.tsx`) y Server Actions (`lib/actions/*.ts`) mediante `requireSuperAdmin(area?)`.
   - Cookie opaca `__Host-saas_super_session` en `NODE_ENV === "production"` (`saas_super_session` en dev) con `httpOnly: true`, `sameSite: "lax"`, `path: "/"`, `secure: NODE_ENV === "production"`. En D1 (`saas_super_sessions.id`) solo se almacena el hash **SHA-256** del token.
   - Ventana de sesión: **8 horas** de inactividad (`SESSION_INACTIVITY_SECONDS`), **7 días** límite absoluto (`SESSION_ABSOLUTE_SECONDS`). Sliding expiration optimizada: solo actualiza `last_seen_at` y `expires_at` en D1 si faltan >10 minutos de extensión (`newExpires - row.expires_at > 600`).
2. **RBAC del SuperAdmin (`lib/constants.ts`):**
   - Tres roles (`AdminRole`): `owner`, `finance`, `support`.
   - Once áreas (`AREAS`): `dashboard`, `pagos`, `tenants`, `usuarios`, `finanzas`, `planes`, `tasas`, `comunicados`, `auditoria`, `operadores`, `impersonar`.
   - Matriz `ROLE_AREAS`:
     - `owner`: acceso total (todas las áreas, incluido `operadores` para gestionar `saas_super_admins`).
     - `finance`: `dashboard`, `pagos`, `tenants`, `finanzas`, `planes`, `tasas`.
     - `support`: `dashboard`, `tenants`, `usuarios`, `comunicados`, `impersonar`, `tasas`.
   - Si un operador autenticado intenta acceder a un área sin permiso, `requireSuperAdmin(area)` redirige a `/dashboard?error=unauthorized`.
3. **Validación Sincronizada y Sanitización (`lib/validations/schemas.ts`, `lib/validations/forms.ts`, `lib/utils.ts`):**
   - `lib/validations/forms.ts` re-exporta todos los esquemas desde `lib/validations/schemas.ts` como **Fuente Única de Verdad** entre React Hook Form (cliente) y `.safeParse()` en cada Server Action y API Route.
   - Sanitización obligatoria: `sanitizePlainText` / `stripHtmlTags` en campos de texto libre, `sanitizeExternalUrl` (`https:` obligatorio en producción; `http:`/`https:` en dev) para enlaces externos/impersonación/logos, `safeRelativeRedirect` contra open redirects, y `parseBooleanField` / `parseStrictNumber` en parsing de `FormData`.
4. **Hardening HTTP y CSRF (`next.config.ts`):**
   - Cabeceras globales de seguridad: `Content-Security-Policy` (permitiendo `challenges.cloudflare.com`, fuentes Fontshare/Google Fonts e imágenes `assets.kaironshop.com` / `*.r2.dev`), `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy`, `Permissions-Policy` y `Strict-Transport-Security` en producción.
   - `experimental.serverActions.allowedOrigins` restringido a `admin.kaironshop.com` (más `localhost:3100` / `127.0.0.1:3100` en desarrollo) y `bodySizeLimit: "2mb"`.
5. **Rate Limiting y Turnstile (`lib/actions/auth.ts`, `lib/auth/turnstile.ts`):**
   - Login protegido por `verifyTurnstileToken` (opcional si no existe `TURNSTILE_SECRET_KEY`, obligatorio si está definida).
   - Rate limit en tabla compartida `login_attempts` usando prefijos `super_ip:<ip>` y `super_email:<email>` (máx. **5 intentos** por ventana de **15 minutos / 900s**).
6. **Inmutabilidad de Auditoría y Sesiones (`schema-superadmin.sql`, `lib/auth/audit.ts`, `lib/actions/auth.ts`):**
   - Toda mutación relevante (incluyendo `logoutAction`, que lee `getSuperAdminFromSession()` antes de destruir la sesión) llama `recordAuditLog(adminId, action, targetTenantId, details, ip)`.
   - Los triggers SQLite `trg_saas_audit_no_update` y `trg_saas_audit_no_delete` bloquean con `RAISE(ABORT, ...)` cualquier `DELETE` o `UPDATE` sobre columnas de negocio de `saas_audit_logs` (solo permite `ON DELETE SET NULL` en `admin_id`).
   - `revokeSuperSessionAction` permite revocar sesiones activas desde `/auditoria`.
7. **Re-confirmación por Contraseña en UI (`AdminPasswordConfirmModal`):**
   - Operaciones críticas en cliente (impersonación, cambio de estado/plan de tienda, extensión manual de días, edición individual/masiva de tasas) solicitan contraseña mediante `verifySuperAdminPasswordAction`.
8. **Impersonación Efímera (`generateImpersonationUrlAction`):**
   - Requiere área `impersonar` (`owner` o `support`).
   - Genera token de 64 chars hex, guarda su **SHA-256** en `saas_impersonation_tokens` con TTL de **60 segundos** (`IMPERSONATION_TTL_SECONDS`) apuntando a `owner_user_id` (o primer usuario activo del tenant).
   - Construye URL `<protocol>://<hostname>[:CATALOG_DEV_PORT]/api/auth/impersonate?token=<rawToken>`.

### 2.7. Reglas de UI / Sistema de Diseño (`app/globals.css`)
- **Estética TailAdmin:** Dark mode por defecto (`html.dark` con `--background: #1a222c`, `--surface: #24303f`, `--sidebar-bg: #1c2434`, `--primary: #3c50e0`) con soporte Light mode persistido en `localStorage.getItem("theme")` (`ThemeInitializer` + `ThemeToggle`).
- **Reglas forzadas en `globals.css`:**
  - Sidebar fijo (`w-64`, `pl-64` en el contenedor principal) permanece oscuro `#1c2434` incluso en Light mode.
  - Los botones con variantes `primary`, `danger`, `warning`, `success` o clases `.bg-[#3c50e0]`, `.bg-primary`, `.bg-[#ff6b26]`, `.bg-blue-600`, `.bg-rose-600`, `.bg-emerald-600` fuerzan texto blanco (`color: #ffffff !important`) vía CSS.
  - Clases legacy naranja (`#ff6b26`) y superficies oscuras (`#0a0a0c`, `#121216`, etc.) están puenteadas por CSS hacia la paleta TailAdmin (`#3c50e0`, `#1a222c`, `#24303f`). No introducir estilos inline conflictivos; usar componentes de `components/ui/*`.
  - Fuentes: `Satoshi` (sans/heading) vía Fontshare + `Fira Code` / `Geist Mono` (mono para montos, referencias, fechas y badges técnicos) vía Google Fonts.

---

## 3. ESQUEMA DE BASE DE DATOS (`schema-superadmin.sql` + TABLAS COMPARTIDAS)

### 3.1. Tablas Exclusivas de `super-admin`
```sql
saas_super_admins (
  id              TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  email           TEXT NOT NULL UNIQUE COLLATE NOCASE,
  full_name       TEXT NOT NULL,
  password_hash   TEXT NOT NULL, -- PBKDF2-HMAC-SHA512 `salt_hex:hash_hex`
  role            TEXT NOT NULL DEFAULT 'owner' CHECK (role IN ('owner', 'finance', 'support')),
  is_active       INTEGER NOT NULL DEFAULT 1,
  last_login_at   INTEGER DEFAULT NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

saas_super_sessions (
  id                  TEXT PRIMARY KEY, -- SHA-256 del token de cookie
  admin_id            TEXT NOT NULL REFERENCES saas_super_admins(id) ON DELETE CASCADE,
  user_agent          TEXT,
  ip_address          TEXT,
  created_at          INTEGER NOT NULL,
  last_seen_at        INTEGER NOT NULL,
  expires_at          INTEGER NOT NULL,
  absolute_expires_at INTEGER NOT NULL
);

saas_expenses (
  id                  TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  category            TEXT NOT NULL CHECK (category IN ('infraestructura', 'marketing', 'comisiones', 'desarrollo', 'impuestos', 'otros')),
  title               TEXT NOT NULL,
  description         TEXT DEFAULT NULL,
  amount_usd          REAL NOT NULL,
  exchange_rate_ves   REAL NOT NULL DEFAULT 1.0,
  amount_ves          REAL DEFAULT NULL,
  payment_method      TEXT DEFAULT NULL,
  reference           TEXT DEFAULT NULL,
  is_recurring        INTEGER NOT NULL DEFAULT 0,
  recurring_frequency TEXT DEFAULT NULL CHECK (recurring_frequency IN ('mensual', 'anual') OR recurring_frequency IS NULL),
  expense_date        TEXT NOT NULL DEFAULT (datetime('now')),
  created_by          TEXT REFERENCES saas_super_admins(id) ON DELETE SET NULL,
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

saas_audit_logs ( -- INMUTABLE vía triggers trg_saas_audit_no_update y trg_saas_audit_no_delete
  id                TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  admin_id          TEXT REFERENCES saas_super_admins(id) ON DELETE SET NULL,
  target_tenant_id  TEXT DEFAULT NULL,
  action            TEXT NOT NULL,
  details_json      TEXT DEFAULT NULL,
  ip_address        TEXT DEFAULT NULL,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

rates (
  id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  code        TEXT NOT NULL UNIQUE, -- Semillas: 'USD', 'EUR', 'BINANCE'
  name        TEXT NOT NULL,
  rate        REAL NOT NULL DEFAULT 1.0,
  source      TEXT NOT NULL DEFAULT 'Manual',
  is_active   INTEGER NOT NULL DEFAULT 1,
  updated_by  TEXT REFERENCES saas_super_admins(id) ON DELETE SET NULL,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

rate_history (
  id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  rate_id     TEXT NOT NULL REFERENCES rates(id) ON DELETE CASCADE,
  code        TEXT NOT NULL,
  rate        REAL NOT NULL,
  source      TEXT NOT NULL DEFAULT 'Manual',
  created_by  TEXT REFERENCES saas_super_admins(id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### 3.2. Tablas de `catalogo-dinamico` Leídas / Escritas por `super-admin`
- **Lectura y escritura:**
  - `tenants` (provisionamiento, estado, plan, vencimiento, `suspended_reason`, `max_products_override`, `max_users_override`, `admin_notes`).
  - `tenant_domains` (subdominio `<slug>.<ROOT_DOMAIN>`, `<slug>.localhost`, dominios `custom` verificados).
  - `roles` y `role_permissions` (creación de roles al provisionar tenant).
  - `users` (creación de dueño o empleado global, activación/suspensión, reseteo de `password_hash`).
  - `user_sessions` (revocación inmediata al suspender tenant o desactivar usuario; lectura de IPs para desbloqueo).
  - `login_attempts` (control de fuerza bruta de superadmins `super_ip:`/`super_email:` y limpieza de bloqueos de usuarios de tienda `ip:`/`email:`).
  - `store_settings` (creación inicial al provisionar tenant; lectura y visualización integral en expediente y tablas: `store_name`, `logo_url`, `cover_image_url`, `whatsapp_number`, `theme_preset_id`, `exchange_rate_code`, `delivery_price_usd`, `order_sound_enabled`, `storefront_config_json` y verificación de IA Gemini BYOK).
  - `tenant_subscription_payments` (conciliación: aprobar, rechazar con `rejection_reason`, registrar pago manual `approved` con soporte de ciclos mensual, semestral de 6 meses y anual de 12 meses).
  - `saas_plans` y `saas_plan_features` (edición de precios $11.99 / $23.99, descuentos semestral 10% y anual 20%, cuotas cuantitativas `max_categories`, `max_variants_per_product`, `max_images_per_product` y feature flags; gestión de bullets).
  - `saas_payment_accounts` (cuentas bancarias receptoras de suscripciones SaaS).
  - `saas_announcements` (banners globales segmentados por `target_status`, `target_plan`, `variant`, `expires_at`).
  - `saas_impersonation_tokens` (inserción de tokens SHA-256 de 60s).
- **Solo lectura (métricas):**
  - `products` (conteo por tenant).
  - `orders` (conteo y GMV `SUM(total_usd)` excluyendo `status = 'cancelled'`).

---

## 4. MAPA COMPLETO DE ARCHIVOS, RUTAS Y MÓDULOS

```text
super-admin/
├── app/
│   ├── (auth)/login/
│   │   ├── page.tsx                       # Verifica sesión existente -> redirect("/dashboard"), pasa TURNSTILE_SITE_KEY
│   │   └── LoginClient.tsx                # Form react-hook-form + zod + Turnstile estado controlado
│   ├── (panel)/
│   │   ├── layout.tsx                     # Guard requireSuperAdmin() + getPendingPaymentsCountQuery() + Sidebar
│   │   ├── loading.tsx                    # Fallback Suspense de vistas del panel (`GlobalLoader variant="view"`)
│   │   ├── dashboard/page.tsx             # Suspense + DashboardContent (RBAC `dashboard`, `?period=`) -> DashboardClient
│   │   ├── pagos/page.tsx                 # Suspense + PaymentsContent (RBAC `pagos`, `?id=`) -> PaymentsClient
│   │   ├── tenants/
│   │   │   ├── page.tsx                   # Suspense + TenantsContent (RBAC `tenants`) -> TenantsListClient
│   │   │   ├── nuevo/page.tsx             # Suspense + CreateTenantContent (RBAC `tenants`, rootDomain) -> CreateTenantClient
│   │   │   └── [tenantId]/
│   │   │       ├── page.tsx               # Suspense + TenantDetailContent (RBAC `tenants`, `notFound()`) -> TenantDetailClient
│   │   │       └── not-found.tsx          # Pantalla de tienda no encontrada en D1
│   │   ├── usuarios/page.tsx              # Suspense + UsersContent (RBAC `usuarios`) -> UsersClient
│   │   ├── finanzas/page.tsx              # Suspense + FinancesContent (RBAC `finanzas`) -> FinanzasClient
│   │   ├── planes-y-cuentas/page.tsx      # Suspense + PlansContent (RBAC `planes`) -> PlanesClient
│   │   ├── tasas/page.tsx                 # Suspense + RatesContent (RBAC `tasas`) -> RatesClient
│   │   ├── comunicados/page.tsx           # Suspense + AnnouncementsContent (RBAC `comunicados`) -> ComunicadosClient
│   │   ├── auditoria/page.tsx             # Suspense + AuditContent (RBAC `auditoria`) -> AuditClient
│   │   └── operadores/page.tsx            # Suspense + OperatorsContent (RBAC `operadores`, solo rol `owner`) -> SuperAdminsClient
│   ├── api/
│   │   ├── images/[...key]/route.ts       # Proxy seguro streaming de R2 kairon-assets con autenticación SuperAdmin, CSP sandbox, mime-types allowlist y ETag
│   │   └── setup/route.ts                 # POST bootstrapping primer SuperAdmin (o adicionales con SETUP_TOKEN)
│   ├── loading.tsx                        # Fallback Suspense raíz (`GlobalLoader variant="fullscreen"`)
│   ├── globals.css                        # Tokens TailAdmin Dark/Light, bridges legacy, keyframe de carga (`kairon-progress-*`)
│   ├── layout.tsx                         # Root HTML (`class="dark"`), Satoshi + Fira Code + Geist Mono, ThemeInitializer, Toaster
│   └── page.tsx                           # Redirect -> /dashboard
├── components/
│   ├── auditoria/AuditClient.tsx
│   ├── comunicados/ComunicadosClient.tsx
│   ├── dashboard/DashboardClient.tsx
│   ├── finanzas/FinanzasClient.tsx
│   ├── layout/                            # Header, Sidebar, ThemeInitializer, ThemeToggle
│   ├── operadores/SuperAdminsClient.tsx   # Gestión CRUD de operadores (`owner` / `finance` / `support`), estado, contraseña y sesiones
│   ├── pagos/                             # PaymentsClient, ApprovePaymentModal, RejectPaymentModal, ManualPaymentModal, PaymentDetailModal
│   ├── planes/PlanesClient.tsx
│   ├── tasas/RatesClient.tsx
│   ├── tenants/                           # TenantsListClient, TenantDetailClient, CreateTenantClient
│   ├── ui/                                # AdminPasswordConfirmModal, Badge, Button, ConfirmModal, GlobalLoader, InfoTooltip, Input, Modal, Pagination, Select, StatCard, StoreAvatar, Textarea, Toast, WhatsAppButton
│   └── usuarios/UsersClient.tsx
├── lib/
│   ├── actions/
│   │   ├── announcements.ts               # createAnnouncementAction, toggleAnnouncementAction, deleteAnnouncementAction
│   │   ├── auth.ts                        # loginAction, logoutAction (con auditoría), verifySuperAdminPasswordAction, revokeSuperSessionAction
│   │   ├── expenses.ts                    # createExpenseAction, deleteExpenseAction
│   │   ├── payments.ts                    # approvePaymentAction, rejectPaymentAction, registerManualPaymentAction, refreshPaymentsAction
│   │   ├── plans.ts                       # updatePlanAction, add/deletePlanFeatureAction, create/toggle/deletePaymentAccountAction
│   │   ├── rates.ts                       # updateRateAction, batchUpdateRatesAction, toggleRateStatusAction
│   │   ├── superadmins.ts                 # createSuperAdminAction, updateSuperAdminAction, toggleSuperAdminStatusAction, resetSuperAdminPasswordAction, revokeSuperAdminSessionsAction
│   │   ├── tenants.ts                     # createTenantAction, updateTenantStatusAction, updateTenantPlanAction, extendTenantSubscriptionAction, updateTenantOverridesAction, addCustomDomainAction, deleteDomainAction, generateImpersonationUrlAction
│   │   └── users.ts                       # createGlobalUserAction, toggleUserStatusAction, resetUserPasswordAction, clearUserLoginAttemptsAction
│   ├── auth/
│   │   ├── audit.ts                       # recordAuditLog()
│   │   ├── crypto.ts                      # hashPassword, verifyPassword, sha256 (PBKDF2-HMAC-SHA512 Web Crypto)
│   │   ├── guards.ts                      # getClientMeta, requireSuperAdmin, getSuperAdminOrNull
│   │   ├── session.ts                     # SUPER_COOKIE_NAME (`__Host-saas_super_session` en prod), createSuperSession, getSuperAdminFromSession, destroySuperSession
│   │   └── turnstile.ts                   # verifyTurnstileToken()
│   ├── queries/                           # Consultas D1 `server-only` paralelas (`Promise.all`) consumidas directo por Server Components
│   │   ├── announcements.ts, audit.ts, dashboard.ts, finances.ts, operators.ts, payments.ts, plans.ts, rates.ts, tenants.ts, users.ts
│   ├── validations/
│   │   ├── schemas.ts                     # Schemas Zod estrictos compartidos (frontend + backend)
│   │   └── forms.ts                       # Re-export de `./schemas`
│   ├── constants.ts                       # Enums, labels, BUSINESS_TIMEZONE, DAYS_PER_MEMBERSHIP_MONTH, AREAS (11), ROLE_AREAS, canAccess()
│   ├── date.ts                            # Engine Day.js UTC <-> America/Caracas y calculateSubscriptionPeriod()
│   ├── db.ts                              # getEnv(), getDB(), envVar(), getRootDomain(), getAppHost()
│   ├── types.ts                           # Interfaces de dominio, DTOs de consultas y ActionResult<T>
│   └── utils.ts                           # cn, fmtUSD, fmtVES, fmtNum, fmtPct, unwrapAction, sanitizePlainText, sanitizeExternalUrl, safeRelativeRedirect, parseBooleanField, parseStrictNumber + re-exports date.ts
├── scripts/
│   └── create-superadmin.mjs              # CLI Node para generar hash PBKDF2 y sentencia INSERT INTO saas_super_admins
├── AGENTS.md                              # Regla de documentación Next.js 16
├── next.config.ts                         # Carga .env -> D1_PERSIST_PATH, experimental.staleTimes, CSP + Security Headers, allowedOrigins, turbopack rules
├── open-next.config.ts                    # defineCloudflareConfig({})
├── wrangler.jsonc                         # Config Worker `kairon-admin`, binding D1 `kairon-db`, R2 `kairon-assets`, vars
├── cloudflare-env.d.ts                    # Tipado CloudflareEnv
├── schema-superadmin.sql                  # DDL exclusivo de super-admin + triggers inmutables + seeds rates
├── seed.sql                               # SuperAdmin inicial (`admin@supercatalog.com` / `SuperAdmin2026*`)
└── reset-superadmin.sql                   # Drop seguro de tablas exclusivas de super-admin (incluyendo rates y rate_history)
```

---

## 5. CONFIGURACIÓN, ENTORNO Y COMANDOS

### 5.1. Variables de Entorno (`.env` / `wrangler.jsonc` / `cloudflare-env.d.ts`)
- **Bindings Cloudflare (`wrangler.jsonc`):**
  - `DB`: D1 Database (`kairon-db`).
  - `R2_BUCKET`: R2 Bucket (`kairon-assets`, consumido por `app/api/images/[...key]/route.ts` para servir logos y portadas de tiendas de forma segura).
- **Variables públicas / de configuración:**
  - `ROOT_DOMAIN`: Dominio raíz para subdominios de tiendas (`kaironshop.com` en `wrangler.jsonc` y fallback en `lib/db.ts`).
  - `APP_HOST`: Host de la app (`admin.kaironshop.com` en `wrangler.jsonc` y `lib/db.ts`).
  - `TENANT_PROTOCOL`: Protocolo para enlaces hacia tiendas (`http` en dev, `https` en prod).
  - `CATALOG_DEV_PORT`: Puerto local de `catalogo-dinamico` (p. ej. `3000`) usado para armar URLs de impersonación y enlaces en desarrollo.
  - `SUPPORT_WHATSAPP`: Número de soporte (declarado en `cloudflare-env.d.ts` y `.env`).
  - `D1_PERSIST_PATH`: Ruta local a la persistencia `.wrangler/state/v3` de `catalogo-dinamico` para compartir el D1 SQLite en desarrollo.
  - `NEXT_PUBLIC_TURNSTILE_SITE_KEY`: Site key pública de Cloudflare Turnstile para `/login`.
- **Secretos:**
  - `TURNSTILE_SECRET_KEY`: Clave privada de Turnstile (si está vacía, el login omite validación de captcha).
  - `SETUP_TOKEN`: Token requerido por `POST /api/setup` cuando ya existe al menos un SuperAdmin en `saas_super_admins`.

### 5.2. Comandos (`package.json`)
```bash
pnpm dev              # Next dev en puerto 3100 conectado a D1 local compartido
pnpm typecheck        # next typegen && tsc --noEmit
pnpm lint             # eslint (nota: ignorar .open-next/ si existe build CF previo)
pnpm build            # next build --webpack
pnpm build:cf         # opennextjs-cloudflare build
pnpm deploy           # build:cf + opennextjs-cloudflare deploy
pnpm db:schema        # Ejecuta schema-superadmin.sql en D1 local (`kairon-db`)
pnpm db:schema:remote # Ejecuta schema-superadmin.sql en D1 remoto
pnpm db:seed          # Ejecuta seed.sql en D1 local
pnpm admin:create     # node scripts/create-superadmin.mjs <email> <pass> <name> <role>
```

---

## 6. CONVENCIONES DE CÓDIGO PARA NUEVAS FUNCIONALIDADES Y CORRECCIONES

1. **Toda Server Action** en `lib/actions/*.ts` debe:
   - Iniciar con `"use server";`.
   - Llamar `const admin = await requireSuperAdmin("<area>");` antes de tocar D1.
   - Validar entradas con `.safeParse(...)` usando los esquemas compartidos de `lib/validations/schemas.ts` y sanitizar textos libres con `sanitizePlainText(...)`.
   - Obtener IP/UA vía `await getClientMeta()` y registrar auditoría con `await recordAuditLog(...)`.
   - Retornar `ActionResult<T>` (`{ ok: true, data: ... } | { ok: false, error: string }`), excepto `loginAction` / `logoutAction` que hacen `redirect()`.
   - Invocar `revalidatePath(...)` sobre todas las rutas y layouts impactados para invalidar el Client Router Cache, y consumirla directamente desde el componente cliente con `unwrapAction<T>()` (`lib/utils.ts`) mostrando estado `isPending` en el botón disparador.
2. **Nuevas Vistas del Panel (`app/(panel)/<area>`):**
   - Crear consulta `server-only` en `lib/queries/*.ts` usando `Promise.all(...)`, implementar `app/(panel)/<area>/page.tsx` de forma síncrona delegando en un Server Component hijo asíncrono (`*Content`) envuelto en `<Suspense fallback={<GlobalLoader variant="view" label="..." />}>`, invocar `await requireSuperAdmin("<area>")` antes de consultar D1 y pasar `{ admin, data }` al componente cliente.
3. **Consultas D1:**
   - Usar siempre sentencias preparadas con `.bind(...)` (`?1`, `?2`, ...). Nunca interpolar strings de usuario en SQL.
   - Usar `db.batch([...])` siempre que una operación escriba en más de una tabla o deba mantener consistencia entre `tenants` y registros relacionados.
4. **Módulo de Tasas:**
   - La tabla `rates` tiene códigos esperados `USD`, `EUR`, `BINANCE`. Cualquier cambio de tasa debe insertarse también en `rate_history`.
5. **Conciliación de Pagos (`lib/actions/payments.ts`):**
   - `approvePaymentAction` debe validar que el pago no esté ya `approved` (`idempotencia`), usar `calculateSubscriptionPeriod()` para calcular `period_start`, `period_end` y `plan_expires_at`, limpiar `suspended_reason` y `grace_period_ends_at`, y poner `tenants.status = 'active'`.

---

## 7. DEUDA TÉCNICA CONOCIDA Y OPORTUNIDADES DE MEJORA (OBSERVACIONES REALES DEL CÓDIGO)

1. **Autorización efímera para `AdminPasswordConfirmModal`:**
   - `TenantDetailClient.tsx` y `RatesClient.tsx` validan la contraseña mediante `verifySuperAdminPasswordAction` antes de invocar acciones críticas (`generateImpersonationUrlAction`, `updateTenantStatusAction`, `extendTenantSubscriptionAction`, `updateRateAction`, `batchUpdateRatesAction`). *Mejora:* Emitir un token/nonce corto en D1 al verificar la contraseña y exigirlo en dichas Server Actions para vincular criptográficamente la re-autenticación en servidor.
2. **Escalabilidad y Paginación Server-Side:**
   - `lib/queries/payments.ts` (`LIMIT 200`, detección de referencias duplicadas en memoria sobre esos 200 registros), `lib/queries/users.ts` (`LIMIT 300`), `lib/queries/finances.ts` (`LIMIT 300`), `lib/queries/audit.ts` (`LIMIT 250`) y `lib/queries/tenants.ts` (5 subconsultas correlacionadas sin `LIMIT`) paginan/filtran en cliente. *Mejora:* Mover filtros/paginación y detección global de duplicados de referencia a SQL indexado server-side.
   - `lib/queries/finances.ts` calcula ingresos históricos globales (`status = 'approved'`) sin selector de rango temporal como el del Dashboard.
3. **Operación y Configuración:**
   - Existe `clearUserLoginAttemptsAction` para desbloquear claves `ip:` / `email:` de usuarios de tiendas, pero no un desbloqueo desde UI para claves `super_ip:` / `super_email:` si un operador alcanza el límite de intentos.
   - `ensureRatesTables(db)` en `lib/queries/rates.ts` sigue ejecutando `CREATE TABLE IF NOT EXISTS` + `INSERT OR IGNORE` en runtime en lugar de depender exclusivamente de `schema-superadmin.sql`.
   - No existe flujo de archivado/eliminación segura de tenants de prueba (`deleteTenantAction`); solo cambio de estado a `suspended`.
   - `eslint.config.mjs` no ignora `.open-next/**` (generado por `pnpm build:cf`), por lo que `pnpm lint` global inspecciona artefactos compilados si existen en disco; adicionalmente `components/layout/ThemeToggle.tsx` mantiene un aviso/error preexistente de `react-hooks/set-state-in-effect`.
   - `scripts/create-superadmin.mjs` y comentarios de `schema-superadmin.sql` mencionan `catalogo-db` en textos informativos mientras el binding D1 real es `kairon-db`.
