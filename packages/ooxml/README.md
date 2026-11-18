# @jiange/ooxml

Internal headless ZIP and XML utilities shared by the document and spreadsheet SDKs. ZIP reading enforces entry limits and checks CRC; XML rejects DTDs. These primitives do not implement a complete Office document format. DEFLATE input requires a host providing `DecompressionStream("deflate-raw")`. The package is private and is not published.

## License

Free for personal and commercial use. If an enterprise modifies or creates derivative works from this SDK, it must publicly attribute Jiange SDK (`https://github.com/ZSeven-W/jiange`) as the source. See [LICENSE](../../LICENSE) for full terms.
