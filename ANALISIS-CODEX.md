# Auditoría y plan de implementación

Fecha de auditoría: 2026-09-10. Alcance leído: `app.js`, `index.html`, configuración PWA, scripts de Supabase, Edge Function y prototipos. No se modificó código de la aplicación.

## Resumen ejecutivo

- **Causa raíz verificada en Chrome:** la CSP de `index.html:15` no incluye `blob:` en `img-src`. Por ello cada `img.src = URL.createObjectURL(blob)` de `crearCollageDesdeBlobs` es bloqueado, todas las imágenes terminan en `img.onerror`, `imgs` queda vacío y la función devuelve `null` (`app.js:1433-1449`). `shareClienteWhatsApp` silencia el fallo y ejecuta explícitamente el envío foto-por-foto (`app.js:1538-1546`). Es determinista con esta CSP, no una peculiaridad del celular.
- El respaldo `toDataURL -> fetch(data:)` también está verificado como bloqueado: `connect-src` no permite `data:` (`index.html:15`, `app.js:1508-1513`). El commit de respaldo no podía reparar el flujo con esta política.
- La misma omisión de `blob:` rompe las vistas previas de archivos: `renderFilePreview` crea object URLs y las asigna a `<img>` (`app.js:312-320`).
- El trabajo de red y canvas ocurre antes de `navigator.share`; en navegadores que consumen/caducan la activación del usuario, la llamada termina en `NotAllowedError` (`app.js:1534-1549`). Después, `window.open` también puede ser bloqueado como popup (`app.js:1559`).
- La solución móvil debe compartir exclusivamente un JPEG pequeño, generar el blob sin `fetch(data:)`, controlar memoria/dimensiones, probar capacidades con ese archivo real y ofrecer descarga/copiar texto como degradación. No debe volver a fotos individuales si el requisito es “un solo collage”.
- Para gráficos sin bundler conviene Chart.js 4 UMD, versión fijada. Mejor alojar el archivo minificado localmente para que la PWA funcione sin CDN; alternativamente CDN con SRI. Chart.js cubre líneas, barras y dona, es responsive, accesible mediante resumen textual y su peso es razonable para este panel.
- El puntaje debe medir conducta de cobranza, no premiar deuda creada. Se propone un score 0–100 calculado de forma determinista desde `movimientos`, acompañado de racha, meta semanal y ranking de prioridad de morosos.

## 1. Errores reales y riesgos comprobados

### P0 — seguridad e integridad de datos

1. **El panel “admin” no tiene control de acceso efectivo.** `getSupabase` fuerza rol anónimo (`app.js:35-43`) y las políticas permiten a `anon` seleccionar e insertar todos los movimientos (`supabase/movimientos.sql:20-23`) y actualizar/eliminar cualquier fila (`supabase/policies_update.sql:4-14`). Quien obtenga la URL y anon key puede leer clientes, montos y fotos, alterar saldos o borrar registros. El bucket también es público y permite cargas anónimas (`supabase/movimientos.sql:25-36`). Esto no es un secreto de clave: la anon key puede ser pública, pero RLS no debe conceder administración global.

2. **Las fotos quedan huérfanas y públicamente accesibles.** Al reemplazar fotos (`app.js:921-949`) o eliminar movimientos (`app.js:1049-1064`) nunca se borran objetos de Storage. Si una subida funciona y después falla el `insert`/`update` (`app.js:1684-1703`, `app.js:1750-1770`), también quedan objetos sin registro. Aumenta costo y conserva documentos/fotos que el usuario cree eliminados.

3. **El SQL versionado no representa el modelo que consume la app.** La tabla declarada solo incluye los campos hasta `created_at` (`supabase/movimientos.sql:7-17`), pero el código depende de `estado`, `origen` y `usuario_id` (`app.js:1269-1275`, `app.js:1297-1339`). Un despliegue desde estos scripts pierde la semántica de Stripe o falla al insertar/consultar integraciones. Falta una migración reproducible, no un `drop table` destructivo.

### P1 — collage y compartir por WhatsApp

4. **Causa raíz determinista: CSP bloquea todos los `blob:` usados para decodificar el collage.** La prueba en Chrome con exactamente la CSP de `index.html:15` devuelve “Loading the image blob:... violates ... `img-src`”. `crearCollageDesdeBlobs` asigna esas URLs a `img.src` (`app.js:1437-1445`), cada carga cae en `img.onerror`, `imgs` queda vacío y retorna `null` (`app.js:1447-1449`). Entonces `crearCollageDesdeBlobs(...).catch(() => null)` borra la causa (`app.js:1538`) y `app.js:1542-1546` convierte los blobs a múltiples `File`. Esa cadena exacta produce el síntoma uno-por-uno. Solución de defensa en profundidad: agregar `blob:` a `img-src` **y** dejar de depender de él para el collage.

5. **El fallback de exportación usa `fetch(dataUrl)` y está verificado como bloqueado por la CSP.** `canvasToJpegBlob` hace `fetch(dataUrl)` (`app.js:1508-1511`), mientras `connect-src` solo admite `self`, Supabase y jsDelivr (`index.html:15`). Chrome lo rechaza. En un WebView sin `toBlob`, o si `toBlob` devuelve `null`, la alternativa retorna `null` y activa el envío individual. Debe hacer `atob(dataUrl.split(',')[1]) -> Uint8Array -> Blob`, ruta ya verificada como funcional y que no necesita red.

6. **La descarga no comprueba estado HTTP ni MIME.** `descargarFotosBlobs` llama `blob()` aunque la respuesta sea 403/404/HTML (`app.js:1413-1425`). Un HTML con tamaño pasa el filtro, falla como imagen en `app.js:1433-1447`, y el fallo queda silenciado. Debe exigir `response.ok`, `Content-Type: image/*`, límite de bytes y timeout.

7. **CORS de Storage es un punto de fallo no diagnosticado.** Las imágenes se muestran con `<img>`, lo cual no prueba que `fetch(url)` tenga permiso CORS. `app.js:1417` necesita que el host de Supabase responda `Access-Control-Allow-Origin` para el origen de la PWA. El bucket público y la policy SELECT (`supabase/movimientos.sql:27-36`) autorizan acceso, pero no sustituyen CORS. Si alguna URL es de otro proyecto/dominio o redirección sin CORS, se descarta silenciosamente. No hay evidencia en el repo para afirmar que el host actual carece de CORS; sí hay un fallo real de observabilidad y validación.

8. **La CSP está atada a un único proyecto de Supabase aunque la URL es configurable.** `app.js:7` lee `SUPABASE_URL`, pero `connect-src` e `img-src` codifican `lijzftjgevwnjorpycxa.supabase.co` (`index.html:15,18`). Cambiar `config.js` a otro proyecto bloquea API, descarga y visualización de fotos.

9. **Se puede perder la activación transitoria del gesto.** Antes de `navigator.share`, el flujo espera N descargas, N decodificaciones y la exportación canvas (`app.js:1534-1549`). Algunos Safari/WebViews exigen que Web Share conserve activación de usuario; el retraso puede producir `NotAllowedError`. El fallback `window.open` ocurre todavía más tarde (`app.js:1559`) y puede ser bloqueado como popup.

10. **`navigator.canShare` se usa como puerta demasiado amplia y sin diagnóstico.** El bloque entero exige `navigator.share && navigator.canShare` (`app.js:1532`); se renuncia incluso a compartir texto nativamente si existe `share` pero no `canShare`. Solo se prueba `{files}` (`app.js:1548`) y después se envía `{text, files}`; lo correcto es probar el payload real (o al menos el archivo real) y distinguir soporte de archivos, error del target y cancelación. `canShare` no garantiza que WhatsApp acepte/respete todos los campos.

11. **WhatsApp descarta el `text` del payload con archivos en el entorno verificado.** `navigator.share({text, files})` (`app.js:1549`) no garantiza caption porque el share target decide qué campos consume. El collage debe ser autosuficiente: dibujar dentro del JPEG un encabezado con marca, cliente, deuda/saldo, fecha de corte y, si cabe, indicación de pago. Como ayudas secundarias, copiar el texto antes de compartir y ofrecer “Abrir WhatsApp con mensaje”; ninguna debe ser la única forma de comunicar el adeudo.

12. **El pipeline carga y decodifica hasta 12 originales simultáneamente.** `Promise.all` descarga todo (`app.js:1414-1424`) y otro `Promise.all` decodifica todo (`app.js:1433-1447`). Aunque el canvas actual de 12 fotos es solo ~1632×1232 (`app.js:1451-1458`) y no suele exceder el límite de dimensiones de iOS, los bitmaps originales pueden ocupar decenas/cientos de MB. Safari puede matar la pestaña o devolver `null` al exportar. El problema principal no es el canvas final sino el pico de memoria. No hay límites por bytes, megapíxeles ni timeout.

13. **Canvas/contexto y limpieza no son seguros ante excepción.** No se valida `canvas.getContext('2d')` antes de usarlo (`app.js:1459-1461`). Los object URLs se revocan solo después de dibujar (`app.js:1484`); si `drawImage`, asignación del canvas o exportación falla, quedan vivos. Debe usarse `try/finally`, liberar cada bitmap/URL pronto y reducir `canvas.width/height` al terminar.

14. **La ausencia de `canvas.toBlob` está contemplada, pero su reemplazo no es robusto.** `toBlob` ausente o `null` (`app.js:1494-1506`) es posible en WebViews antiguos o bajo presión de memoria. `toDataURL` duplica/expande la imagen en memoria y luego `fetch(data:)` agrega otra copia (`app.js:1508-1511`). Conviene un conversor base64 directo como último recurso y dimensiones/calidad adaptativas.

15. **“Canvas tainted” no es la causa raíz observada.** El fallo ocurre antes de dibujar: CSP bloquea `img.src=blob:`. Además, `createImageBitmap(blob)` fue verificado como funcional y no pasa por `img-src`; debe ser la ruta principal. El fallback compatible es `FileReader.readAsDataURL(blob)` + `img.src=data:` (también verificado y permitido por la CSP). Si en el futuro se dibujan URLs remotas directas sin CORS, `toBlob/toDataURL` sí puede lanzar `SecurityError`; debe registrarse con su etapa exacta.

16. **Las vistas previas están rotas por la misma CSP.** `renderFilePreview` crea `blob:` en `app.js:315` y lo usa como `img src` en `app.js:319`; Chrome lo bloquea porque `img-src` carece de `blob:`. Agregar `blob:` a `img-src` repara las previews inmediatamente. Como alternativa independiente de CSP, podría usarse `FileReader` + `data:`, aunque para previews es razonable conservar object URLs una vez corregida la política.

17. **Selección de fotos inconsistente y truncado poco útil.** `getFotosPedidosCliente` incluye `url_foto` y arrays de pedidos y pagos (`app.js:1399-1409`), aunque el nombre dice “FotosPedidos”. Toma las primeras 12 del ciclo ordenado ascendente, por lo que omite las más recientes cuando hay más. Tampoco deduplica `url_foto` migrado a `array_urls_fotos`.

18. **No hay fallback útil si no se puede compartir el archivo.** Si descarga/collage/`canShare` falla, solo abre texto (`app.js:1553-1559`); el collage generado no se ofrece para descargar, guardar o copiar. Si `window.open` es bloqueado, no hay mensaje visible de recuperación.

### P1 — cálculos que muestran datos incorrectos

18. **El ciclo se ordena por alta técnica, no por fecha efectiva.** `getMovimientosCicloActual` ordena por `created_at` (`app.js:1367-1370`), aunque pagos se capturan y editan con `fecha`/`hora` (`app.js:917-920`, `app.js:1729-1768`). Un pago atrasado cargado hoy se aplica después de pedidos posteriores, cerrando el ciclo equivocado y compartiendo fotos incorrectas. Debe existir una única `getMovimientoDateTime` con desempate estable por `created_at/id`.

19. **El historial también contradice la fecha mostrada.** `groupByCliente` ordena movimientos por `created_at` (`app.js:1283-1285`), pero la UI imprime `fecha` (`app.js:1341-1343`). Un registro editado o retroactivo aparece fuera de orden.

20. **El filtro por fecha recalcula saldos con solo los movimientos filtrados.** Primero filtra por fecha y luego agrupa para decidir “deudor/al día” (`app.js:1231-1243`). Así un pago aislado ese día convierte al cliente en “al día/a favor” aunque mantenga deuda histórica, o un pedido de ese día lo marca deudor aunque ya pagó después. El filtro de saldo debe usar balances globales y el filtro de fecha solo decidir qué movimientos mostrar.

21. **Los totales semanales omiten ventas online pagadas.** `groupByCliente` excluye pedidos con `estado === 'pagado'` de `totalPedido` (`app.js:1269-1275`). Esa función se reutiliza para `totalMonto` de la semana (`app.js:2103-2114`) y para cada tarjeta (`app.js:2287-2289`); por tanto “Total semana” no es total vendido. Deben separarse `totalVentas` y `totalCobrable/deuda`.

22. **El contador “Online” mezcla unidades.** `Todos/Deudores/Al día` cuentan clientes, pero `count-online` cuenta movimientos (`app.js:1957-1970`). El chip muestra un número incomparable y puede contar varias veces al mismo cliente.

23. **La igualdad de clientes no es consistente.** La agrupación elimina acentos y compacta espacios (`app.js:502-509`, `app.js:1252-1257`), mientras asociados/deudores se cruzan solo con `trim().toLowerCase()` (`app.js:1972-1975`). “José Pérez” y “Jose Perez” se agrupan en movimientos pero no coinciden en asociados.

24. **Nombres vacíos/malformados pueden romper procesamiento.** Datos remotos se usan como `m.cliente.trim()` sin validar (`app.js:523`, `app.js:1256`). La base declara `not null`, pero acepta cadena vacía; una fila heredada o integración defectuosa aborta renders completos.

### P2 — UI, PWA y mantenibilidad

25. **Hay inyección HTML posible por iniciales.** El nombre completo suele escaparse, pero `getInitials(group.cliente)` se inserta sin `escapeHtml` (`app.js:1600`, `app.js:2280`, `app.js:2335`). Un nombre cuyo primer carácter contenga marcado puede inyectar HTML. Debe usarse `textContent` o escapar toda interpolación.

26. **HTML inválido por botones anidados.** La cabecera de semana es un `<button>` (`app.js:2349`) que contiene otro `<button>` para compartir (`app.js:2355-2358`). Los navegadores reparan el DOM de manera distinta; clic, foco y accesibilidad pueden fallar. Deben ser elementos hermanos.

27. **La edición puede ejecutar dos estados de carga sobre el mismo botón.** `initModal` activa/desactiva loading alrededor de `modalSaveHandler` (`app.js:786-797`) y el handler de renombrado vuelve a hacerlo internamente (`app.js:738-755`). No es fatal, pero puede restaurar HTML equivocado y complica errores.

28. **Carga inicial innecesariamente repetida y sin paginación.** `fetchMovimientos` trae `select('*')` de toda la historia y después espera otra consulta `select('*')` de todos los perfiles (`app.js:47-58`, `app.js:1638-1648`). Cada alta/edición/borrado vuelve a descargar y renderizar todo, ejecutando múltiples agrupaciones completas. Con años de datos degradará red, memoria y tiempo de interacción.

29. **Agrupación potencialmente cuadrática y con mutación.** Para cada movimiento, `groupByCliente` llama `getCanonicalClienteNombre`, que reconstruye/busca la lista global (`app.js:522-532`, `app.js:1255-1257`); además ordena `group.movimientos` en sitio (`app.js:1283`). La función se invoca muchas veces por render. Hay que normalizar una vez y construir mapas derivados una vez por actualización.

30. **Subidas secuenciales aumentan espera y posibilidad de estado parcial.** Los bucles comprimen/suben cada archivo uno tras otro (`app.js:926-946`, `app.js:1686-1691`, `app.js:1752-1757`). Una concurrencia limitada (2) reduce tiempo sin disparar memoria; si falla, debe limpiar lo ya subido.

31. **Dependencias críticas por CDN debilitan la PWA.** Tailwind runtime, fuentes, iconos, Supabase e `imageCompression` vienen de CDN (`index.html:13-20` y scripts del head). El service worker solo precachea archivos locales (`sw.js:1-4`) y ni siquiera `tailwind.config.js`, `config.js` o dependencias. Una recarga offline puede quedar sin estilo o funcionalidad. Además la estrategia cache-first-while-update sirve indefinidamente contenido viejo hasta la siguiente navegación (`sw.js:22-39`).

32. **`config.js` puede quedar cacheado por el service worker.** Aunque no está en `APP_SHELL`, toda petición GET same-origin entra al cache runtime (`sw.js:22-37`). Rotar proyecto/clave/configuración puede conservar una versión anterior. Debe ser network-only o no-store.

33. **No hay pruebas automatizadas ni comandos de calidad.** `package.json` solo contiene `build`; no hay lint, test unitario o test de navegador. Los cálculos de ciclos, semanas, score, canvas y degradación Web Share requieren pruebas deterministas.

## 2. Mejoras concretas de calidad, rendimiento y estructura

### Separación propuesta sin introducir bundler

Mantener scripts clásicos/`defer` o migrar a módulos nativos (`type="module"`), pero dividir responsabilidades:

- `js/data/supabase.js`: cliente, repositorios de movimientos/perfiles/asociados y Storage.
- `js/domain/movimientos.js`: fecha efectiva, normalización, balances, ciclos, métricas semanales.
- `js/domain/gamificacion.js`: score, rachas, metas y ranking; funciones puras.
- `js/share/collage.js`: descarga validada, decodificación, layout, exportación y limpieza.
- `js/share/whatsapp.js`: preparación, Web Share y degradaciones.
- `js/ui/charts.js`: instancias Chart.js, actualización y destrucción.
- `js/ui/render.js` y `js/main.js`: render/eventos/orquestación.

Si se evita dividir de inmediato, crear esas mismas secciones como objetos/módulos internos y extraerlas después. No mezclar nuevamente reglas de deuda con plantillas HTML.

### Modelo derivado único

Después de cada fetch, ejecutar una vez `buildDashboardModel(movimientosData)` y conservar:

- `movimientosValidos`, normalizados con `clienteKey`, `amountCents` y `effectiveAt`.
- `clientesByKey`, con `totalVentas`, `totalCobrable`, `totalPagado`, `saldo`, ciclos y última actividad.
- `seriesByWeek`, métricas globales y ranking.

Esto elimina agrupaciones repetidas, evita errores de unidades y permite que charts, cards, score y WhatsApp consuman exactamente la misma verdad. Usar centavos enteros para sumar dinero y tolerancia únicamente al convertir datos históricos.

### Datos y red

- Seleccionar columnas explícitas y paginar; traer perfiles solo para `usuario_id` presentes. Paralelizar consultas independientes con `Promise.allSettled`.
- Aplicar actualización optimista/reemplazo de una fila tras CRUD; reservar refetch total para reconciliación.
- Limitar concurrencia de imágenes a 2, validar `file.type`, megapíxeles y tamaño antes de comprimir/subir.
- Generar rutas Storage por `movimientoId/uuid.ext`, guardar path además de URL y borrar por path con operación compensatoria.
- Añadir migraciones incrementales, índices en `(cliente, fecha)`, `created_at`, `tipo`, `estado`, `origen`, y una vista/RPC agregada cuando el volumen lo justifique.
- Proteger panel y Storage con Supabase Auth, claim/tabla de roles y RLS `authenticated`; URLs firmadas si las fotos no deben ser públicas.

### UI y calidad

- Reemplazar `innerHTML` con `textContent` para datos; cuando se usen plantillas, escapar atributos y texto con utilidades distintas.
- Corregir botones anidados, foco del modal, Escape, `aria-expanded`, labels y regiones descriptivas para charts.
- Mostrar estados “Preparando collage 3/8”, errores accionables y botones “Reintentar / Descargar collage / Copiar mensaje”.
- Añadir ESLint/Prettier, Vitest o pruebas puras en navegador y Playwright para flujos móvil/Web Share simulado.
- Fijar versiones y alojar dependencias críticas localmente; actualizar `sw.js` con cache versionado por build y política explícita por recurso.

## 3. Plan de implementación por fases

### Fase 0 — asegurar datos y fijar contratos

**Archivos:** nuevos `supabase/migrations/*.sql`, `app.js` (temporalmente `getSupabase`, repositorios), `config.example.js`.

1. Crear migración no destructiva que documente/agregue `estado`, `origen`, `usuario_id` y paths de Storage; índices y restricciones (`cliente <> ''`, montos válidos).
2. Implementar autenticación admin y políticas RLS por rol. Retirar CRUD de `anon`; proteger `perfiles`, `asociados`, movimientos y objetos.
3. Definir contrato de movimiento y fecha efectiva: `fecha + hora`, con fallback a hora de `created_at`, y desempate `created_at/id`.
4. Respaldar y probar datos antes de cambiar políticas. Esta fase bloquea una publicación responsable, aunque el collage puede desarrollarse en paralelo localmente.

**Criterio:** una sesión no admin no puede listar/modificar movimientos ni obtener fotos; migrar no borra tablas.

### Fase 1 — collage móvil robusto

**Archivos:** `app.js` (`getMovimientosCicloActual`, `getFotosPedidosCliente`, `descargarFotosBlobs`, `crearCollageDesdeBlobs`, `canvasToJpegBlob`, `shareClienteWhatsApp`), idealmente extraídos a `js/share/collage.js` y `js/share/whatsapp.js`; `index.html` (estado/modal de compartir y CSP); `sw.js` si se agregan módulos.

1. **Corregir CSP primero:** en `index.html:15`, cambiar `img-src 'self' data: ...` a `img-src 'self' data: blob: ...`. Esto repara inmediatamente tanto el decodificador actual como `renderFilePreview` (`app.js:315-320`). Mantener `data:` para el fallback. No agregar `data:` a `connect-src`: se eliminará la operación de red equivocada.
2. Corregir ciclo con `getMovimientoDateTime`; elegir fotos de pedidos del ciclo según requisito, deduplicar URL, ordenar más recientes y fijar máximo adaptativo (p. ej. 9).
3. Reemplazar `descargarFotosBlobs` por `fetchImageBlob(url, {signal,maxBytes})`: timeout con `AbortController`, `response.ok`, MIME, tamaño, resultado por URL y errores visibles. Verificar CORS del dominio real de Storage mediante una prueba desde el origen publicado.
4. Procesar de forma secuencial o concurrencia 2. Decodificar primero con `createImageBitmap(blob, {imageOrientation:'from-image'})`, ruta verificada en Chrome y ajena a `img-src`; usar resizing durante decode si está soportado. Fallback obligatorio: `FileReader.readAsDataURL(blob)` y `img.src = dataUrl`, también verificado y permitido por `img-src data:`. No usar `img.src=blob:` dentro del generador, aunque `blob:` quede habilitado para previews y compatibilidad.
5. Calcular layout acotado: ancho objetivo 1080 px, lado de celda derivado, máximo 3 columnas, límite conservador de área (p. ej. 4 MP) y JPEG 0.72–0.80. Reservar arriba una cabecera legible con fondo sólido: `Betterorden`, nombre del cliente, `Debe: $X` o estado al día, y “Corte: fecha/hora”. Así el mensaje sobrevive aunque WhatsApp descarte `text`. No incluir teléfonos u otros datos innecesarios.
6. Si exporta `null`, reducir a 720 px/calidad 0.68 y reintentar una vez. Reescribir `canvasToJpegBlob`: `toBlob`; fallback `toDataURL` + `atob(dataUrl.split(',')[1])`, copiar a `Uint8Array` y construir `new Blob([bytes], {type:'image/jpeg'})`. Nunca `fetch(data:)`. Capturar `SecurityError`, `null`, falta de contexto y liberar bitmaps/object URLs/canvas en `finally`.
7. Preparar el collage al abrir una hoja/modal “Compartir” (o cachearlo por hash de URLs+saldo+fecha de corte) para que el toque final a “Compartir collage” invoque `navigator.share` inmediatamente. Probar `navigator.canShare({files:[collage]})` con el archivo final.
8. Compartir **solo** `[collage]`; eliminar el fallback de múltiples fotos. El texto es complementario: copiarlo al portapapeles con aviso “Mensaje copiado; pégalo si deseas”, pero la deuda esencial ya estará dibujada. Si archivos no son soportados, ofrecer `Descargar collage` y `Abrir WhatsApp con texto` como botones explícitos. No disparar `window.open` tardío sin gesto.
9. **Eliminar el catch silencioso:** sustituir `crearCollageDesdeBlobs(blobs).catch(() => null)` por manejo tipado por etapa. Registrar con `console.error` el error y mostrar aviso accionable al usuario; nunca degradar silenciosamente a fotos individuales. Eventos mínimos sin datos personales: `download_failed`, `decode_failed`, `canvas_export_failed`, `share_unsupported`, `share_rejected`.

**Pruebas:** conservar como regresión automatizada los resultados A–G ya verificados: CSP permite preview `blob:`, el collage usa `createImageBitmap`, fallback `FileReader+data:`, export fallback `atob`, `toBlob` y `canShare` positivos. Completar en Android Chrome + WhatsApp, iPhone Safari y PWA instalada, WebView objetivo; 1/2/4/9 fotos, fotos HEIC si se aceptan, 20 MP, 404, MIME HTML, CORS fallido, offline, `toBlob` ausente/null, `canShare` falso y cancelación. Resultado obligatorio: nunca más de un archivo entregado al share target y deuda visible dentro del JPEG.

### Fase 2 — núcleo correcto de métricas

**Archivos:** `app.js` (`groupByCliente`, `getFilteredMovimientos`, funciones semanales, `fetchMovimientos`) o nuevos `js/domain/movimientos.js`, `js/domain/analytics.js`; pruebas `tests/movimientos.test.js`.

1. Crear funciones puras `normalizeMovimiento`, `getMovimientoDateTime`, `buildClientLedger`, `buildCycles`, `aggregateByWeek` y `buildDashboardModel`.
2. Separar conceptos: `totalVentas` incluye todo pedido; `totalCobrable` excluye Stripe ya pagado; `totalPagadoManual`; `saldo = cobrable - pagos`, conservando saldo a favor.
3. Hacer que filtros de nombre/fecha seleccionen filas, pero que estado de deuda provenga del ledger global.
4. Probar pagos retroactivos, mismo día/hora, sobrepago, pedido online, nombres con acentos, monto decimal, ciclos abiertos/cerrados y cambio de semana viernes–jueves.

**Criterio:** todas las vistas, WhatsApp, charts y score usan el mismo modelo y los totales cuadran con fixtures conocidos.

### Fase 3 — gráficos reales

**Librería:** Chart.js 4 UMD. Funciona con `<script defer>` sin npm/bundler, tiene API sencilla para actualizar datasets, diseño responsive y cubre los gráficos requeridos. Fijar una versión 4.x exacta. Recomendación PWA: guardar `vendor/chart.umd.min.js`; si se usa `cdn.jsdelivr.net`, añadir SRI/crossorigin, conservar CSP y aceptar que no habrá primera carga offline.

**Archivos:** `index.html` (script y contenedores `<canvas>` + resúmenes accesibles), `app.js` (`renderDashboard` y llamada tras `fetchMovimientos`) o nuevo `js/ui/charts.js`; `sw.js` (precache del vendor/módulo).

1. Añadir `initCharts`, `updateCharts(model)` y `destroyCharts`; conservar una instancia por canvas para no filtrar memoria.
2. Gráfico de línea/área: deuda total al cierre de cada semana durante 8–12 semanas, junto con pagos semanales.
3. Barras: cobrado vs pedidos cobrables por semana. No mezclar ventas online ya pagadas con cobranza manual.
4. Dona: cartera actual `deuda / al día / saldo a favor`, con valores monetarios y número de clientes.
5. Barras horizontales: top 5 morosos por saldo, coloreadas por antigüedad. El ranking completo queda en fase 4.
6. Actualizar solo al cambiar `movimientosData`; no recalcular durante cada filtro. Desactivar animación con `prefers-reduced-motion`, limitar `devicePixelRatio` en móvil y añadir tabla/resumen textual.

**Criterio:** resize/rotación sin overflow, cero errores con datos vacíos, mismos números que cards y buena interacción en un móvil de gama media.

### Fase 4 — score, rachas, ranking y metas

**Archivos:** nuevo `js/domain/gamificacion.js` (o sección pura en `app.js`), `app.js` (`renderDashboard`/nuevo `renderGamificacion`), `index.html` (tarjetas, meta, ranking), opcional migración `supabase/migrations/*_collection_goals.sql` para metas multi-dispositivo; pruebas `tests/gamificacion.test.js`.

#### Score de cobranza propuesto (0–100)

Ventana móvil de 28 días, usando únicamente pedidos cobrables, pagos, fechas y ciclos ya disponibles:

`score = round(40*T + 25*V + 20*A + 15*R)`

- **Tasa de cobranza `T` (40 pts):** `min(1, pagosAplicados28 / deudaExigible28)`. `deudaExigible28` es saldo inicial de cartera abierta al comenzar la ventana + pedidos cobrables de la ventana; nunca incluye pedidos online `pagado`. Si el denominador es 0, `T=1` solo si no hay cartera vencida; así no se premia crear más pedidos.
- **Velocidad `V` (25 pts):** promedio, ponderado por monto, de `max(0, 1 - diasParaCerrar/28)` para ciclos cerrados en la ventana. Si no hubo ciclos cerrables, usar valor neutral 0.5; no inventar 100%.
- **Antigüedad sana `A` (20 pts):** sobre cartera abierta, `1 - min(1, promedioPonderadoDias/42)`. Si no hay deuda, `A=1`. Penaliza montos viejos más que cuentas pequeñas recientes.
- **Racha `R` (15 pts):** `min(1, semanasConsecutivasCumpliendo/4)`. Una semana cumple si `pagosSemana >= metaSemana`; sin meta configurada, cumple si redujo cartera abierta y registró al menos un pago. Las semanas siguen el ciclo viernes–jueves existente.

Mostrar desglose, no solo el número: “Tasa 31/40, velocidad 18/25…”. Niveles: 0–39 `En arranque`, 40–59 `Constante`, 60–79 `Cobrador fuerte`, 80–100 `Imparable`. No restar puntos manualmente ni ocultar saldos; el score debe ser auditable desde movimientos.

#### Meta semanal

- Primera versión local: meta monetaria en `localStorage`, con clave versionada, avance `pagos de la semana / meta` y celebración una sola vez al cruzar 100%.
- Versión recomendada: tabla `collection_goals(id, owner_id, week_start, target_cents, created_at)` con RLS admin para sincronizar dispositivos y conservar historial.
- Acciones: sugerir meta desde la mediana de cobro de las últimas 4 semanas; permitir editarla; nunca modificar movimientos para “cumplir”.

#### Racha

Calcular semanas consecutivas hacia atrás desde la actual (o última cerrada para no romper la racha a mitad de semana). Mostrar racha actual, récord en el historial disponible y cuánto falta esta semana. La racha es derivada; no guardar un contador que pueda desincronizarse.

#### Ranking de clientes morosos

No confundirlo con el score del cobrador. Calcular una **prioridad 0–100** por cliente con deuda:

`prioridad = round(50*saldo/maxSaldo + 35*min(1,diasDeuda/42) + 15*min(1,diasSinPago/28))`

Ordenar descendente y mostrar saldo, días desde el primer pedido impago, último pago y acción “Compartir cobro”. Esto incentiva actuar sobre impacto + antigüedad; mantener también orden alterno por monto/antigüedad para transparencia.

#### Eventos de gamificación

- Celebración discreta al registrar pago, cerrar ciclo, lograr meta o extender racha; sin confeti continuo ni castigos que incentiven registros falsos.
- Registrar solo logros derivados. Si más adelante se quiere historial persistente, guardar `achievement_type + period + source hash`, con restricción única para evitar duplicados.

**Criterio:** fixtures manuales permiten recalcular exactamente score/ranking; editar o borrar un movimiento actualiza todo; pedidos online no inflan cobranza; no hay división por cero ni ventajas por generar deuda.

### Fase 5 — rendimiento, PWA y despliegue

**Archivos:** módulos JS resultantes, `index.html`, `sw.js`, `package.json` y pruebas.

1. Alojar Chart.js y, si es viable, Tailwind CSS compilado, Supabase e image-compression localmente; precachear artefactos con hash/version.
2. Aplicar network-only/no-store a `config.js`, network-first a HTML y cache-first a assets versionados. Añadir pantalla/control de actualización.
3. Paginar historial y usar agregados para dashboard. Medir tamaño JS, LCP, tiempo de render con 1k/10k movimientos y memoria del collage.
4. Añadir CI: syntax/lint, pruebas domain, pruebas de render y Playwright móvil. Publicar primero a preview y validar CORS/Web Share en HTTPS real.

## Orden recomendado de entrega

1. Seguridad/RLS y contrato de datos.
2. Collage de archivo único con degradación explícita.
3. Ledger/métricas comunes y corrección de totales.
4. Charts.
5. Score, ranking, racha y metas.
6. Modularización final, PWA offline y paginación.

No conviene implementar charts o gamificación directamente sobre `groupByCliente` actual: perpetuaría los errores de fecha, saldo filtrado y total semanal.
