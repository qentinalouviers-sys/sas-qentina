import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'QENTINA — Pilotage Restaurateur',
  description: 'SaaS de pilotage pour pizzeria napolitaine — gestion factures, fiches techniques, stock, ventes et KPIs.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="fr">
      <body>{children}</body>
    </html>
  );
}
