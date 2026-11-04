# Contributing

Thanks for helping set the table.

## Ground rules

- **Protocol first.** A change that touches wire format, ledger entries, task states or error codes starts as an edit to [SPEC.md](SPEC.md) and the matching file in [`schemas/`](schemas/). Code follows the spec, not the other way round.
- **Keep Table Core the only writer.** New behavior must replay exactly from the ledger.
- **No credentials at the table.** Anything that would let the table host act for an owner does not belong in this repo.
- Keep pull requests small and focused, with a test for each behavior change.

## Development

```bash
npm install
npm run typecheck
npm test
npm run demo:scripted     # offline end-to-end run
```

`npm run demo:mcode` needs `mcode` on `PATH` and a MiniMax API key in `MINIMAX_BENCH_KEY`. Never commit keys, owner key files (`*.owner.json`), seat files or `data/` directories.

## Figures

Figures live in [`docs/assets/`](docs/assets/) as `.excalidraw` sources next to their PNGs. Edit the source at [excalidraw.com](https://excalidraw.com), export a PNG at 2x, and commit both. Labels must match the code and SPEC.md exactly.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
