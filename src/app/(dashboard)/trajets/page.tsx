'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { createClient } from '@/lib/supabase/client';
import { formatCurrency, formatDate, toISODate } from '@/lib/utils';
import {
  Car, Plus, Trash2, Printer, RefreshCw, Settings, Save,
  AlertTriangle, Coins, Route, Receipt, Check, Landmark,
} from 'lucide-react';
import { KpiCard, SectionHeader, Modal, EmptyState, LoadingPage } from '@/components/ui';
import {
  DEFAULT_CONFIG, mergeConfig, computeTotals, allocateShares, matchDestination,
  cvLabel, driverLabel,
  type MileageConfig, type CvBracket,
} from '@/lib/mileage';

interface Trip {
  id: string;
  date: string;
  destination_key: string;
  label: string;
  distance_km: number;
  toll_amount: number;
  driver: string;
  invoice_id: string | null;
  source: string;
  note: string | null;
  cca_movement_id: string | null;
}

const CV_OPTIONS: { value: CvBracket; label: string }[] = [
  { value: '3', label: '3 CV et moins' },
  { value: '4', label: '4 CV' },
  { value: '5', label: '5 CV' },
  { value: '6', label: '6 CV' },
  { value: '7+', label: '7 CV et plus' },
];

const EMPTY_FORM = {
  date: toISODate(new Date()),
  destination_key: 'metro',
  distance_km: '',
  toll_amount: '',
  note: '',
};

export default function TrajetsPage() {
  const [loading, setLoading] = useState(true);
  const [trips, setTrips] = useState<Trip[]>([]);
  const [config, setConfig] = useState<MileageConfig>(DEFAULT_CONFIG);
  const [year, setYear] = useState(new Date().getFullYear());
  const [driver, setDriver] = useState<'justine' | 'yohan'>(DEFAULT_CONFIG.defaultDriver);

  const [showConfig, setShowConfig] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [detecting, setDetecting] = useState(false);
  const [recording, setRecording] = useState(false);
  const [ccaMovements, setCcaMovements] = useState<{ id: string; montant: number }[]>([]);
  const [message, setMessage] = useState<{ type: 'success' | 'warning'; text: string } | null>(null);

  // ── Chargement ────────────────────────────────────────────────────────────
  const loadData = useCallback(async () => {
    setLoading(true);
    const supabase = createClient();
    const [tripsRes, settingsRes, ccaRes] = await Promise.all([
      supabase.from('mileage_trips').select('*').order('date', { ascending: false }),
      supabase.from('app_settings').select('value').eq('key', 'mileage_config').maybeSingle(),
      supabase.from('mouvements_cca').select('id, montant').eq('sous_type', 'frais_perso_reverse'),
    ]);

    setTrips((tripsRes.data as Trip[]) || []);
    setCcaMovements((ccaRes.data as { id: string; montant: number }[]) || []);

    if (settingsRes.data?.value) {
      try {
        const parsed = mergeConfig(JSON.parse(settingsRes.data.value));
        setConfig(parsed);
        setDriver(parsed.defaultDriver);
      } catch {
        // configuration illisible → valeurs par défaut
      }
    }
    setLoading(false);
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  const saveConfig = async (next: MileageConfig) => {
    setConfig(next);
    const supabase = createClient();
    const { error } = await supabase.from('app_settings').upsert({
      key: 'mileage_config',
      value: JSON.stringify(next),
      updated_at: new Date().toISOString(),
    });
    if (error) setMessage({ type: 'warning', text: 'Enregistrement des réglages impossible.' });
  };

  // ── Détection automatique depuis les factures ─────────────────────────────
  const detectFromInvoices = async () => {
    setDetecting(true);
    setMessage(null);
    try {
      const supabase = createClient();
      const { data: invoices, error } = await supabase
        .from('invoices')
        .select('id, date, invoice_number, supplier:suppliers(name)')
        .gte('date', `${year}-01-01`)
        .lte('date', `${year}-12-31`)
        .order('date');

      if (error) throw error;

      // Un trajet par JOUR et par DESTINATION : deux factures Metro le même
      // jour = un seul aller-retour (choix validé avec le restaurateur).
      const candidates = new Map<string, { date: string; dest: typeof config.destinations[0]; invoiceId: string; ref: string }>();

      for (const inv of invoices || []) {
        const supplierName = (inv.supplier as any)?.name || '';
        if (!supplierName || !inv.date) continue;

        const dest = matchDestination(supplierName, config.destinations);
        if (!dest) continue;

        const key = `${inv.date}|${dest.key}`;
        if (!candidates.has(key)) {
          candidates.set(key, {
            date: inv.date,
            dest,
            invoiceId: inv.id,
            ref: inv.invoice_number || '',
          });
        }
      }

      if (candidates.size === 0) {
        setMessage({ type: 'warning', text: `Aucune facture Metro ou Mozzalat trouvée sur ${year}.` });
        return;
      }

      const rows = [...candidates.entries()].map(([dedupeKey, c]) => ({
        date: c.date,
        destination_key: c.dest.key,
        label: c.dest.label,
        distance_km: c.dest.km,
        toll_amount: c.dest.toll,
        driver,
        invoice_id: c.invoiceId,
        source: 'auto',
        note: c.ref ? `Facture n° ${c.ref}` : null,
        dedupe_key: dedupeKey,
      }));

      // ignoreDuplicates : l'index unique sur dedupe_key garantit qu'une
      // relance de la détection n'ajoute jamais de doublon.
      const before = trips.length;
      const { error: insertError } = await supabase
        .from('mileage_trips')
        .upsert(rows, { onConflict: 'dedupe_key', ignoreDuplicates: true });

      if (insertError) throw insertError;

      await loadData();
      const { data: after } = await supabase.from('mileage_trips').select('id');
      const added = (after?.length || before) - before;
      setMessage({
        type: 'success',
        text: added > 0
          ? `${added} trajet${added > 1 ? 's' : ''} ajouté${added > 1 ? 's' : ''} depuis tes factures ${year}.`
          : `Aucun nouveau trajet : les ${candidates.size} déplacements de ${year} sont déjà enregistrés.`,
      });
    } catch (e: any) {
      console.error('Détection trajets:', e);
      setMessage({
        type: 'warning',
        text: e?.message?.includes('mileage_trips')
          ? "La table des trajets n'existe pas encore : exécute db/migration_trajets.sql dans Supabase."
          : 'Détection impossible. Vérifie ta connexion.',
      });
    } finally {
      setDetecting(false);
    }
  };

  // ── Ajout / suppression manuels ───────────────────────────────────────────
  const addTrip = async () => {
    const dest = config.destinations.find(d => d.key === form.destination_key);
    const km = parseFloat(form.distance_km) || dest?.km || 0;
    if (km <= 0) {
      setMessage({ type: 'warning', text: 'Indique une distance supérieure à zéro.' });
      return;
    }

    const supabase = createClient();
    const { error } = await supabase.from('mileage_trips').insert({
      date: form.date,
      destination_key: form.destination_key,
      label: dest?.label || 'Trajet',
      distance_km: km,
      toll_amount: parseFloat(form.toll_amount) || dest?.toll || 0,
      driver,
      source: 'manuel',
      note: form.note || null,
      dedupe_key: null, // saisie manuelle : jamais dédupliquée
    });

    if (error) {
      setMessage({ type: 'warning', text: `Ajout impossible : ${error.message}` });
      return;
    }
    setShowAdd(false);
    setForm(EMPTY_FORM);
    await loadData();
  };

  const deleteTrip = async (id: string) => {
    if (!confirm('Supprimer ce trajet ?')) return;
    const supabase = createClient();
    await supabase.from('mileage_trips').delete().eq('id', id);
    await loadData();
  };

  // ── Calculs ───────────────────────────────────────────────────────────────
  const yearTrips = useMemo(
    () => trips.filter(t => t.date?.startsWith(String(year)) && t.driver === driver),
    [trips, year, driver]
  );

  // Le barème étant progressif par tranche annuelle, les totaux se calculent
  // toujours sur l'année entière du conducteur.
  const totals = useMemo(() => computeTotals(yearTrips, config), [yearTrips, config]);

  // Ventilation au centime près : la somme des lignes égale exactement le total.
  const shares = useMemo(
    () => allocateShares(yearTrips.map(t => Number(t.distance_km) || 0), totals.totalKm, totals.allowance),
    [yearTrips, totals.totalKm, totals.allowance]
  );

  // Montant déjà porté au compte courant pour cette année/ce conducteur.
  const recorded = useMemo(() => {
    const linked = new Set(yearTrips.map(t => t.cca_movement_id).filter(Boolean));
    return Math.round(
      ccaMovements.filter(m => linked.has(m.id)).reduce((s, m) => s + (Number(m.montant) || 0), 0) * 100
    ) / 100;
  }, [yearTrips, ccaMovements]);

  // Reste à porter = total dû − déjà porté.
  // Se corrige tout seul : le barème étant progressif, franchir 5 000 km
  // relève le taux de TOUS les trajets de l'année ; l'écart est rattrapé au
  // prochain enregistrement plutôt que perdu.
  const remaining = Math.round((totals.total - recorded) * 100) / 100;

  const recordToCca = async () => {
    if (remaining <= 0) return;
    const unrecorded = yearTrips.filter(t => !t.cca_movement_id);
    if (unrecorded.length === 0 && remaining <= 0) return;

    setRecording(true);
    setMessage(null);
    try {
      const supabase = createClient();
      const isPastYear = year < new Date().getFullYear();
      const movementDate = isPastYear ? `${year}-12-31` : toISODate(new Date());

      const { data: movement, error } = await supabase
        .from('mouvements_cca')
        .insert({
          date: movementDate,
          associe: driver,
          sens: 'apport',
          sous_type: 'frais_perso_reverse',
          montant: remaining,
          note: `Frais kilométriques ${year} — ${yearTrips.length} trajet${yearTrips.length > 1 ? 's' : ''}, `
              + `${totals.totalKm.toLocaleString('fr-FR')} km`
              + (totals.tolls > 0 ? ` + péages` : '')
              + (recorded > 0 ? ` (complément)` : ''),
          rapproche_banque: false,
        })
        .select('id')
        .single();

      if (error || !movement) throw error ?? new Error('Insertion impossible');

      // On rattache les trajets non encore portés à ce mouvement.
      if (unrecorded.length > 0) {
        const { error: linkError } = await supabase
          .from('mileage_trips')
          .update({ cca_movement_id: movement.id })
          .in('id', unrecorded.map(t => t.id));
        if (linkError) throw linkError;
      }

      await loadData();
      setMessage({
        type: 'success',
        text: `${formatCurrency(remaining)} porté au compte courant de ${driverLabel(driver)}. `
            + `Quand tu feras le virement, enregistre-le comme remboursement depuis la page Comptes Associés.`,
      });
    } catch (e: any) {
      console.error('Enregistrement CCA:', e);
      setMessage({
        type: 'warning',
        text: e?.message?.includes('cca_movement_id')
          ? "Colonne manquante : relance db/migration_trajets.sql dans Supabase."
          : `Enregistrement impossible : ${e?.message || 'erreur inconnue'}`,
      });
    } finally {
      setRecording(false);
    }
  };

  const years = useMemo(() => {
    const set = new Set<number>([new Date().getFullYear()]);
    trips.forEach(t => { if (t.date) set.add(Number(t.date.slice(0, 4))); });
    return [...set].sort((a, b) => b - a);
  }, [trips]);

  const driverName = driverLabel(driver);
  const ownerName = driverLabel(config.vehicle.owner);
  /** Le conducteur des trajets n'est pas le titulaire de la carte grise. */
  const ownerMismatch = config.vehicle.owner !== driver;

  if (loading) return <LoadingPage text="Chargement des trajets…" />;

  return (
    <>
      <div className="page-header no-print">
        <div>
          <h2 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Car size={20} style={{ color: 'var(--teal)' }} />
            Frais kilométriques
          </h2>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
            Indemnités et péages remboursables pour l&apos;usage du véhicule personnel
          </div>
        </div>
        <div className="page-header-actions">
          <select className="form-select" value={year} onChange={e => setYear(Number(e.target.value))} style={{ minWidth: 100 }}>
            {years.map(y => <option key={y} value={y}>{y}</option>)}
          </select>
          <select className="form-select" value={driver} onChange={e => setDriver(e.target.value as any)} style={{ minWidth: 120 }}>
            <option value="justine">Justine</option>
            <option value="yohan">Yohan</option>
          </select>
          <button className="btn btn-secondary btn-sm" onClick={() => setShowConfig(true)}>
            <Settings size={16} /> <span className="btn-text">Réglages</span>
          </button>
          <button className="btn btn-secondary btn-sm" onClick={detectFromInvoices} disabled={detecting}>
            <RefreshCw size={16} className={detecting ? 'spinning' : ''} />
            <span className="btn-text">{detecting ? 'Détection…' : 'Détecter'}</span>
          </button>
          <button className="btn btn-secondary btn-sm" onClick={() => setShowAdd(true)}>
            <Plus size={16} /> <span className="btn-text">Trajet</span>
          </button>
          <button className="btn btn-primary btn-sm" onClick={() => window.print()} disabled={yearTrips.length === 0}>
            <Printer size={16} /> <span className="btn-text">Imprimer</span>
          </button>
        </div>
      </div>

      <div className="page-body">
        {message && (
          <div className={`alert ${message.type === 'success' ? 'alert-success' : 'alert-warning'} no-print`} style={{ marginBottom: 16 }}>
            {message.type === 'success' ? <Check size={16} /> : <AlertTriangle size={16} />}
            <span>{message.text}</span>
            <button className="btn btn-ghost btn-sm" style={{ marginLeft: 'auto' }} onClick={() => setMessage(null)}>×</button>
          </div>
        )}

        {/* ── Synthèse ───────────────────────────────────────────────────── */}
        <div className="kpi-grid-auto no-print">
          <KpiCard
            label="À te faire rembourser"
            value={formatCurrency(totals.total)}
            subValue={`Indemnité ${formatCurrency(totals.allowance)} + péages ${formatCurrency(totals.tolls)}`}
            icon={<Coins size={20} />}
            accentColor="#2D8F5E"
            badge={{ text: `${driverName} · ${year}`, type: 'good' }}
          />
          <KpiCard
            label="Distance parcourue"
            value={`${totals.totalKm.toLocaleString('fr-FR')} km`}
            subValue={`${totals.tripCount} déplacement${totals.tripCount > 1 ? 's' : ''}`}
            icon={<Route size={20} />}
            accentColor="#2A7D7B"
          />
          <KpiCard
            label="Barème appliqué"
            value={`${totals.ratePerKm.toFixed(3).replace('.', ',')} €/km`}
            subValue={`${cvLabel(config.cv)} · tranche ${totals.bracket}`}
            icon={<Receipt size={20} />}
            accentColor="#7C3AED"
          />
          <KpiCard
            label="Péages"
            value={formatCurrency(totals.tolls)}
            subValue="Remboursés au réel, sur justificatif"
            icon={<Receipt size={20} />}
            accentColor="#E89B3E"
          />
        </div>

        {/* ── Compte courant d'associé ───────────────────────────────────── */}
        {yearTrips.length > 0 && (
          <div className="card no-print" style={{
            marginBottom: 24,
            borderLeft: `4px solid ${remaining > 0 ? 'var(--orange)' : 'var(--green)'}`,
            display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap',
          }}>
            <Landmark size={22} style={{ color: remaining > 0 ? 'var(--orange)' : 'var(--green)', flexShrink: 0 }} />
            <div style={{ flex: 1, minWidth: 240 }}>
              <div style={{ fontWeight: 700, fontSize: 14 }}>
                {remaining > 0
                  ? `La société doit ${formatCurrency(remaining)} à ${driverName}`
                  : `Tout est porté au compte courant de ${driverName}`}
              </div>
              <div style={{ fontSize: 12.5, color: 'var(--text-muted)', marginTop: 3 }}>
                {recorded > 0 && (
                  <>Déjà porté : <strong>{formatCurrency(recorded)}</strong> · </>
                )}
                Total {year} : <strong>{formatCurrency(totals.total)}</strong>
                {remaining > 0 && (
                  <> · tant que le virement n&apos;est pas fait, ce montant reste dû à l&apos;associé</>
                )}
              </div>
            </div>
            <button
              className="btn btn-primary"
              onClick={recordToCca}
              disabled={recording || remaining <= 0}
              style={{ flexShrink: 0 }}
            >
              <Landmark size={16} />
              {recording ? 'Enregistrement…' : 'Porter au compte courant'}
            </button>
          </div>
        )}

        {/* ── Note de frais (écran + impression) ─────────────────────────── */}
        <div className="expense-report">
          <div className="print-only expense-header">
            <h1>Note de frais — Indemnités kilométriques</h1>
            <div className="expense-meta">
              <div><strong>Bénéficiaire :</strong> {driverName}</div>
              <div><strong>Période :</strong> année {year}</div>
              <div>
                <strong>Véhicule :</strong>{' '}
                {[config.vehicle.model, config.vehicle.plate].filter(Boolean).join(' — ') || 'véhicule personnel'}
                {config.vehicle.owner !== driver && ` (titulaire : ${ownerName})`}
              </div>
              <div>
                <strong>Puissance fiscale :</strong> {cvLabel(config.cv)}
                {config.electric && ' — 100 % électrique, majoration 20 %'}
              </div>
              <div><strong>Barème :</strong> kilométrique {config.baremeYear}, tranche {totals.bracket}</div>
              <div><strong>Éditée le :</strong> {formatDate(new Date())}</div>
            </div>
          </div>

          <SectionHeader
            title="Détail des déplacements"
            subtitle={`${yearTrips.length} trajet${yearTrips.length > 1 ? 's' : ''} · chaque ligne correspond à un aller-retour`}
            icon={<Route size={18} />}
          />

          {yearTrips.length === 0 ? (
            <EmptyState
              icon={<Car size={44} />}
              text={`Aucun trajet enregistré pour ${driverName} en ${year}. Utilise « Détecter » pour les générer depuis tes factures.`}
            />
          ) : (
            <div className="table-container">
              <table>
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Destination</th>
                    <th>Justificatif</th>
                    <th style={{ textAlign: 'right' }}>Distance</th>
                    <th style={{ textAlign: 'right' }}>Indemnité</th>
                    <th style={{ textAlign: 'right' }}>Péage</th>
                    <th style={{ textAlign: 'right' }}>Total</th>
                    <th className="no-print"></th>
                  </tr>
                </thead>
                <tbody>
                  {yearTrips.map((t, idx) => {
                    const km = Number(t.distance_km) || 0;
                    const toll = Number(t.toll_amount) || 0;
                    const share = shares[idx] ?? 0;
                    return (
                      <tr key={t.id}>
                        <td style={{ whiteSpace: 'nowrap' }}>{formatDate(t.date)}</td>
                        <td style={{ fontWeight: 600 }}>{t.label}</td>
                        <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                          {t.note || (t.source === 'manuel' ? 'Saisie manuelle' : '—')}
                        </td>
                        <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>{km.toLocaleString('fr-FR')} km</td>
                        <td style={{ textAlign: 'right' }}>{formatCurrency(share)}</td>
                        <td style={{ textAlign: 'right' }}>{toll > 0 ? formatCurrency(toll) : '—'}</td>
                        <td style={{ textAlign: 'right', fontWeight: 700 }}>{formatCurrency(share + toll)}</td>
                        <td className="no-print" style={{ textAlign: 'right' }}>
                          <button className="btn btn-ghost btn-sm" onClick={() => deleteTrip(t.id)} aria-label="Supprimer">
                            <Trash2 size={15} />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr style={{ borderTop: '2px solid var(--border)', fontWeight: 800 }}>
                    <td colSpan={3}>TOTAL {year}</td>
                    <td style={{ textAlign: 'right' }}>{totals.totalKm.toLocaleString('fr-FR')} km</td>
                    <td style={{ textAlign: 'right' }}>{formatCurrency(totals.allowance)}</td>
                    <td style={{ textAlign: 'right' }}>{formatCurrency(totals.tolls)}</td>
                    <td style={{ textAlign: 'right', color: 'var(--teal)' }}>{formatCurrency(totals.total)}</td>
                    <td className="no-print"></td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}

          <div className="print-only expense-footer">
            <p>
              Indemnité calculée selon le barème kilométrique {config.baremeYear} de l&apos;administration
              fiscale, tranche « {totals.bracket} », soit {totals.ratePerKm.toFixed(3).replace('.', ',')} €/km
              en moyenne sur la période. Les péages sont remboursés au réel sur présentation des justificatifs.
            </p>
            <div className="expense-signatures">
              <div><span>Le bénéficiaire</span><div className="sig-line" /></div>
              <div><span>La société</span><div className="sig-line" /></div>
            </div>
          </div>
        </div>

        {ownerMismatch && (
          <div className="alert alert-warning no-print" style={{ marginTop: 20 }}>
            <AlertTriangle size={16} />
            <span>
              La carte grise est au nom de <strong>{ownerName}</strong>, mais ces trajets sont
              enregistrés au nom de <strong>{driverName}</strong>. L&apos;indemnité kilométrique se
              rembourse au propriétaire du véhicule, ou à une personne du même foyer fiscal. Si c&apos;est
              votre cas, tout va bien — sinon, bascule le conducteur sur {ownerName} pour que le compte
              courant soit crédité au bon associé.
            </span>
          </div>
        )}

        {yearTrips.length > 0 && (
          <div className="alert alert-warning no-print" style={{ marginTop: 12 }}>
            <AlertTriangle size={16} />
            <span>
              Vérifie une fois les distances dans les réglages : elles sont pré-remplies avec des
              estimations et doivent être justifiables en cas de contrôle.
            </span>
          </div>
        )}
      </div>

      {/* ── Modale : ajout manuel ────────────────────────────────────────── */}
      {showAdd && (
        <Modal
          title="Ajouter un trajet"
          onClose={() => setShowAdd(false)}
          footer={
            <>
              <button className="btn btn-secondary" onClick={() => setShowAdd(false)}>Annuler</button>
              <button className="btn btn-primary" onClick={addTrip}><Plus size={16} /> Ajouter</button>
            </>
          }
        >
          <div className="form-group">
            <label className="form-label">Date</label>
            <input type="date" className="form-input" value={form.date}
              onChange={e => setForm(f => ({ ...f, date: e.target.value }))} />
          </div>
          <div className="form-group">
            <label className="form-label">Destination</label>
            <select className="form-select" value={form.destination_key}
              onChange={e => {
                const d = config.destinations.find(x => x.key === e.target.value);
                setForm(f => ({
                  ...f,
                  destination_key: e.target.value,
                  distance_km: d ? String(d.km) : f.distance_km,
                  toll_amount: d ? String(d.toll) : f.toll_amount,
                }));
              }}>
              {config.destinations.map(d => <option key={d.key} value={d.key}>{d.label}</option>)}
            </select>
          </div>
          <div className="grid-2">
            <div className="form-group">
              <label className="form-label">Distance aller-retour (km)</label>
              <input type="number" step="0.1" min="0" className="form-input" value={form.distance_km}
                placeholder={String(config.destinations.find(d => d.key === form.destination_key)?.km ?? '')}
                onChange={e => setForm(f => ({ ...f, distance_km: e.target.value }))} />
            </div>
            <div className="form-group">
              <label className="form-label">Péage (€)</label>
              <input type="number" step="0.01" min="0" className="form-input" value={form.toll_amount}
                placeholder="0,00"
                onChange={e => setForm(f => ({ ...f, toll_amount: e.target.value }))} />
            </div>
          </div>
          <div className="form-group">
            <label className="form-label">Motif / justificatif</label>
            <input type="text" className="form-input" value={form.note} placeholder="Ex. Facture n° 12345"
              onChange={e => setForm(f => ({ ...f, note: e.target.value }))} />
          </div>
        </Modal>
      )}

      {/* ── Modale : réglages ────────────────────────────────────────────── */}
      {showConfig && (
        <Modal
          large
          title="Réglages des frais kilométriques"
          onClose={() => setShowConfig(false)}
          footer={<button className="btn btn-primary" onClick={() => setShowConfig(false)}><Save size={16} /> Fermer</button>}
        >
          <div className="alert alert-warning" style={{ marginBottom: 18 }}>
            <AlertTriangle size={16} />
            <span>
              Les distances sont pré-remplies avec des estimations. Vérifie-les une fois sur un
              calculateur d&apos;itinéraire avec tes adresses exactes : en cas de contrôle, la distance
              doit être justifiable.
            </span>
          </div>

          <SectionHeader title="Véhicule" subtitle="Repris de la carte grise — imprimé sur la note de frais" />
          <div className="grid-2">
            <div className="form-group">
              <label className="form-label">Marque et modèle (cases D.1 / D.3)</label>
              <input type="text" className="form-input" value={config.vehicle.model}
                onChange={e => saveConfig({ ...config, vehicle: { ...config.vehicle, model: e.target.value } })} />
            </div>
            <div className="form-group">
              <label className="form-label">Immatriculation (case A)</label>
              <input type="text" className="form-input" value={config.vehicle.plate}
                onChange={e => saveConfig({ ...config, vehicle: { ...config.vehicle, plate: e.target.value } })} />
            </div>
            <div className="form-group">
              <label className="form-label">Titulaire de la carte grise (case C.1)</label>
              <select className="form-select" value={config.vehicle.owner}
                onChange={e => saveConfig({ ...config, vehicle: { ...config.vehicle, owner: e.target.value as 'justine' | 'yohan' } })}>
                <option value="justine">Justine</option>
                <option value="yohan">Yohan</option>
              </select>
            </div>
            <div className="form-group">
              <label className="form-label">Genre national (case J.1)</label>
              <input type="text" className="form-input" value={config.vehicle.registrationType}
                onChange={e => saveConfig({ ...config, vehicle: { ...config.vehicle, registrationType: e.target.value } })} />
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>
                VP, VASP… Un utilitaire « CTTE » relève des frais réels, pas du barème.
              </div>
            </div>
          </div>

          <SectionHeader title="Barème applicable" subtitle="Détermine le taux au kilomètre" />
          <div className="grid-2">
            <div className="form-group">
              <label className="form-label">Puissance fiscale (carte grise, case P.6)</label>
              <select className="form-select" value={config.cv}
                onChange={e => saveConfig({ ...config, cv: e.target.value as CvBracket })}>
                {CV_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
            <div className="form-group">
              <label className="form-label">Motorisation (case P.3)</label>
              <select className="form-select" value={config.electric ? 'e' : 't'}
                onChange={e => saveConfig({ ...config, electric: e.target.value === 'e' })}>
                <option value="t">Thermique</option>
                <option value="e">100 % électrique (+20 %)</option>
              </select>
            </div>
          </div>

          <div className="form-group">
            <label className="form-label">Année du barème</label>
            <input type="number" className="form-input" style={{ maxWidth: 140 }} value={config.baremeYear}
              onChange={e => saveConfig({ ...config, baremeYear: Number(e.target.value) || config.baremeYear })} />
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>
              Le barème est révisé chaque année. Mets à jour les taux ci-dessous si nécessaire.
            </div>
          </div>

          <SectionHeader title="Destinations" subtitle="Distances aller-retour et péages par défaut" />
          {config.destinations.map((d, i) => (
            <div key={d.key} className="card" style={{ marginBottom: 10, padding: 14 }}>
              <div style={{ fontWeight: 700, marginBottom: 10 }}>{d.label}</div>
              <div className="grid-3">
                <div className="form-group" style={{ marginBottom: 0 }}>
                  <label className="form-label">Aller-retour (km)</label>
                  <input type="number" step="0.1" min="0" className="form-input" value={d.km}
                    onChange={e => {
                      const next = [...config.destinations];
                      next[i] = { ...d, km: parseFloat(e.target.value) || 0 };
                      saveConfig({ ...config, destinations: next });
                    }} />
                </div>
                <div className="form-group" style={{ marginBottom: 0 }}>
                  <label className="form-label">Péage A/R (€)</label>
                  <input type="number" step="0.01" min="0" className="form-input" value={d.toll}
                    onChange={e => {
                      const next = [...config.destinations];
                      next[i] = { ...d, toll: parseFloat(e.target.value) || 0 };
                      saveConfig({ ...config, destinations: next });
                    }} />
                </div>
                <div className="form-group" style={{ marginBottom: 0 }}>
                  <label className="form-label">Fournisseur reconnu</label>
                  <input type="text" className="form-input" value={d.supplierMatch}
                    onChange={e => {
                      const next = [...config.destinations];
                      next[i] = { ...d, supplierMatch: e.target.value };
                      saveConfig({ ...config, destinations: next });
                    }} />
                </div>
              </div>
            </div>
          ))}

          <SectionHeader title="Taux du barème" subtitle={`Puissance sélectionnée : ${cvLabel(config.cv)}`} />
          <div className="grid-3">
            {([
              ['low', 'Jusqu\'à 5 000 km (€/km)'],
              ['midRate', 'De 5 001 à 20 000 km (€/km)'],
              ['midBonus', 'Forfait de la tranche (€)'],
              ['high', 'Au-delà de 20 000 km (€/km)'],
            ] as const).map(([field, label]) => (
              <div className="form-group" key={field} style={{ marginBottom: 8 }}>
                <label className="form-label">{label}</label>
                <input type="number" step="0.001" className="form-input"
                  value={config.bareme[config.cv][field]}
                  onChange={e => saveConfig({
                    ...config,
                    bareme: {
                      ...config.bareme,
                      [config.cv]: { ...config.bareme[config.cv], [field]: parseFloat(e.target.value) || 0 },
                    },
                  })} />
              </div>
            ))}
          </div>
        </Modal>
      )}
    </>
  );
}
