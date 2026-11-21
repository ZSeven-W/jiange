# Changelog — @jiange/ooxml

## [0.2.0] - 2026-11-21

### Added & Changed
- Added async DEFLATE ZIP compression (`createZipAsync`) via native `CompressionStream("deflate-raw")` with automatic STORE fallback.
- Added configurable entry and size bounds for ZIP reading.
- Marked package `sideEffects: false` and achieved 100% V8 unit test coverage.
