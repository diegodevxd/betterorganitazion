const fs = require('fs');
const path = require('path');

const required = [
  'SUPABASE_URL',
  'SUPABASE_KEY',
];

const missing = required.filter((key) => !process.env[key]);
if (missing.length) {
  console.error('[build-config] Faltan variables de entorno:', missing.join(', '));
  console.error('[build-config] Agrégalas en el dashboard de Vercel antes de hacer deploy.');
  process.exit(1);
}

const config = {
  SUPABASE_URL: process.env.SUPABASE_URL,
  SUPABASE_KEY: process.env.SUPABASE_KEY,
};

const output = `// Configuración generada automáticamente por el build de Vercel.\n// NO edites este archivo manualmente.\nwindow.BM_CONFIG = ${JSON.stringify(config, null, 2)};\n`;

const outPath = path.join(__dirname, '..', 'config.js');
fs.writeFileSync(outPath, output);
console.log('[build-config] config.js generado correctamente.');