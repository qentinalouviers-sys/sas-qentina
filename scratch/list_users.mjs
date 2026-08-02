const SUPABASE_URL = 'https://jvbnjyzkawnorirrtvza.supabase.co';
const SERVICE_ROLE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imp2Ym5qeXprYXdub3JpcnJ0dnphIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3OTA5MDQ4OSwiZXhwIjoyMDk0NjY2NDg5fQ.vdm101GdI6rM66XsNFK6emtougTCOOK94b0c_auSy_o';

async function listUsers() {
  console.log('Fetching users from Supabase admin...');
  const res = await fetch(`${SUPABASE_URL}/auth/v1/admin/users?page=1&per_page=100`, {
    headers: {
      'apikey': SERVICE_ROLE_KEY,
      'Authorization': `Bearer ${SERVICE_ROLE_KEY}`,
    },
  });

  if (res.ok) {
    const data = await res.json();
    const users = data.users || [];
    console.log(`Found ${users.length} users:`);
    for (const u of users) {
      console.log(`- Email: ${u.email}, ID: ${u.id}, Role: ${u.user_metadata?.role || 'none'}, Created: ${u.created_at}`);
    }
  } else {
    console.error(`Error: ${res.status}`, await res.text());
  }
}

listUsers().catch(console.error);
