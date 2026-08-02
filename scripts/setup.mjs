// Script de setup : exécute le schéma SQL + crée l'utilisateur admin
const SUPABASE_URL = 'https://jvbnjyzkawnorirrtvza.supabase.co';
const SERVICE_ROLE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imp2Ym5qeXprYXdub3JpcnJ0dnphIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3OTA5MDQ4OSwiZXhwIjoyMDk0NjY2NDg5fQ.vdm101GdI6rM66XsNFK6emtougTCOOK94b0c_auSy_o';

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function supabaseRPC(path, body, method = 'POST') {
  const res = await fetch(`${SUPABASE_URL}${path}`, {
    method,
    headers: {
      'apikey': SERVICE_ROLE_KEY,
      'Authorization': `Bearer ${SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, ok: res.ok, body: text };
}

async function runSQL(sql) {
  // Use the Supabase SQL endpoint (pg REST)
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc`, {
    method: 'POST',
    headers: {
      'apikey': SERVICE_ROLE_KEY,
      'Authorization': `Bearer ${SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query: sql }),
  });
  return { status: res.status, ok: res.ok, body: await res.text() };
}

async function main() {
  console.log('🔧 QENTINA Setup\n');

  // 1. Execute SQL schema via the management API
  console.log('📦 Exécution du schéma SQL...');
  const schemaPath = resolve(__dirname, '..', 'supabase-schema.sql');
  const schema = readFileSync(schemaPath, 'utf-8');
  
  // Split schema into individual statements and execute each
  const statements = schema
    .split(';')
    .map(s => s.trim())
    .filter(s => s.length > 0 && !s.startsWith('--'));

  for (const stmt of statements) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/exec_sql`, {
      method: 'POST',
      headers: {
        'apikey': SERVICE_ROLE_KEY,
        'Authorization': `Bearer ${SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query: stmt + ';' }),
    });
    // This endpoint might not exist, that's fine - we'll try alternative approach
  }

  // Alternative: Use the Supabase Management API SQL endpoint
  console.log('   Tentative via API SQL directe...');
  const sqlRes = await fetch(`${SUPABASE_URL}/pg/query`, {
    method: 'POST',
    headers: {
      'apikey': SERVICE_ROLE_KEY,
      'Authorization': `Bearer ${SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query: schema }),
  });
  
  if (sqlRes.ok) {
    console.log('   ✅ Schéma SQL exécuté avec succès!');
  } else {
    console.log(`   ⚠️  Endpoint SQL (${sqlRes.status}). Essayez d'exécuter supabase-schema.sql manuellement dans le dashboard Supabase → SQL Editor.`);
  }

  // 2. Create admin user
  console.log('\n👤 Création utilisateur admin...');
  const userRes = await supabaseRPC('/auth/v1/admin/users', {
    email: 'admin@qentina.fr',
    password: 'Qentina2026!',
    email_confirm: true,
    user_metadata: { name: 'Admin QENTINA' },
  });

  if (userRes.ok || userRes.status === 200 || userRes.status === 201) {
    console.log('   ✅ Utilisateur créé!');
    console.log('   📧 Email: admin@qentina.fr');
    console.log('   🔑 Mot de passe: Qentina2026!');
  } else if (userRes.status === 422 && userRes.body.includes('already')) {
    console.log('   ℹ️  Utilisateur existe déjà.');
    console.log('   📧 Email: admin@qentina.fr');
    console.log('   🔑 Mot de passe: Qentina2026!');
  } else {
    console.log(`   ❌ Erreur (${userRes.status}): ${userRes.body}`);
  }

  // 3. Check if tables exist by querying suppliers
  console.log('\n🔍 Vérification des tables...');
  const checkRes = await fetch(`${SUPABASE_URL}/rest/v1/suppliers?select=id,name&limit=5`, {
    headers: {
      'apikey': SERVICE_ROLE_KEY,
      'Authorization': `Bearer ${SERVICE_ROLE_KEY}`,
    },
  });
  
  if (checkRes.ok) {
    const data = await checkRes.json();
    console.log(`   ✅ Table suppliers OK (${data.length} entrées)`);
    if (data.length > 0) {
      data.forEach(s => console.log(`      - ${s.name}`));
    }
  } else {
    console.log(`   ❌ Tables non trouvées (${checkRes.status}). Exécutez supabase-schema.sql dans le SQL Editor du dashboard Supabase.`);
  }

  console.log('\n✨ Setup terminé!');
}

main().catch(console.error);
