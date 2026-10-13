# Performance

Measured on one sheet with 1,000,000 rows and 10 columns (a 160 MB CSV), on an Apple M4 laptop with 16 GB of memory that was busy with other work. A small VPS takes longer on the big jobs, but the waits stay short because those jobs work in batches. "Others waited" is the longest any other request had to wait while the action ran.

| Action | Time | Others waited | Peak memory |
|---|---|---|---|
| Import the CSV | 24 s | 0.1 s | 420 MB |
| Open the sheet | 0.07 s | none | 300 MB |
| Scroll to the middle or the end | 0.1 to 0.2 s | none | 480 MB |
| Edit a cell | 0.05 to 0.1 s | none | 490 MB |
| Filter a column by "contains" | 0.6 s | none | 560 MB |
| Add a column | 0.05 s | none | 510 MB |
| Rename a column | 5 s | 0.07 s | 620 MB |
| Delete a column | 0.8 s | 0.02 s | 890 MB |
| Sort every row by a column | 24 s | 0.15 s | 680 MB |
| Export to CSV | 2.7 s | 0.04 s | 590 MB |
| Receive a webhook (adds row 1,000,001) | 0.08 s | 0.04 s | 850 MB |
| Start an HTTP run on every row | answers in 0.1 s; the run starts 2.8 s later | 0.08 s | 890 MB |
| Stop that run | answers in 0.03 s; leftover cells clear 3.2 s later | 0.04 s | 620 MB |
| Start an enrichment with "Only run if" (158,000 rows match) | answers in about 1 s; the rows are ready 2.8 s later | 0.04 s | 440 MB |
| Add a column from stored answers (900,000 answers over 20,000 auto-run runs) | 13 s | 0.17 s | 450 MB |
| Rename an enrichment column with 20,000 runs | 6.9 s | 0.18 s | 495 MB |

The database for this sheet is 600 MB on disk.

While a big job (import, sort, column rename or delete, preparing a run's rows) works on a sheet, other changes to that sheet wait for it: your cell edits stay queued and save when it finishes, and anything else gets a "this sheet is busy" message. Other sheets are not affected. If Cubex stops in the middle of one of these jobs, it finishes it (or, for an import, removes the partly imported rows) the next time it starts.
