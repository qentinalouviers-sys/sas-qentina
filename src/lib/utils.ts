import { format, startOfDay, startOfWeek, startOfMonth, startOfYear, endOfDay, endOfWeek, endOfMonth, endOfYear } from 'date-fns';
import { fr } from 'date-fns/locale';

export function formatCurrency(amount: number | null | undefined, decimals?: number): string {
  if (amount == null) return '0,00 €';
  
  const options: Intl.NumberFormatOptions = {
    style: 'currency',
    currency: 'EUR',
  };
  
  if (decimals !== undefined) {
    options.minimumFractionDigits = decimals;
    options.maximumFractionDigits = decimals;
  } else if (Math.abs(amount) > 0 && Math.abs(amount) < 0.01) {
    options.minimumFractionDigits = 3;
    options.maximumFractionDigits = 4;
  }
  
  return new Intl.NumberFormat('fr-FR', options).format(amount);
}

export function formatPercent(value: number | null | undefined): string {
  if (value == null) return '0 %';
  return `${value.toFixed(1)} %`;
}

export function formatDate(date: string | Date): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  return format(d, 'dd/MM/yyyy', { locale: fr });
}

export function formatDateLong(date: string | Date): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  return format(d, 'dd MMMM yyyy', { locale: fr });
}

export function getDateRange(period: 'today' | 'week' | 'month' | 'year' | 'custom', customStart?: Date, customEnd?: Date) {
  const now = new Date();
  switch (period) {
    case 'today':
      return { start: startOfDay(now), end: endOfDay(now) };
    case 'week':
      return { start: startOfWeek(now, { weekStartsOn: 1 }), end: endOfWeek(now, { weekStartsOn: 1 }) };
    case 'month':
      return { start: startOfMonth(now), end: endOfMonth(now) };
    case 'year':
      return { start: startOfYear(now), end: endOfYear(now) };
    case 'custom':
      return {
        start: customStart || startOfMonth(now),
        end: customEnd || endOfMonth(now),
      };
  }
}

export function toISODate(date: Date): string {
  return format(date, 'yyyy-MM-dd');
}

export function downloadCSV(data: Record<string, unknown>[], filename: string) {
  if (data.length === 0) return;
  const headers = Object.keys(data[0]);
  const csv = [
    headers.join(';'),
    ...data.map(row => headers.map(h => {
      const val = row[h];
      if (val == null) return '';
      if (typeof val === 'string' && val.includes(';')) return `"${val}"`;
      return String(val);
    }).join(';'))
  ].join('\n');

  const BOM = '\uFEFF';
  const blob = new Blob([BOM + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${filename}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

export const CATEGORY_LABELS: Record<string, string> = {
  alimentaire: 'Alimentaire',
  materiel: 'Matériel',
  emballage: 'Emballage',
  boisson: 'Boisson',
  autre: 'Autre',
};

export const RECIPE_CATEGORY_LABELS: Record<string, string> = {
  pizza: 'Pizza',
  panuozzo: 'Panuozzo',
  salade: 'Salade',
  plat: 'Plat',
  dessert: 'Dessert',
  protocole_pate: 'Protocole Pâte',
  base_sauce: 'Base Sauce',
};

export const FOOD_COST_TARGET = 32;
export const FOOD_COST_OPTIMAL_MIN = 28;
export const FOOD_COST_OPTIMAL_MAX = 32;
