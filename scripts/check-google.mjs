import { createClient } from '@supabase/supabase-js';
import fs from 'fs';

const envContent = fs.readFileSync('.env.local', 'utf-8');
const envLines = envContent.split('\n');
const env = {};
for (const line of envLines) {
  if (line.includes('=')) {
    const [key, val] = line.split('=');
    env[key.trim()] = val.trim();
  }
}

const supabaseUrl = env['NEXT_PUBLIC_SUPABASE_URL'];
const supabaseKey = env['SUPABASE_SERVICE_ROLE_KEY'];
const supabase = createClient(supabaseUrl, supabaseKey);

async function run() {
  const { data: atData } = await supabase.from('app_settings').select('value').eq('key', 'google_access_token').single();
  if (!atData?.value) {
    console.log('No access token found');
    return;
  }
  const { token } = JSON.parse(atData.value);

  console.log('Fetching accounts...');
  const accRes = await fetch('https://mybusinessaccountmanagement.googleapis.com/v1/accounts', {
    headers: { Authorization: `Bearer ${token}` }
  });
  const accData = await accRes.json();
  console.log('Accounts:', JSON.stringify(accData, null, 2));

  if (!accData.accounts || accData.accounts.length === 0) return;

  for (const acc of accData.accounts) {
    console.log(`\nFetching locations for ${acc.name}...`);
    const locRes = await fetch(`https://mybusinessbusinessinformation.googleapis.com/v1/${acc.name}/locations?readMask=name,title`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const locData = await locRes.json();
    console.log('Locations:', JSON.stringify(locData, null, 2));

    if (locData.locations) {
      for (const loc of locData.locations) {
        console.log(`\nFetching reviews for ${loc.name}...`);
        const revRes = await fetch(`https://mybusiness.googleapis.com/v4/${acc.name}/${loc.name}/reviews`, {
          headers: { Authorization: `Bearer ${token}` }
        });
        const revData = await revRes.json();
        console.log(`Reviews for ${loc.title}:`, JSON.stringify(revData, null, 2));
      }
    }
  }
}

run();
