/** Account reads used for entry decisions must be known, finite and current. */
export function requireEquity(snapshot) {
  const equity = snapshot?.equity;
  if (!Number.isFinite(equity) || equity <= 0) {
    throw new Error('ACCOUNT_RISK_REJECT: broker equity must be a finite positive number');
  }
  return equity;
}

export function dailyLossPercent(pnl, equity, limit) {
  requireEquity({ equity });
  if (!Number.isFinite(pnl) || !Number.isFinite(limit) || limit <= 0) {
    throw new Error('ACCOUNT_RISK_REJECT: daily P&L and loss limit must be valid numbers');
  }
  const percent = pnl / equity * 100;
  if (!Number.isFinite(percent)) throw new Error('ACCOUNT_RISK_REJECT: invalid daily loss percentage');
  return percent;
}

/** Read the selected provider only. A failed broker read must never fall back to a DOM account. */
export async function readEntryEquity(read) {
  const snapshot = await read();
  requireEquity(snapshot);
  return snapshot;
}
