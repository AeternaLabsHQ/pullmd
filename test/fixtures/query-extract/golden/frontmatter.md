---
title: Acme Sync Server Documentation
url: https://example.com/acme-sync
source: readability
fetched: 1970-01-01T00:00:00.000Z
quality: 1
author: Acme Docs Team
description: Installation, configuration and operations manual.
share_id: 00000000
---

# Acme Sync Server Documentation

Acme Sync Server is a self-hosted synchronization service for structured documents. It exposes a small HTTP API, ships as a single binary, and stores its state in an embedded database. This page covers installation, configuration, usage, deployment and troubleshooting for the 4.x release line.

The documentation assumes basic familiarity with the command line. All examples are written for Linux but work identically on macOS. Windows users should adapt the paths accordingly and use PowerShell equivalents where noted.

## Installation

Acme Sync Server can be installed from the official package registry or built from source. The recommended path for most users is the package registry, which ships signed release artifacts for all supported platforms.

```bash
# install the latest stable release
npm install -g acme-sync-server

# or pin a specific version
npm install -g acme-sync-server@4.2.1
```

After installation, verify the binary is on your PATH and reports the expected version before continuing with configuration.

### Requirements

The server has intentionally minimal requirements so it can run on small virtual machines and single-board computers.

- Node.js 20 or later (LTS recommended)
- 512 MB of available memory for typical workloads
- A writable data directory for the embedded database
- Outbound network access for federation (optional)

### Building from source

Building from source is only needed when you want unreleased fixes. Clone the repository, install dependencies, and run the build script. The resulting artifact is functionally identical to the published package and passes the same test suite.

## Configuration

All configuration is provided through environment variables or an optional configuration file. Environment variables always take precedence over file-based settings, which makes container deployments straightforward.

### Environment variables

The following variables control the core behavior of the server. Unset variables fall back to the documented defaults.

| Variable | Default | Description |
| --- | --- | --- |
| `ACME_PORT` | `8080` | TCP port the HTTP listener binds to |
| `ACME_DATA_DIR` | `./data` | Directory for the embedded database files |
| `ACME_LOG_LEVEL` | `info` | One of `debug`, `info`, `warn`, `error` |
| `ACME_MAX_BODY` | `1mb` | Maximum accepted request body size |
| `ACME_FEDERATION` | `false` | Enables the federation subsystem |
| `ACME_TOKEN_TTL` | `86400` | Access token lifetime in seconds |

Changes to environment variables require a process restart. The server does not watch for changes at runtime, by design, to keep the startup path deterministic.

### Configuration file

For setups with many options, a YAML configuration file can be passed with the `--config` flag. Keys mirror the environment variable names in lowercase.

```yaml
# acme-sync.yaml
# lines starting with a hash are comments, not headings
port: 8080
data_dir: /var/lib/acme-sync
log_level: warn
federation:
  enabled: true
  peers:
    - https://peer-one.example.net
    - https://peer-two.example.net
```

The configuration file is read once at startup. Malformed YAML aborts the start with a non-zero exit code and a parse error that names the offending line.

## Usage

The primary interface is the HTTP API. A small CLI wraps the most common operations for interactive use and shell scripting.

### CLI examples

```bash
# push a document tree to the server
acme-sync push ./notes --remote https://sync.example.net

# pull the latest state into a working directory
acme-sync pull --remote https://sync.example.net ./notes

# show the sync status of a directory
acme-sync status ./notes
```

Every CLI command exits with code zero on success and prints machine-readable JSON when the `--json` flag is set, which makes it easy to embed in cron jobs and CI pipelines.

### HTTP API

The API is versioned under the `/v1` prefix. Authentication uses bearer tokens issued by the `/v1/auth/token` endpoint. All payloads are JSON and all timestamps are RFC 3339 strings in UTC. Pagination uses opaque cursors rather than page numbers, so clients should treat cursor values as black boxes and never construct them manually.

Rate limiting applies per token with a default budget of one hundred requests per minute. Responses carry the usual rate-limit headers so well-behaved clients can back off before hitting the hard limit.

## Deployment

For production use, run the server behind a reverse proxy that terminates TLS. The binary deliberately does not implement TLS itself. Both nginx and Caddy are known-good choices and example snippets ship in the repository.

A container image is published for every release. Kubernetes users should mount the data directory on a persistent volume claim and set resource limits generously above the observed working set, because the embedded database maps its files into memory.

Zero-downtime upgrades are supported between patch releases of the same minor version. For minor and major upgrades, take a snapshot of the data directory first and follow the migration notes in the changelog.

## Troubleshooting

Most operational problems fall into one of the categories below. When reporting a bug, always include the output of the diagnose command and the last fifty log lines.

### Database is locked

When a second process points at the same data directory, the embedded database refuses to open and logs a locked error. This most commonly happens when a stale process survived a failed shutdown, or when two container replicas accidentally share one volume. Stop the extra process, or give each replica its own volume; the server is single-writer by design and will not arbitrate concurrent writers.

### High memory usage

Memory grows with the number of concurrently synchronized trees. If the resident set exceeds your limits, lower the sync concurrency setting, or split large trees into smaller ones. Memory-mapped database files can make the reported resident set look larger than the actual heap, so prefer working-set metrics over RSS when sizing containers.

### Federation peers unreachable

Peer connectivity errors are logged with the peer URL and the underlying socket error. Verify DNS resolution from inside the deployment environment, confirm the peer allows inbound connections from your egress address, and check that both sides run compatible protocol versions.

## FAQ

- **Can I run multiple replicas against one database?** No. The embedded database is single-writer; run one replica per data directory.
- **Is there a hosted version?** No, the project is self-hosted only.
- **How do I back up?** Snapshot the data directory while the server is stopped, or use the built-in snapshot endpoint which produces a consistent copy while running.
- **Which license applies?** The server is released under the AGPL, the CLI under the MIT license.

The project is developed in the open and welcomes issue reports as well as documentation fixes.
