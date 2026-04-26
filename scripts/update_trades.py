import csv

updates = {
    '2026-04-16T13:01:24.003Z': ('L', '-6.06'),
    '2026-04-16T15:01:27.323Z': ('W', '10.50'),
    '2026-04-17T13:01:25.299Z': ('L', '-0.0015'),
    '2026-04-17T15:01:23.358Z': ('L', '-0.43'),
}

path = '/home/ubuntu/trading-data/trade_log/trades.csv'
rows = []
with open(path, newline='') as f:
    reader = csv.reader(f)
    for row in reader:
        if row and row[0] in updates:
            result, pnl = updates[row[0]]
            row[10] = result
            row[11] = pnl
            # Clean monitor_bug tag from notes
            notes = row[12]
            for tag in [';[monitor_bug', ';[SL_hit', ';[ORDER_REJECTED']:
                idx = notes.find(tag)
                if idx >= 0:
                    notes = notes[:idx]
            row[12] = notes
            print(f'Updated {row[0]} {row[2]}: result={result} pnl={pnl}')
        rows.append(row)

with open(path, 'w', newline='') as f:
    writer = csv.writer(f)
    writer.writerows(rows)

print('Done.')
