# Segunda opinión (Claude) sobre ANALISIS-CODEX.md

Revisé el análisis de Codex contra el código y contra pruebas en Chrome real.
**Veredicto: el diagnóstico técnico es correcto y la Fase 1 es implementable tal cual.
El orden de entrega propuesto NO lo es.** Abajo van las 6 correcciones que AGY debe
aplicar sobre el plan de Codex.

## Evidencia que aporté (ya integrada por Codex, no re-investigar)

Monté una página con exactamente la CSP de `index.html:15` y corrí tests en Chrome:

| Test | Resultado |
|---|---|
| `img.src = URL.createObjectURL(blob)` | **BLOQUEADO** por `img-src` (falta `blob:`) |
| `fetch(canvas.toDataURL(...))` | **BLOQUEADO** por `connect-src` (falta `data:`) |
| `createImageBitmap(blob)` | OK |
| `atob(dataUrl.split(',')[1])` -> `Uint8Array` -> `Blob` | OK |
| `FileReader.readAsDataURL` -> `img.src = data:` | OK |
| `canvas.toBlob` | OK |
| `navigator.canShare({files:[File]})` | true |

**Confirmación adicional por el propio síntoma:** que hoy SÍ lleguen las fotos una por
una prueba que `descargarFotosBlobs` funciona (`files = blobs.map(...)` solo se ejecuta
si `blobs.length` es verdadero). Es decir **CORS de Supabase Storage NO es el problema**
y el fallo está aguas abajo, en la decodificación. Esto degrada el hallazgo #7 de Codex
(CORS) de "riesgo activo" a "validación defensiva deseable". AGY: no gastes tiempo
investigando CORS.

## Corrección 1 (la más importante): NO empezar por la Fase 0

Codex pone Auth + rehacer RLS como Fase 0 bloqueante. El hallazgo es **real y grave**
(cualquiera con la URL y la anon key puede leer, alterar y borrar toda la cobranza,
`supabase/movimientos.sql:20-23` + `supabase/policies_update.sql:4-14`), pero convertirlo
en prerequisito transforma "quiero charts y arreglar WhatsApp" en una migración de
autenticación. Eso no es decisión del implementador.

**Orden que AGY debe seguir:**

1. Fix del collage (Fase 1 de Codex, tal cual — está bien)
2. Solo los 3 bugs de cálculo que corrompen lo que charts/score van a mostrar
3. Charts
4. Score / racha / ranking / meta

La seguridad RLS queda como **pista separada, pendiente de decisión del dueño**. Anotarla,
no ejecutarla en esta tanda.

## Corrección 2: recortar la Fase 2

Codex propone partir `app.js` en 7 módulos (`js/data/`, `js/domain/`, `js/share/`,
`js/ui/`), migrar dinero a centavos enteros, `buildDashboardModel`, ESLint, Prettier,
Vitest, Playwright, CI, paginación y vendorizar Tailwind/Supabase. Es un rewrite, y no
es lo que se pidió.

**AGY: mantener `app.js`.** Agregar las funciones puras ahí mismo (o en un único
`js/domain.js` si crece demasiado). De la Fase 2 implementar **solo** estos 3, porque son
los que meterían números falsos en los charts y en el score:

- **#18** `getMovimientosCicloActual` (`app.js:1367-1370`) ordena por `created_at` en vez
  de la fecha efectiva (`fecha` + `hora`). Un pago retroactivo cierra el ciclo equivocado.
  Crear `getMovimientoDateTime(mov)` con desempate por `created_at`/`id` y usarla también
  en `groupByCliente` (`app.js:1283-1285`), que hoy ordena por `created_at` mientras la UI
  imprime `fecha` (`app.js:1341-1343`).
- **#20** `getFilteredMovimientos` (`app.js:1231-1243`) decide "deudor / al día" agrupando
  **solo lo filtrado**. Con un filtro de fecha, un pago aislado marca al cliente "al día"
  aunque arrastre deuda. El estado de deuda debe venir del balance global; la fecha solo
  elige qué filas se muestran.
- **#21** `groupByCliente` excluye pedidos `estado === 'pagado'` de `totalPedido`
  (`app.js:1269-1275`), y esa misma función alimenta el "Total semana"
  (`app.js:2103-2114`, `app.js:2287-2289`). O sea el total semanal **no es lo vendido**.
  Separar `totalVentas` (todo pedido) de `totalCobrable` (excluye Stripe pagado).

El resto de la Fase 2 y la Fase 5 completa: **no en esta tanda.**

## Corrección 3: bug de normalización en el ranking de morosos

La fórmula de Codex usa `50*saldo/maxSaldo`. Es normalización **relativa**, así que:

- el peor moroso siempre saca exactamente 50/50, sin importar si debe $500 o $50,000
- cuando el moroso más grande paga, **la prioridad de todos los demás sube sola**, sin
  que haya cambiado nada de ellos

Eso rompe la comparabilidad semana a semana, que es justo lo que un sistema de puntaje
necesita. **Anclar a una referencia fija:** `min(1, saldo / DEUDA_ALTA_REF)` con
`DEUDA_ALTA_REF` configurable (arrancar sugiriendo el percentil 90 histórico o un monto
redondo que el dueño reconozca). Igual para `diasDeuda/42` y `diasSinPago/28`, que ya
están anclados y por eso sí están bien.

## Corrección 4: el score necesita una acción, no solo un número

El desglose que propone Codex ("Tasa 31/40, velocidad 18/25...") es correcto y hay que
hacerlo. Pero un número no "incita a cobrar". Agregar **una sola línea de siguiente
acción**, derivada del componente más débil, ej.:

- `T` bajo -> "Cobra $X esta semana para llegar a tu meta"
- `A` bajo -> "La deuda de {cliente} lleva {n} días. Es la más vieja."
- `R` a punto de romperse -> "Te faltan $X para no romper tu racha de {n} semanas"

Eso es lo que convierte el puntaje en presión de cobro. Es lo que pidió el dueño.

Lo demás del diseño de score de Codex es bueno y **anti-gaming**, respetarlo:
no premiar deuda creada, `V=0.5` neutral cuando no hubo ciclos cerrables, racha derivada
(nunca un contador guardado que se desincroniza), y nada de restar puntos a mano.

## Corrección 5: gotcha del service worker que Codex no menciona

Si se vendoriza Chart.js en `vendor/chart.umd.min.js`, agregarlo a `APP_SHELL` en `sw.js`
**no basta**: hay que **subir `CACHE_NAME` de `bettermancera-v3` a `v4`**
(`sw.js:1`), porque el `install` solo hace `addAll` sobre un cache nuevo. Sin el bump, los
dispositivos con el SW ya instalado nunca precachean el vendor.

De paso: `tailwind.config.js` y `config.js` tampoco están en `APP_SHELL` (hallazgo #31/#32
de Codex). `config.js` **no debe** quedar en cache — rotar proyecto o llave dejaría la
vieja sirviéndose. Mínimo: excluirlo explícitamente del `fetch` handler de `sw.js`.

Confirmado: la CSP ya permite `cdn.jsdelivr.net` en `script-src`, así que Chart.js 4 UMD
carga por CDN sin tocar la política. Vendorizar es mejor (offline), pero no es bloqueante.

## Corrección 6: el collage debe llevar la deuda dibujada dentro

Codex ya lo corrigió tras mi observación, lo repito porque es el punto que decide si el
feature sirve: **WhatsApp puede descartar el `text` cuando `navigator.share` lleva
`files`**. Si el mensaje de cobro vive solo en `text`, el cliente recibe una imagen sin
contexto. La cabecera dentro del JPEG (marca, cliente, `Debe: $X`, fecha de corte) es
obligatoria, no opcional. Copiar al portapapeles es ayuda secundaria.

## Cosas baratas que sí vale la pena meter de paso

- **#25 XSS real:** `getInitials(group.cliente)` se interpola sin `escapeHtml`
  (`app.js:1600`, `app.js:2280`, `app.js:2335`). Los nombres vienen de la base.
- **#26 HTML inválido:** `<button>` dentro de `<button>` (`app.js:2349` contiene
  `app.js:2355-2358`). Rompe clic/foco de forma distinta en cada navegador. Hacerlos
  hermanos.
- **#22:** los chips `Todos/Deudores/Al día` cuentan clientes pero `count-online` cuenta
  movimientos (`app.js:1957-1970`). El número no es comparable.
- **#9 activación del gesto:** preparar el collage al abrir la hoja de "Compartir" y que
  el toque final solo llame `navigator.share`. Es lo que evita `NotAllowedError` en
  iOS/Safari, y ya está en la Fase 1 de Codex.

## Resumen para AGY

Implementa **Fase 1 de Codex completa**, los **3 bugs de cálculo** (#18, #20, #21), luego
**charts**, luego **score/racha/ranking/meta** con mis correcciones 3 y 4.
**No** hagas Fase 0 (RLS/Auth), **no** partas `app.js` en módulos, **no** metas
CI/lint/tests/paginación/vendorizado de Tailwind. Trabaja en una rama, no en `main`.
