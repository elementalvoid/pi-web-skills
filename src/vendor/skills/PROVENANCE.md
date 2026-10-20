# Vendored upstream provenance

- Source: <https://github.com/vercel-labs/skills>
- Commit: `a80e4c9d12d607631249d4d7d059f835d4b2f13a` (v1.7.4)
- Vendored on: 2026-02-14
- Selection rationale: `docs/upstream-parity.md`

These files are copied verbatim from upstream at the commit above. The published
`skills` package has no import entry point, so this backport is the only way to
reuse the pinned pure modules.

**Do not edit these files.** They are a backport, not a fork. If behaviour must
change, wrap or replace it at the operation layer (`src/operations/`,
`src/upstream/`). When upstream ships an exported API, the operation layer can be
replaced without UI changes. The `sha256` column is verified by
`test/vendor.test.ts`, so an edit fails the suite.

## Files

| File | sha256 |
| --- | --- |
| source-parser.ts | d498dbe96231b85d6bab7412d3f16173d0f52f5756360a906fd6efdc4a906b75 |
| github-host.ts | 7ad9205a2607265c68b1e9427181d9bcea527d8837d29667d882da4f008da428 |
| blob.ts | fb4fb9d64de8c95a754300517ab095f23722c03daa417814344375f0da29ea71 |
| skills.ts | 6ec366e2a4f48767b3532c3dfa09cfb31857c8bb7c94ab109d5dfff0855ab371 |
| frontmatter.ts | 334bd80599ef7d5c5fc25a7d673af7c13b0623a446bcbb34d69be3a82ed796c8 |
| sanitize.ts | 15dc30bf79983cdc4fb84a0aa6283ce4a0abfdc4262902fc6b1f7dc4df654e18 |
| constants.ts | fc01e4591a3f7da665eca6cbda19cd2913c66bf2704f26adb6be2dfd7cf0c867 |
| plugin-manifest.ts | 814ef4b6a66a96c0b8476c38b3f3dab0d5ea72822408a9fa37db40f039adbf48 |
| skill-lock.ts | fcf628f8af6c637c4348bdaeeb2833f1705ee2ccd1772935e2ae350340cc635d |
| local-lock.ts | c959b502391b1c252e350a82b55094f0e225755c43c6bfae6412b654c8b47686 |
| update-source.ts | 2a7589c819563b0afb1d8f05b48f0ba77a1eaa6bae3dd1f464914391fac32a6e |
| types.ts | 0f444746b0ef0da541e23184f401eb0da81b3abad217c934e89cc54970c84d9c |
| LICENSE | 661142e53c313d2bb5e1b055f5c0a39001450ff1b5e27b89dc4bc7de9a6352ca |

## Not vendored

`add.ts`, `update.ts`, `remove.ts`, `cli.ts` (prompts, `process.exit`, ANSI
output, telemetry), `agents.ts` (Pi is hard-coded), `installer.ts` (replaced by a
safe copier), `telemetry.ts`.
