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

async function diagnose() {
  console.log("=== DIAGNOSTIC DE LA TABLE INVOICES ===");
  
  // 1. Lister les colonnes réelles de la table invoices
  // On utilise une requête SQL via rpc si possible, ou une simple sélection
  const { data: colsData, error: colsErr } = await supabase
    .from('invoices')
    .select('*')
    .limit(1);

  if (colsErr) {
    console.error("Erreur lors de la lecture de la table invoices :", colsErr);
  } else {
    console.log("Lecture d'une ligne d'invoices réussie ! Colonnes disponibles :");
    if (colsData.length > 0) {
      console.log(Object.keys(colsData[0]));
    } else {
      console.log("Aucune ligne dans la table, mais la table existe et est accessible.");
    }
  }

  // 2. Tester une insertion manuelle avec des données factices valides
  console.log("\n--- Test d'insertion manuelle d'une facture de test ---");
  const testInvoice = {
    date: '2026-06-22',
    invoice_number: 'TEST-123',
    total_ht: 10.00,
    total_ttc: 12.00,
    accounting_ref: 'FAC-202606-TEST',
    // On essaie avec les nouvelles colonnes
    accounting_class: '601',
    payment_method: 'bank'
  };

  const { data: insData, error: insErr } = await supabase
    .from('invoices')
    .insert(testInvoice)
    .select('id')
    .single();

  if (insErr) {
    console.error("❌ Échec de l'insertion de test avec les nouvelles colonnes :", insErr.message);
    console.error("Code erreur :", insErr.code, "Détails :", insErr.details, "Hint :", insErr.hint);

    // Essai du fallback sans les nouvelles colonnes
    console.log("\n--- Test du fallback (sans accounting_class/payment_method) ---");
    const fallbackInvoice = {
      date: '2026-06-22',
      invoice_number: 'TEST-123-FALLBACK',
      total_ht: 10.00,
      total_ttc: 12.00,
      accounting_ref: 'FAC-202606-FALL'
    };

    const { data: fbData, error: fbErr } = await supabase
      .from('invoices')
      .insert(fallbackInvoice)
      .select('id')
      .single();

    if (fbErr) {
      console.error("❌ Échec de l'insertion de test du fallback également :", fbErr.message);
      console.error("Code erreur :", fbErr.code, "Détails :", fbErr.details);
    } else {
      console.log("✅ Insertion du fallback réussie ! ID :", fbData.id);
      // Nettoyage
      await supabase.from('invoices').delete().eq('id', fbData.id);
    }
  } else {
    console.log("✅ Insertion de test réussie avec toutes les colonnes ! ID :", insData.id);
    // Nettoyage
    await supabase.from('invoices').delete().eq('id', insData.id);
  }
}

diagnose();
