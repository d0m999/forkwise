# Forkwise (见岔)

[![License](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](LICENSE)
[![English](https://img.shields.io/badge/lang-English-blue.svg)](README.md)
[![简体中文](https://img.shields.io/badge/lang-简体中文-green.svg)](README.zh-CN.md)

**Forkwise** (见岔) is a personal reasoning workbench whose first domain is **investment research**. It helps you map the reasoning chain behind a point of view, verify it against public sources within the current research task, and then let you research and edit premises, inferences, and conclusions directly on a single canvas.

- **Understand an author's argument**: reconstruct a source's claims, premises, and inference relations into a traceable structure, where every claim links back to concrete material and precise source anchors.
- **Organize your own reasoning**: build your own research items on top of candidate references, keeping the author's argument, AI inferences, and your personal argument clearly separated, each with its own versions and rationale.
- **What it does *not* do**: no automated trading, no "truth scores" or scenario probabilities, and no promises of investment returns. Evidence and condition calculations only describe the state of the material and conditions; they do not prove that an entire argument holds.

> ⚠️ This project is at an **early research stage**. It is a workbench for the author to run their own real research workflow and is not yet a stable product for external users. For scope and acceptance boundaries, refer to the documentation in this repository.

## Quick start

The project consists of a local backend (Node + Hono + SQLite) and a browser workbench, both running on your own machine. For detailed installation, configuration, and startup steps, see [backend/README.md](backend/README.md).

Brief flow:

```sh
cd prototype/canvas-lab && npm ci        # install canvas frontend dependencies first
cd ../../backend && npm ci              # then install backend dependencies
npm run build                           # build canvas + backend
npm start                               # start; defaults to http://127.0.0.1:8787
```

Requires Node.js >= 22.22.2 (the first implementation actually used 24.4.1). Real model calls require a local [Ollama](https://ollama.com) instance with an explicitly version-tagged model. See [backend/README.md](backend/README.md) for more runtime and configuration details.

## Repository layout

| Path | Description |
| --- | --- |
| `backend/` | Local HTTP API, SQLite persistence, persistent research tasks, local MCP, and a research workbench that embeds Excalidraw components |
| `public-data-core/` | Fetch adapters and validation rules for public data sources (e.g., SEC EDGAR) |
| `prototype/` | Research and interaction prototypes, including Excalidraw canvas experiments and step-by-step archives |
| `docs/` | Requirements (PRD), domain model, design interview, ADRs, and open-source research |
| `docs/adr/` | Architecture Decision Records (ADRs) |
| `docs/research/` | Research findings on open-source libraries and reference products |

Terminology and domain concepts use [CONTEXT.md](CONTEXT.md) as the single source of truth; engineering and product trade-offs are recorded in [docs/design-interview.md](docs/design-interview.md) and [docs/adr/](docs/adr/).

## Tech stack

- **Backend**: Node.js + [Hono](https://hono.dev), with OpenAPI as the single contract between frontend and backend
- **Storage**: single-file SQLite (relational tables + built-in FTS5)
- **Frontend / canvas**: production uses [React Flow](https://reactflow.dev); the prototype stage integrates [Excalidraw](https://excalidraw.com)
- **Models**: local Ollama (text research + multimodal transcription), with configurable provider adapters
- **Testing**: TypeScript + Vitest, plus separate browser and protocol-level check scripts

## Documentation

- Requirements and change log: [投资推理图谱_PRD_v0.2.md](投资推理图谱_PRD_v0.2.md)
- Domain terminology: [CONTEXT.md](CONTEXT.md)
- Domain model: [docs/domain-model.md](docs/domain-model.md)
- Design interview and confirmed decisions: [docs/design-interview.md](docs/design-interview.md)
- Architecture decisions: [docs/adr/](docs/adr/)
- Open-source and reference-product research: [docs/research/open-source-landscape.md](docs/research/open-source-landscape.md)

## License

This project is licensed under the [Apache License 2.0](LICENSE). Copyright © 2026 mempAw.

Apache-2.0 permits free use, modification, commercial use, and redistribution, while requiring that the copyright and license notices be retained, modifications be marked, and any NOTICE file be included. See [CONTRIBUTING.md](CONTRIBUTING.md) for the clause stating that contributions are licensed under the same terms by default. The project also bundles third-party components under their own licenses; see [NOTICE](NOTICE) for the main license list.

## Code of Conduct

Participation in this project is governed by [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## Security

If you discover a security issue, please do **not** open a public issue; instead follow the private reporting process described in [SECURITY.md](SECURITY.md).
