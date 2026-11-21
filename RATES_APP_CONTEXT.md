# AGENTS.md — RatesVenApp Context

> Canonical AI context file. Linked by [CLAUDE.md](CLAUDE.md) via `@AGENTS.md`.

<gates>
EXPO_DOCS:
  trigger: any-code-change
  rule: Expo SDK 57 (`expo ~57.0.20`, `react 19.2.3`, `react-native 0.86.3`) has breaking changes vs older SDKs. Verify APIs at https://docs.expo.dev/versions/v57.0.0/ before writing code.

SECRETS:
  rule: Never hardcode or commit `EXPO_PUBLIC_RATES_API_KEY` into tracked files (`src/`, `eas.json`, `app.json`). Keep secrets only in `.env` (gitignored) or EAS environment secrets.

REACT_COMPILER:
  rule: `experiments.reactCompiler: true` is active in `app.json`. Never read/write `ref.current` during render; keep hooks pure. Put `'use no memo';` at the top of Android widget files (`src/widgets/RatesWidget.tsx`) because `react-native-android-widget` calls widget functions directly outside React render.
</gates>

<project>
name: RatesVenApp (`new-rates-app`)
purpose: Venezuelan exchange rate converter (USD BCV, EUR BCV, USDT Yadio, VES), custom merchant rates, IVA/IGTF/mixed-payment calculators, payment templates, bill splitter, historical charts, offline cache, multi-currency shopping budget calculator (with PNG/PDF tickets), shareable rate images, and Android home screen widgets.
pkg_manager: pnpm (`pnpm-lock.yaml`)
path_aliases: `@/*` -> `./src/*` | `@/assets/*` -> `./assets/*`
stack:
  framework: Expo SDK 57 + Expo Router (`~57.0.19`, typedRoutes, entry `index.ts`)
  ui: NativeWind v4 (`tailwindcss ^3.4.19`) + `react-native-reanimated 4.5.1` + `react-native-gesture-handler ~2.32.0` + `react-native-pager-view 8.0.2` + `react-native-svg ^15.15.4` + `lucide-react-native` + `react-native-gifted-charts`
  fonts: `@expo-google-fonts/poppins` (`Poppins_400Regular`, `Poppins_500Medium`, `Poppins_600SemiBold`, `Poppins_700Bold`)
  state: Zustand (`currencyStore`, `shoppingStore`, `customRateStore`, `paymentTemplatesStore`, `billSplitStore`, `toastStore`) + TanStack Query v5 (`PersistQueryClientProvider`)
  network_and_share: `fetch` + `@react-native-community/netinfo` + `@react-native-async-storage/async-storage` + `expo-clipboard` + `expo-sharing` + `react-native-view-shot` + `expo-print` + `react-native-android-widget`
</project>

<file_map>
entry_and_routes:
  index.ts: Root entry (`"main"` in `package.json`); imports `expo-router/entry` and registers Android `widgetTaskHandler`
  src/app/_layout.tsx: Root layout, Poppins font loading, NativeWind primary `vars()`, `Toast` overlay, `AnimatedSplashOverlay` gated on `fontsLoaded && storeHydrated`, onboarding gate (`!hasCompletedOnboarding`), `Stack` (`(tabs)`, `shopping/[id]`, `tools/*`), QueryClient + AsyncStorage persister, NetInfo -> React Query `onlineManager`
  src/app/(tabs)/_layout.tsx: Bottom tabs (`animation: 'shift'`, `headerShown: false`; order: `history`, `shopping`, center initial `index`, `tools`, `settings`) with sliding `CustomTabBar`
  src/app/(tabs)/index.tsx: Main converter — `RatesHero` + `PullToRefreshScrollView` + `CurrencyInput` + `FiscalToolsCard` (IVA/IGTF toggles + Pago mixto link) + 3 `RateCard`s (all 4 currencies visible) + enabled `CustomRateCard`s + `ShoppingEntryCard`, 300ms input debounce, immediate card swap, clean `ScreenHero` + `EmptyState` on error/empty
  src/app/(tabs)/history.tsx: Fixed compact `ScreenHero` with `CurrencyTabSelector`, left/right horizontal swipe between `USD|EUR|USDT`, `PullToRefreshScrollView`, `PeriodSelector` (`1d|3d|7d|30d`), `PriceChart`, `StatsRow`, `PriceHistoryList`
  src/app/(tabs)/shopping.tsx: Shopping lists hub tab — active in-progress purchases, completed purchase history, create list modal (`ListSettingsModal`), delete confirmation via `AppModal`
  src/app/(tabs)/tools.tsx: Tools hub grid linking to custom rates, mixed payment, payment templates, bill splitter, and shareable rate cards
  src/app/(tabs)/settings.tsx: Fixed compact `ScreenHero`, flat `Card` groups, theme mode (`dark|light|system`), 6-color primary picker, haptics toggle (`Vibración al tocar`), commerce/taxes editor sheet (`businessName`, IVA/IGTF %, link to custom rates), force refresh, cache clear, `AppModal` dialogs
  src/app/shopping/[id].tsx: Dual-mode shopping screen + `Share2` button opening ticket preview `AppSheet` (PNG/PDF/text export)
  src/app/tools/custom-rate.tsx: CRUD & toggle manager for multiple custom rates (`emoji` picker, `fixed | average | margin`, base currency, rounding up to `0.5/1/5/10` Bs)
  src/app/tools/mixed-payment.tsx: Mixed foreign-cash + Pago Móvil VES remainder calculator with per-cash-only IGTF and bank-safe copy / payment template handoff
  src/app/tools/payments.tsx & src/app/tools/payments/[id].tsx: Payment template list & shareable detail (`Pago Móvil`, `Transferencia`, `Binance Pay`, `Zelle`, `Otro`) with optional multi-currency amount, tap-to-copy fields, bank-safe VES amount (`3650,25`), and formatted share message
  src/app/tools/split.tsx & src/app/tools/split/[id].tsx: Multi-currency bill splitter (last 30 saved), tip presets/fixed, N people, exact cent-residual split + custom per-person override, `"Pagó"` status tracking, and payment template handoff
  src/app/tools/share-rates.tsx: Full-screen shareable rate image builder (shares `ShareRatesStudio` with `RatesHero` sheet)

services_and_data:
  src/services/ratesApi.ts: Cloudflare API client (`X-API-Key`, NetInfo pre-check, AsyncStorage fallback cache, dedupe, 10s timeout) + `fetchWidgetRates()` (30m cache TTL for background widget updates)
  src/types/currency.types.ts: API DTOs, app domain types, shopping types, custom rate/fiscal types, payment template discriminated union, and bill splitter types
  src/constants/banks.ts: Venezuelan SUDEBAN bank catalog (`code`, `name`, `shortName`)
  src/utils/constants.ts: Env config, `CURRENCY_TO_API`, React Query keys, cache TTLs (`5m` stale / `7d` GC), currency metadata, `PRIMARY_COLOR_OPTIONS`, `THEME_COLORS`, `APP_VERSION`
  src/utils/formatters.ts: `es-VE` number formatters, `formatBankAmount` (`3650,25` without thousands separator), `date-fns` Spanish formatters, `formatInputValue`, `parseFormattedNumber`
  src/utils/ratesTransform.ts: Shared `buildUnifiedRatesFromApi()` pure mapper used by both `useCurrencyRates` and headless `widgetTaskHandler`
  src/utils/customRateUtils.ts: `resolveCustomRateValue()`, `applyCustomRateRounding()`, `buildEffectiveRatesSnapshot()`, `buildRateSourceOptions()`, `convertWithRateSource()`
  src/utils/fiscalUtils.ts: `computeFiscalBreakdown()` (IVA/IGTF), `computeMixedPayment()` (IGTF strictly on foreign cash paid)
  src/utils/paymentFormat.ts: SUDEBAN template validator + formatted multi-currency payment share builder
  src/utils/splitUtils.ts: Exact cent-residual `computeSplitSummary()` + `buildSplitShareText()`
  src/utils/shareUtils.ts: Centralized `copyToClipboard`, `shareTextContent`, `shareViewAsImage`, `sharePdfFromHtml`
  src/utils/ticketHtml.ts: Printable 80mm HTML receipt & WhatsApp plain-text formatters for shopping lists
  src/utils/shoppingUtils.ts: Pure multi-currency shopping helpers
  src/utils/haptics.ts: Centralized haptic triggers gated on `useCurrencyStore.getState().hapticsEnabled`
  src/store/currencyStore.ts: Zustand store (`selectedCurrency`, `amount`, `themeMode`, `primaryColor`, `hasCompletedOnboarding`, `hapticsEnabled`, `fiscalSettings`, `businessName`)
  src/store/customRateStore.ts | shoppingStore.ts | paymentTemplatesStore.ts | billSplitStore.ts | toastStore.ts

hooks:
  src/hooks/useCurrencyRates.ts: Fetches `today` + `recent` rates, respects `useIsRestoring()`, builds `UnifiedRates`, syncs Android widgets via `syncWidgetsWithRates`
  src/hooks/useEffectiveRates.ts: Combines `useCurrencyRates` with active `useCustomRateStore` entries into `snapshot` and `sourceOptions`
  src/hooks/useHistoricalRates.ts | useConversion.ts | useOfflineStatus.ts | useThemeColors.ts

components_ui:
  src/components/ui/RatesHero.tsx: Edge-to-edge fixed primary-colored rounded-bottom (`28px`) Hero with `logo.webp` + `RATESVEN`, `Share2` action (`ShareRatesSheet`), `OfflineBadge`, and 3 pressable rate cards opening `AppModal` dialogs
  src/components/ui/CustomTabBar.tsx: 5-slot curved SVG (`COLORS.primary`) bottom tab bar (`history | shopping | index | tools | settings`) with worklet animated notch (`useAnimatedProps`) and sliding circular active FAB
  src/components/ui/AppModal.tsx | AppSheet.tsx | Toast.tsx | RateSourceSelector.tsx | CustomRateCard.tsx | RateCard.tsx | CurrencyInput.tsx | OfflineBadge.tsx | EmptyState.tsx | ConverterSkeleton.tsx | ThreeDotsLoader.tsx | PullToRefreshScrollView.tsx | CurrencyIcon.tsx | ScreenHero.tsx | CurrencyTabSelector.tsx | PriceChart.tsx | PriceHistoryList.tsx | StatsRow.tsx
  src/components/converter/FiscalToolsCard.tsx: Inline `+ IVA` / `+ IGTF` toggles, breakdown copy card, and `Pago mixto` shortcut
  src/components/share/RateShareCard.tsx | ShareRatesSheet.tsx | ShoppingTicket.tsx: Capture-ready PNG (`react-native-view-shot`) rate poster and receipt components
  src/components/tools/PaymentTemplateSheet.tsx: Shared modal sheet for creating/editing payment templates
  src/widgets/RatesWidget.tsx & widgetTaskHandler.tsx: Android home screen widgets (`RatesSmall` 2x1 & `RatesMedium` 4x2) with light/dark mode and click-to-refresh/open-app

components_onboarding:
  src/components/onboarding/OnboardingScreen.tsx: Full-bleed edge-to-edge studio gradient onboarding with brand header, `"Saltar"`, `OnboardingPager`, `OnboardingDots`, and `"Siguiente"`/`"Entrar"` CTA
  src/components/onboarding/OnboardingPager.tsx & .web.tsx: Native `PagerView` (+ web `ScrollView` fallback) streaming `scrollOffset` via Reanimated `useEvent`/`useHandler`
  src/components/onboarding/OnboardingSlides.tsx: 4 asymmetrical slides (`RealtimeRatesSlide`, `OfflineAccessSlide`, `ShoppingCalculatorSlide`, `PersonalizationHistorySlide`) using `assets/images/onboarding-1..4.webp` with basic entrance animations
  src/components/onboarding/OnboardingDots.tsx: Fluid interpolated pill indicator (`8px -> 30px`)

components_shopping:
  src/components/shopping/CurrencyChipRow.tsx: 4-currency selector pill bar (`default` | `hero`)
  src/components/shopping/ShoppingEntryCard.tsx: Main screen card to launch/resume shopping calculator or open lists
  src/components/shopping/BudgetProgressCard.tsx: `BudgetProgressBar` + `ListSettingsModal` for list title and optional budget limit
  src/components/shopping/ProductFormCard.tsx: Fast item entry/edit form (price, currency selector, `-`/`+` quantity stepper, optional name, live subtotal preview)
  src/components/shopping/ShoppingItemRow.tsx: Item row with native/converted subtotals and quantity/edit/delete controls
  src/components/shopping/ActualPaidCard.tsx: Checkout price input + calculated vs actual difference summary

config:
  app.json: Expo config (`version: 1.0.4`, `android.versionCode: 4`, `android.package: com.devlopez.ratesvenapp`, `ios.bundleIdentifier: com.devlopez.ratesvenapp`, orange splash `#ff6b26`, `logo.webp`, `expo-sharing`, `react-native-android-widget`, `extra.eas.projectId`)
  eas.json: EAS build profiles (`development`, `preview` [APK], `production` [APK], `production-aab` [AAB])
  android/: Versioned in git (`.gitignore` excludes `build/`, `.gradle/`, `.cxx/`, `.kotlin/`, `local.properties`, `keystore.properties`, `*.keystore`, `*.jks`, `*.apk`, `*.aab`); includes `MainActivity.kt` Android 14+ nav bar contrast fix, `styles.xml`, R8 minify + resource shrinking + default `arm64-v8a` in `gradle.properties`, `expo.webp.enabled=true`, and widget receivers/providers (`RatesSmall.java`, `RatesMedium.java`, `res/xml/widgetprovider_*.xml`)
  tailwind.config.js & src/global.css: Theme tokens + Poppins weight-to-fontFamily mapping (`--color-primary` in `.dark:root` defaults to `184 69 20`)
</file_map>

<api_contract source="https://github.com/jose1937JS/rates-cloudflare">
base_url: `EXPO_PUBLIC_RATES_API_URL` (default `https://rates-api.dev-lopezjose.workers.dev`)
auth: Header `X-API-Key: <EXPO_PUBLIC_RATES_API_KEY>`
rate_limit: `10` requests / `60s` per IP on Cloudflare Worker — minimize calls, never remove caching/dedupe
cors: Native apps send no `Origin` (allowed); web requests require Worker `ALLOWED_ORIGINS` allowlist

endpoints:
  GET /api/rates/today: Latest `BCV_USD`, `BCV_EUR`, `YD_USD` in `America/Caracas` with `isFallback: true` on weekends/holidays
  GET /api/rates?page=1&limit=60&days=7: Recent rates across all currencies (used for `%` change vs previous entry)
  GET /api/rates/:currency: Latest single record (`BCV_USD | BCV_EUR | YD_USD`)
  GET /api/rates/:currency/all?page=1&limit=100&days=30: Paginated currency history (`YD_USD` runs every 4h -> ~180 rows/30d, `fetchCurrencyHistory` fetches max 2 pages)
  POST /api/sync?source=all|bcv|yadio: Triggers scraping + D1 insert — do NOT call automatically on mount/refresh
</api_contract>

<invariants_and_gotchas>
startup_state:
  rule: App MUST always launch with `selectedCurrency: 'USD'` and `amount: '1'`.
  detail: `currencyStore.ts` `partialize` persists `themeMode`, `primaryColor`, `hasCompletedOnboarding`, `hapticsEnabled`, `fiscalSettings`, and `businessName` — NEVER `selectedCurrency` or `amount`. `_layout.tsx` waits for `storeHydrated` before hiding `AnimatedSplashOverlay` or deciding between `OnboardingScreen` and `(tabs)`.

custom_rates_isolation:
  rule: Custom rates (`customRateStore.ts`) MUST remain independent from `UnifiedRates` and API caches so official BCV/Yadio figures stay unaltered across Hero, History, and RateCards.

reanimated_layout_wrappers:
  rule: Never put `entering`/`exiting`/`layout` props on the same `<Animated.View>` that also receives a `useAnimatedStyle` with `opacity` or `transform` — apply layout animations to an outer wrapper.

native_prebuild_guard:
  rule: NEVER run `npx expo prebuild --clean` because `android/` contains tracked native customizations (`MainActivity.kt`, `styles.xml`, `gradle.properties`, signing, and widget receivers). Also avoid `app.plugin.js` auto-overwriting `android/` paths without checking `git diff android/`.

all_currencies_visible:
  rule: Converter screen MUST always render all 4 currencies (`USD`, `EUR`, `USDT`, `VES`) — 1 in `CurrencyInput` + 3 `RateCard`s below (`VES` first when not selected). Never filter out `USD`/`EUR` if a rate is `0`; show `"--"` / `"Tasa no disponible"`.

debounce_and_clear:
  typing: `inputValue` updates synchronously on `onChangeText`; `debouncedAmount` updates after `300ms` (`DEBOUNCE_MS`).
  card_tap: `handleCardPress` cancels pending debounce timer and computes via `convertAmount()` using immediate `inputValue`.
  clear_button: Visible in `CurrencyInput` whenever `value.length > 0`; tapping clears input and `debouncedAmount` to `''` for fast typing (boot default remains `'1'`).

textinput_clipping_fix:
  rule: Keep `TextInput` in `CurrencyInput.tsx` with explicit `height: 52`, `fontSize: 30`, `fontFamily: 'Poppins_700Bold'`, `paddingVertical: 0`, `textAlignVertical: 'center'`, `includeFontPadding: false`.
  why: Adding NativeWind `text-3xl` sets `lineHeight: 36`, which clips/shifts the `"0.00"` placeholder upward when empty.

number_parsing_bug_trap:
  rule: `CurrencyInput` stores standard dot-decimal strings (`"914.02"`), while `formatInputValue` adds comma thousands (`"1,000.50"`). `parseFormattedNumber()` must preserve single-`.` decimals (never strip all dots blindly like `.replace(/\./g, '')`, or `"914.02"` turns into `91402`).

dark_primary_colors:
  rule: `useThemeColors()` resolves `accent.primaryDark` / `accent.rgbDark` when `isDark` is true and bright `accent.primary` / `accent.rgb` in light mode. Keep text neutral using `text-text-primary` (not `text-primary`).

offline_and_cache:
  connectivity: Use `Boolean(state.isConnected) && state.isInternetReachable !== false` (`isInternetReachable` can initialize as `null`).
  query_mode: `QueryClient` uses `networkMode: 'offlineFirst'`, `refetchOnWindowFocus: false`, `retry: 1`. `useCurrencyRates` includes `useIsRestoring()` in `isLoading` so `EmptyState` never flashes during AsyncStorage hydration.
  fallback: `ratesApi.ts` checks `isNetworkOnline()` before fetching; if offline or on `429`/`5xx`/timeout, returns last saved `AsyncStorage` entry (`@ratesvenapp/api_cache:*`). `expireApiCache()` sets `cachedAt: 0` without deleting fallback data; `clearApiCache()` deletes cache keys while leaving Zustand theme/onboarding/shopping stores intact.

gesture_and_chart_gotchas:
  gesture_detector: Every `GestureDetector` wrapping a composite component or `View` MUST have a non-flattened `<View collapsable={false}>` direct child.
  pull_to_refresh: `PullToRefreshScrollView` requires `scrollY <= 1`, `activeOffsetY(48)`, `PULL_DEAD_ZONE = 200`, and `PULL_TRIGGER_DISTANCE = 380` to avoid accidental fetches.
  gifted_charts: `PriceChart` MUST set `pointerConfig.activatePointersOnLongPress: true` (otherwise `gifted-charts-core` forces `disableScroll = true`), set `maxValue` relative to `yAxisOffset` (`maxVal + padding - yAxisOffset`), and read tooltip values from original `data[pointerIndex].value`.
  history_intraday_keys: `YD_USD` has ~6 records/day. Keep full ISO `created_at` in `ChartDataPoint.date`, key `PriceHistoryList` items by `item.id`, and deduplicate X-axis day labels (`15 nov` once per day + `HH:mm` on `3d`/`7d` or blank on `30d`).

native_build_gotchas:
  gradle_clean: Never include `clean` in routine `build:apk:native`/`build:apk:arm64`/`build:aab:native` scripts because stale `.cxx/Debug` CMake files fail `:app:externalNativeBuildCleanDebug`. Use `pnpm android:clean` (`rm -rf android/app/.cxx android/app/build android/build && cd android && ./gradlew clean`) when a full clean is required.

fonts_and_hero_layout:
  poppins: `tailwind.config.js` resets `fontWeight` to `'normal'` and `src/global.css` maps `.font-medium`/`.font-bold`/etc. to `Poppins_*` files for Android compatibility.
  hero_safe_area: `index.tsx` uses `contentInsetAdjustmentBehavior="never"` on `PullToRefreshScrollView` so `RatesHero` sits flush behind the status bar using `useSafeAreaInsets().top`.
</invariants_and_gotchas>

<commands>
dev:
  `pnpm start` | `pnpm android` | `pnpm android:release` | `pnpm android:clean` | `pnpm ios` | `pnpm web`
validation:
  `pnpm typecheck` (`tsc --noEmit`) — run after every code edit
  note: `pnpm lint` (`expo lint`) currently prompts interactively (no ESLint config installed)
local_native_builds:
  `pnpm build:apk:native` (`arm64-v8a` release APK via `gradle.properties`, `NODE_ENV=production`, R8 + resource shrink + PNG crunch + bundle & `.so` compression)
  `pnpm build:apk:arm64` (explicit `arm64-v8a`-only release APK)
  `pnpm build:apk:universal` (universal release APK: `armeabi-v7a,arm64-v8a`)
  `pnpm build:aab:native` (local dual-ABI `armeabi-v7a,arm64-v8a` release AAB for Play Store)
eas_apk_builds:
  `pnpm build:apk` (`eas build --platform android --profile preview`)
  `pnpm build:apk:local` (uses local `.env`)
  `pnpm build:apk:prod` | `pnpm build:apk:prod:local` | `pnpm build:aab`
  note: `extra.eas.projectId` is set in `app.json`; remote EAS builds require `EXPO_PUBLIC_RATES_API_KEY` pushed to EAS env (`eas env:push`) since `.env` is gitignored.
</commands>
