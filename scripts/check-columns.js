const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');

// Read env variables
const env = fs.readFileSync('.env.local', 'utf8');
const getEnv = (key) => {
  const match = env.match(new RegExp(`${key}=(.*)`));
  return match ? match[1].trim() : null;
};

const supabaseUrl = getEnv('NEXT_PUBLIC_SUPABASE_URL');
const supabaseKey = getEnv('SUPABASE_SERVICE_ROLE_KEY');

const supabase = createClient(supabaseUrl, supabaseKey);

async function check() {
  const { data, error } = await supabase.rpc('exec_sql', { query: 'SELECT 1' });
  console.log("exec_sql result:", data, error);
}

check();
