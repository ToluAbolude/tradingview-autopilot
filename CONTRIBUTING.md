# Contributing

The repository includes a TradingView MCP/CLI bridge, strategy research, and automated execution adapters. Contributions may improve any of these components. Preserve attribution to the original tradingview-mcp project.

## Development

Use Node.js 20 or newer:

```sh
npm ci
npm test
```

`npm test`, `test:unit` and `test:all` run the complete offline suite. They do not require TradingView, broker credentials, or network access. The runner discovers top-level `tests/*.test.js` / `*.test.mjs` (excluding E2E), `scripts/trading/lib/*.test.mjs`, and `scripts/trading/institutional/*.test.mjs`.

`npm run test:external` explicitly sends sample Pine source to TradingView's compile API. `npm run test:e2e` requires a logged-in TradingView app on CDP port 9222 and may change app state. Use a disposable chart for E2E. Neither command belongs in default offline CI.

GitHub Actions runs the offline suite on Windows and Ubuntu with Node 20, 22 and 24.

## Engineering expectations

- Put shared trading logic in `scripts/trading/lib/`; strategy modules produce signals and leave execution to the common broker path.
- Keep entry checks closed when required account, exposure, price or persistence state is unavailable. Keep risk-reducing exits independent of entry gates.
- Add regression tests for meaningful failures such as broker errors, invalid equity, concurrent submissions or lost acknowledgments. Test production functions rather than copies.
- Use fake transports or injected dependencies for broker tests. Never place real orders from tests or CI.
- Preserve strategy ownership and the attempt ledger. A timeout does not establish that an order was rejected.
- Never commit credentials, session tokens or private runtime data. Document new external data flows and configuration.
- Keep the README consistent with the code. Distinguish dry runs from modes that can route orders through another integration.

## Pull requests

Explain the resulting behavior, why it is needed, and checks run. Call out operational changes such as stricter rejection, lock recovery, precision or configuration. Only claim live verification when it was actually performed in an appropriate account.
