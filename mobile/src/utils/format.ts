import { ThemeColors } from '@/types';

export function fmtMoney(n: number | null | undefined): string {
  if (n === null || n === undefined) return '$0';
  return `$${Math.round(n).toLocaleString()}`;
}

export function fmtPct(n: number | null | undefined): string {
  if (n === null || n === undefined) return '0%';
  return `${n.toFixed(1)}%`;
}

export function timeSince(isoDate: string): string {
  const date = new Date(isoDate);
  const now = new Date();
  const secondsPassed = Math.floor((now.getTime() - date.getTime()) / 1000);

  if (secondsPassed < 60) return 'just now';
  if (secondsPassed < 3600) return `${Math.floor(secondsPassed / 60)}m ago`;
  if (secondsPassed < 86400) return `${Math.floor(secondsPassed / 3600)}h ago`;
  if (secondsPassed < 604800) return `${Math.floor(secondsPassed / 86400)}d ago`;

  return date.toLocaleDateString();
}

export function openingTypeLabel(type: string): string {
  const labels: Record<string, string> = {
    single_hung: 'Single Hung',
    double_hung: 'Double Hung',
    casement: 'Casement',
    sliding: 'Sliding',
    double_slider: 'Double Slider',
    awning: 'Awning',
    hopper: 'Hopper',
    fixed: 'Fixed',
    french_door: 'French Door',
    sliding_door: 'Sliding Door',
    patio_door: 'Patio Door',
    entry_door: 'Entry Door',
  };
  return labels[type] || type;
}

export function floorLabel(level: string | number): string {
  const levelStr = String(level).toLowerCase();
  if (levelStr === '1' || levelStr === 'first' || levelStr === '1st') return '1st Floor';
  if (levelStr === '2' || levelStr === 'second' || levelStr === '2nd') return '2nd Floor';
  if (levelStr === '3' || levelStr === 'third' || levelStr === '3rd') return '3rd Floor';
  if (levelStr === '4' || levelStr === 'fourth' || levelStr === '4th') return '4th+ Floor';
  return String(level);
}

export function statusLabel(status: string): string {
  const labels: Record<string, string> = {
    draft: 'DRAFT',
    submitted: 'SUBMITTED',
    pending_approval: 'PENDING',
    approved: 'APPROVED',
    ordered: 'ORDERED',
    completed: 'COMPLETED',
    denied: 'DENIED',
  };
  return labels[status] || status.toUpperCase();
}

export function statusColor(
  status: string,
  colors: ThemeColors
): string {
  switch (status) {
    case 'draft':
      return colors.textMuted;
    case 'submitted':
    case 'pending_approval':
      return colors.amber;
    case 'approved':
      return colors.green;
    case 'ordered':
      return colors.teal;
    case 'completed':
      return colors.green;
    case 'denied':
      return colors.red;
    default:
      return colors.textMuted;
  }
}

export function marginColor(
  pct: number,
  floor: number,
  yellow: number
): 'green' | 'amber' | 'red' {
  if (pct < floor) return 'red';
  if (pct < yellow) return 'amber';
  return 'green';
}

export function abbreviateEmail(email: string): string {
  const [local] = email.split('@');
  if (local.length <= 2) return local;
  return `${local[0]}...${local[local.length - 1]}`;
}

export function getInitials(name: string): string {
  return name
    .split(' ')
    .map((part) => part[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);
}
