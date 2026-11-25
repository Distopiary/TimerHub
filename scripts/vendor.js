// Copie la bibliothèque Supabase dans web/vendor pour qu'elle fonctionne hors ligne et sur le téléphone.
const fs = require('fs');
const path = require('path');

const src = path.join(__dirname, '..', 'node_modules', '@supabase', 'supabase-js', 'dist', 'umd', 'supabase.js');
const dest = path.join(__dirname, '..', 'web', 'vendor', 'supabase.js');

if (!fs.existsSync(src)) {
  console.error('supabase.js introuvable :', src);
  process.exit(1);
}
fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.copyFileSync(src, dest);
console.log('Supabase copié dans web/vendor/supabase.js');
