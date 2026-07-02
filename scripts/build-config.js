const fs = require('fs');
const path = require('path');

// Valores por defecto: la URL y la publishable key de Supabase NO son
// secretas (son las que se usan en el navegador y quedan protegidas por
// las políticas de RLS), así que sirven como respaldo si en Vercel aún no
// se configuraron las variables de entorno. Si defines SUPABASE_URL /
// SUPABASE_KEY en Vercel, esos valores tienen prioridad sobre estos.
const DEFAULTS = {
  SUPABASE_URL: 'https://lijzftjgevwnjorpycxa.supabase.co',
  SUPABASE_KEY: 'sb_publishable_Y1v63ZdMakSGbx449TKpiA_cKNykbk2',
};

const required = [
  'SUPABASE_URL',
  'SUPABASE_KEY',
];

const missing = required.filter((key) => !process.env[key]);
if (missing.length) {
  // No se aborta el build: si faltan las variables en Vercel, se usan los
  // valores por defecto de arriba para que el deploy nunca se rompa.
  console.warn('[build-config] Usando valores por defecto para:', missing.join(', '));
  console.warn('[build-config] Puedes sobreescribirlos en Vercel → Project Settings → Environment Variables.');
}

const config = {
  SUPABASE_URL: process.env.SUPABASE_URL || DEFAULTS.SUPABASE_URL,
  SUPABASE_KEY: process.env.SUPABASE_KEY || DEFAULTS.SUPABASE_KEY,
};

const output = `// Configuración generada automáticamente por el build de Vercel.\n// NO edites este archivo manualmente.\nwindow.BM_CONFIG = ${JSON.stringify(config, null, 2)};\n`;

const outPath = path.join(__dirname, '..', 'config.js');
fs.writeFileSync(outPath, output);
console.log('[build-config] config.js generado correctamente.');