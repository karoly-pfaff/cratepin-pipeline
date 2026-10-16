# Cratepin documentation

Start with [installation and checked CLI/API recipes](recipes.md), then the
[Vite consumer example](../examples/vite-consumer/README.md) and
[project integration guide](integration.md).

- [Configuration](contracts/config.md): paths, profiles, credentials and resource limits.
- [CLI](contracts/cli.md): commands and accepted flags.
- [Data contracts](contracts/data.md): source locks, cache records and runtime manifests.
- [Errors](contracts/errors.md): API failures, stable codes and exit statuses.
- [Reports](contracts/reports.md): operation outcomes, text/JSON rendering and redaction.
- [Storage ports](contracts/storage.md): read/write interfaces, integrity and cancellation.
- [Image profiles](guides/images.md): format, geometry, alpha, colour and special media.
- [R2 and credentials](guides/r2.md): author uploads and build-side reads.
- [Cache and output safety](guides/safety.md): ownership, concurrency and publication recovery.
- [Backup and rollback](operations.md): retaining and restoring released inputs.
- [Read-only remote retention API](retention.md): complete release roots and dry-run plans.

Use Node 24 on Windows or Linux, including WSL. Generated assets run independently of the
developer tool; the host application must validate its own browser, mobile and print output.

## Contributing

For changes to Cratepin's source code, see the [contribution guides](contribution/README.md).
They cover development and coding-agent rules; reading them is not required to use the tool.
