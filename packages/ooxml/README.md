# @jiange/ooxml

Internal headless ZIP and XML utilities shared by the document and spreadsheet SDKs. ZIP reading enforces entry limits and checks CRC; XML rejects DTDs. These primitives do not implement a complete Office document format. DEFLATE input requires a host providing `DecompressionStream("deflate-raw")`. The package is private and is not published.
