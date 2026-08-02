import { createClient } from '@supabase/supabase-js';
import fs from 'fs';
import path from 'path';

// Lire .env.local
const envPath = path.resolve(process.cwd(), '.env.local');
const envContent = fs.readFileSync(envPath, 'utf-8');
const env = {};
for (const line of envContent.split('\n')) {
  if (line.includes('=')) {
    const [key, ...valParts] = line.split('=');
    const val = valParts.join('=').trim();
    env[key.trim()] = val.replace(/^["']|["']$/g, '');
  }
}

const supabase = createClient(env['NEXT_PUBLIC_SUPABASE_URL'], env['SUPABASE_SERVICE_ROLE_KEY']);

async function testRpc() {
  console.log("=== TEST DE L'EXÉCUTION SQL VIA RPC ===");

  // Essai de exec_sql
  const { data, error } = await supabase.rpc('exec_sql', { 
    query: 'SELECT current_database(), current_user;' 
  });

  if (error) {
    console.error("❌ L'appel RPC 'exec_sql' a échoué :", error.message);
  } else {
    console.log("✅ L'appel RPC 'exec_sql' a fonctionné ! Résultat :", data);
  }
}

testRpc();
