import { createClient } from '@supabase/supabase-js';
import fs from 'fs';
import path from 'path';

// 1. Lire .env.local pour récupérer les clés d'accès
const envPath = path.resolve(process.cwd(), '.env.local');
if (!fs.existsSync(envPath)) {
  console.error("Fichier .env.local introuvable dans le répertoire courant.");
  process.exit(1);
}

const envContent = fs.readFileSync(envPath, 'utf-8');
const env = {};
for (const line of envContent.split('\n')) {
  if (line.includes('=')) {
    const [key, ...valParts] = line.split('=');
    const val = valParts.join('=').trim();
    env[key.trim()] = val.replace(/^["']|["']$/g, ''); // enlever les guillemets éventuels
  }
}

const supabaseUrl = env['NEXT_PUBLIC_SUPABASE_URL'];
const supabaseKey = env['SUPABASE_SERVICE_ROLE_KEY'];

if (!supabaseUrl || !supabaseKey) {
  console.error("Clés NEXT_PUBLIC_SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY manquantes dans .env.local.");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function cleanStorage() {
  console.log("=== Nettoyage du stockage Supabase (bucket 'invoice-files') ===");
  try {
    // Lister récursivement tous les fichiers dans le bucket 'invoice-files'
    async function listAllFiles(folderPath = '') {
      const { data, error } = await supabase.storage.from('invoice-files').list(folderPath, {
        limit: 100
      });
      
      if (error) {
        throw error;
      }

      let files = [];
      if (!data) return files;

      for (const item of data) {
        const fullPath = folderPath ? `${folderPath}/${item.name}` : item.name;
        // Les dossiers n'ont pas d'id ou de metadata.size, ou ont metadata = null
        const isFolder = !item.metadata || item.id === null || item.metadata.size === undefined;
        if (isFolder) {
          const subFiles = await listAllFiles(fullPath);
          files = files.concat(subFiles);
        } else {
          files.push(fullPath);
        }
      }
      return files;
    }

    console.log("Recherche des fichiers joints...");
    const filesToDelete = await listAllFiles();
    
    if (filesToDelete.length === 0) {
      console.log("Aucun fichier trouvé dans le stockage.");
      return;
    }

    console.log(`Trouvé ${filesToDelete.length} fichiers à supprimer :`, filesToDelete);

    // Supprimer les fichiers par lots (Supabase supporte la suppression de plusieurs fichiers à la fois)
    const { data: delData, error: delError } = await supabase.storage
      .from('invoice-files')
      .remove(filesToDelete);

    if (delError) {
      console.error("Erreur lors de la suppression des fichiers de stockage :", delError.message);
    } else {
      console.log(`✅ Suppression réussie de ${filesToDelete.length} fichiers du stockage.`);
    }
  } catch (err) {
    console.error("Erreur non fatale lors du nettoyage du stockage :", err.message || err);
  }
}

async function runReset() {
  console.log("=== Début du reset de la base de données ===");

  // Étape 1 : Supprimer les lignes de factures
  console.log("1. Nettoyage de la table 'invoice_lines'...");
  const { count: linesCount, error: linesErr } = await supabase
    .from('invoice_lines')
    .delete()
    .neq('id', '00000000-0000-0000-0000-000000000000'); // delete all using filter trick

  if (linesErr) {
    console.error("Erreur lors de la suppression des lignes de factures :", linesErr.message);
  } else {
    console.log("✅ Lignes de factures supprimées.");
  }

  // Étape 2 : Supprimer toutes les factures
  console.log("2. Nettoyage de la table 'invoices'...");
  const { count: invoicesCount, error: invoicesErr } = await supabase
    .from('invoices')
    .delete()
    .neq('id', '00000000-0000-0000-0000-000000000000');

  if (invoicesErr) {
    console.error("Erreur lors de la suppression des factures :", invoicesErr.message);
  } else {
    console.log("✅ Factures supprimées.");
  }

  // Étape 3 : Réinitialiser les statuts et liaisons dans bank_transactions
  console.log("3. Réinitialisation des transactions bancaires ('bank_transactions')...");
  
  // Mettre à jour toutes les transactions pour enlever le lien de facture, remettre le statut en 'pending_invoice'
  // et effacer la classification comptable si présente (avec fallback si la colonne n'existe pas)
  const { data: updateData, error: updateErr } = await supabase
    .from('bank_transactions')
    .update({
      status: 'pending_invoice',
      invoice_id: null,
      accounting_class: null
    })
    .neq('id', '00000000-0000-0000-0000-000000000000');

  if (updateErr) {
    if (updateErr.message.includes('accounting_class')) {
      console.log("La colonne 'accounting_class' n'existe pas ou n'est pas dans le cache. Tentative sans cette colonne...");
      const { error: fallbackErr } = await supabase
        .from('bank_transactions')
        .update({
          status: 'pending_invoice',
          invoice_id: null
        })
        .neq('id', '00000000-0000-0000-0000-000000000000');

      if (fallbackErr) {
        console.error("Erreur lors du fallback de réinitialisation des transactions bancaires :", fallbackErr.message);
      } else {
        console.log("✅ Transactions bancaires réinitialisées (sans accounting_class).");
      }
    } else {
      console.error("Erreur lors de la réinitialisation des transactions bancaires :", updateErr.message);
    }
  } else {
    console.log("✅ Transactions bancaires réinitialisées.");
  }

  // Étape 4 : Nettoyer le bucket de stockage
  await cleanStorage();

  console.log("\n=== RESET FINI AVEC SUCCÈS ===");
}

runReset();
