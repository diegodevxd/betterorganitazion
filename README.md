# Panel de Ventas, Crédito y Cobranza (PWA)

Panel administrativo tipo PWA (*Progressive Web App*) para gestionar pedidos, pagos, cuentas por cobrar por cliente (ventas a crédito / fiado) y métricas semanales de cobranza.

## Características técnicas

- **Autenticación y control de acceso:** Inicio de sesión con Supabase Auth y validación por rol mediante la función `es_admin()` en PostgreSQL con políticas de *Row Level Security* (RLS), usando un `storageKey` dedicado (`bm-admin-auth`) para aislar sesiones administrativas.
- **Gestión de ciclos de deuda:** Agrupación cronológica por fecha y hora efectiva de cada movimiento para calcular saldos vigentes por ciclo, historial de abonos y conciliación de pagos en línea.
- **Analítica y gamificación de cobranza:** Gráficos interactivos con Chart.js (evolución semanal de ventas vs. cobranza, desglose por cliente) y motor de puntaje de cobranza (`0–100`) con meta semanal, racha activa y ranking priorizado de cuentas vencidas.
- **Collage de comprobantes para WhatsApp:** Generador de tarjetas resumen en HTML5 Canvas (`image/jpeg`) que combina cabecera de saldo y miniaturas de pedidos/comprobantes para enviarlo mediante la Web Share API nativa en móviles.
- **Funciona sin internet:**
  - El Service Worker (`sw.js`) guarda la app completa, y todas las librerías y tipografías están en `vendor/` (no se usa ningún CDN).
  - `offline.js` guarda en IndexedDB la última copia de los datos y una bandeja de salida: los pedidos, pagos y asociados registrados sin señal (con sus fotos) se envían solos al volver el internet.
  - Editar, borrar o renombrar sí requiere conexión.
- **Letra grande / accesibilidad:** todo el panel usa `rem`. El botón **A+** del encabezado y el menú lateral cambian entre Normal (16 px), Grande (19 px, por defecto) y Enorme (22 px). Se puede hacer zoom con los dedos.

## Stack

- **Frontend:** HTML5, Tailwind CSS, JavaScript vanilla, Chart.js 4
- **Backend / BaaS:** Supabase (PostgreSQL, Auth, Storage, Edge Functions con Deno/Stripe)
- **Despliegue:** Vercel

## Estilos e íconos

- `styles.css` se genera con Tailwind desde `src/input.css` y **se versiona** (Vercel no instala dependencias). Tras cambiar clases en `index.html` o `app.js`:

  ```bash
  npm install
  npm run build:css
  ```

- Los íconos de Material Symbols son un subconjunto de unos 7 KB. Si agregas un ícono nuevo, ejecuta `pip install fonttools brotli && npm run build:icons`; si no, se verá el nombre del ícono como texto.
- Tras cambiar archivos de `vendor/` o la lista de `APP_SHELL`, sube `CACHE_VERSION` en `sw.js`.

## Configuración local y despliegue

1. Copia `config.example.js` a `config.js` (excluido por `.gitignore`) y coloca las credenciales de tu proyecto de Supabase para desarrollo local:

   ```js
   window.BM_CONFIG = {
     SUPABASE_URL: 'https://TU_PROYECTO.supabase.co',
     SUPABASE_KEY: 'TU_PUBLISHABLE_O_ANON_KEY',
   };
   ```

2. En Vercel, configura las variables de entorno `SUPABASE_URL` y `SUPABASE_KEY` en **Project Settings → Environment Variables**. El script `scripts/build-config.js` genera `config.js` automáticamente durante el build (`npm run build`).
3. Aplica los esquemas SQL de la carpeta `supabase/` junto con la tabla `admins` y la función `public.es_admin()` en tu instancia de Supabase.
