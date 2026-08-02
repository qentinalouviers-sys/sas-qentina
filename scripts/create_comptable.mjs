// Script: créer l'accès comptable dans Supabase
// Usage: node scripts/create_comptable.mjs

const SUPABASE_URL = 'https://jvbnjyzkawnorirrtvza.supabase.co';
const SERVICE_ROLE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imp2Ym5qeXprYXdub3JpcnJ0dnphIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3OTA5MDQ4OSwiZXhwIjoyMDk0NjY2NDg5fQ.vdm101GdI6rM66XsNFK6emtougTCOOK94b0c_auSy_o';

const COMPTABLE_EMAIL    = 'Laurence.BRULLARD@partexia.fr';
const COMPTABLE_PASSWORD = 'Partexia2026!';

async function createComptable() {
  console.log('👤 Création du compte comptable...\n');

  // 1. Check if user already exists
  const listRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users?page=1&per_page=100`, {
    headers: {
      'apikey': SERVICE_ROLE_KEY,
      'Authorization': `Bearer ${SERVICE_ROLE_KEY}`,
    },
  });

  if (listRes.ok) {
    const data = await listRes.json();
    const users = data.users || [];
    const existing = users.find(u => u.email?.toLowerCase() === COMPTABLE_EMAIL.toLowerCase());
    if (existing) {
      console.log(`ℹ️  L'utilisateur existe déjà (id: ${existing.id})`);
      console.log('   Mise à jour des métadonnées...');

      // Update metadata to set role
      const updateRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${existing.id}`, {
        method: 'PUT',
        headers: {
          'apikey': SERVICE_ROLE_KEY,
          'Authorization': `Bearer ${SERVICE_ROLE_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          user_metadata: { role: 'comptable', name: 'Laurence Brullard' },
        }),
      });

      if (updateRes.ok) {
        console.log('   ✅ Métadonnées mises à jour (role: comptable)');
      } else {
        const err = await updateRes.text();
        console.log(`   ❌ Erreur mise à jour: ${err}`);
      }
      printCredentials();
      return;
    }
  }

  // 2. Create new user
  const createRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
    method: 'POST',
    headers: {
      'apikey': SERVICE_ROLE_KEY,
      'Authorization': `Bearer ${SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      email: COMPTABLE_EMAIL,
      password: COMPTABLE_PASSWORD,
      email_confirm: true,
      user_metadata: {
        role: 'comptable',
        name: 'Laurence Brullard',
      },
    }),
  });

  const result = await createRes.json();

  if (createRes.ok || createRes.status === 201) {
    console.log(`✅ Compte créé avec succès! (id: ${result.id})`);
    printCredentials();
  } else {
    console.log(`❌ Erreur (${createRes.status}): ${JSON.stringify(result, null, 2)}`);
  }
}

function printCredentials() {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('📋 ACCÈS COMPTABLE');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`📧 Email    : ${COMPTABLE_EMAIL}`);
  console.log(`🔑 Mot de passe : ${COMPTABLE_PASSWORD}`);
  console.log('🔐 Rôle     : comptable (Finance & Compta uniquement)');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
}

createComptable().catch(console.error);
