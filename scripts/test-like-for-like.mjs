import { createClient } from '@supabase/supabase-js';
import fs from 'fs';
import { startOfMonth, subMonths, addDays, parseISO, format } from 'date-fns';

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

const toISODate = (date) => format(date, 'yyyy-MM-dd');

async function checkLikeForLike() {
  const anchorDate = '2026-06-22';
  const parsedAnchor = parseISO(anchorDate);
  
  const currentStart = startOfMonth(parsedAnchor);
  const prevStart = startOfMonth(subMonths(parsedAnchor, 1));
  const daysElapsed = parsedAnchor.getDate() - 1;
  const prevEnd = addDays(prevStart, daysElapsed);

  const currentStartISO = toISODate(currentStart);
  const currentEndISO = anchorDate; // up to today
  const prevStartISO = toISODate(prevStart);
  const prevEndISO = toISODate(prevEnd);

  console.log(`Current Period: ${currentStartISO} to ${currentEndISO}`);
  console.log(`Previous Period (Like-for-like): ${prevStartISO} to ${prevEndISO}`);

  const { data: rawOrders, error } = await supabase
    .from('square_orders')
    .select('*')
    .gte('service', prevStartISO)
    .lte('service', currentEndISO);

  if (error) {
    console.error(error);
    return;
  }

  const getHtAmount = (o) => {
    const raw = o.raw_data || {};
    const tax = (raw.total_tax_money?.amount || raw.net_amounts?.tax_money?.amount || 0) / 100;
    return (o.net_amount || 0) - tax;
  };

  const activeOrders = rawOrders.filter(o => o.service >= currentStartISO && o.service <= currentEndISO && o.net_amount > 0);
  const prevOrders = rawOrders.filter(o => o.service >= prevStartISO && o.service <= prevEndISO && o.net_amount > 0);

  const activeCA = activeOrders.reduce((sum, o) => sum + getHtAmount(o), 0);
  const prevCA = prevOrders.reduce((sum, o) => sum + getHtAmount(o), 0);

  const diff = activeCA - prevCA;
  const pct = (diff / prevCA) * 100;

  console.log(`\nActive CA HT (June 1-22): ${activeCA.toFixed(2)} € (${activeOrders.length} orders)`);
  console.log(`Previous CA HT (May 1-22): ${prevCA.toFixed(2)} € (${prevOrders.length} orders)`);
  console.log(`Growth rate: ${pct.toFixed(2)}%`);
}

checkLikeForLike();
