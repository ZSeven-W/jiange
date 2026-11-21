# Changelog — github.com/ZSeven-W/jiange/sdk/go-pgstore

## [0.2.0] - 2026-11-21

### Added
- Initial release of the optional zero-third-party-dependency PostgreSQL `storage.Store` adapter targeting Go's standard `database/sql` package with native PostgreSQL `$1..$N` placeholders.
- Added `New`, `WithTableName` (strict `^[a-z_][a-z0-9_]*$` validation), `EnsureSchema`, `TableName`, and full `storage.Store` (`Get`, `Put`, `Delete`, `List`) implementation with atomic optimistic concurrency control.
- Added in-process mock `database/sql/driver` test suite achieving 100.0% statement coverage with `-race`, including end-to-end `sdk/go/server.New` integration tests.
