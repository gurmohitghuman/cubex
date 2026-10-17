# Performance

Measured on one sheet with 1,000,000 rows and 10 columns (a 160 MB CSV), on an Apple M4 laptop with 16 GB of memory that was busy with other work. A small VPS takes longer on the big jobs, but the waits stay short because those jobs work in batches. "Others waited" is the longest any other request had to wait while the action ran.

| Action | Time | Others waited | Peak memory |
|---|---|---|---|
| Import the CSV | 24 s | 0.1 s | 420 MB |
| Open the sheet | 0.07 s | none | 300 MB |
| Scroll to the middle or the end | 0.1 to 0.2 s | none | 480 MB |
| Edit a cell | 0.05 to 0.1 s | none | 490 MB |
| Filter a column by "contains" | 0.6 s | 0.02 s | 580 MB |
| Filter a run column to its failed rows ("Rows with errors"), at the top or 150,000 rows in | 0.6 s (0.9 s on an enrichment output, which reads its status column) | 0.02 s | 580 MB |
| An agent counting the rows where any run failed (`has_error` over 4 run columns, 216,667 rows) | 1.2 s | 0.02 s | 570 MB |
| An agent reading a page of those rows, at the start or 900,000 rows in | 0.01 s | 0.01 s | 560 MB |
| Download those 216,667 rows as CSV (`create_download_link` with `where`) | 1.4 s | 0.01 s | 620 MB |
| Copy 8,334 rows a `where` picks to another sheet (`transfer_rows`, one transaction) | 0.8 s | 0.8 s | 570 MB |
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
| Clean a column into a new one (emails 6 s, domains 6.5 s, company names 7 s, names 10 s, phone numbers 11 s) | 6 to 11 s | 0.15 s | 750 MB |
| Fill a formula column (two columns joined 6.8 s, the work email picked out of a JSON response 8.5 s, a Lodash formula 10.8 s) | 7 to 11 s | 0.06 s | 680 MB |
| A formula that hangs on every row (it stops itself after 3 rows) | 1.2 s | 0.31 s | 710 MB |
| Check for duplicates, 300,000 rows repeating an email (by email 2.6 s, as plain text 2.1 to 2.5 s, by domain 3.3 to 3.5 s, by phone 5.6 to 7.7 s, three columns 5.2 to 6.9 s, keeping the most filled-in row 6.3 to 12.9 s) | 2 to 13 s | 0.04 to 0.14 s | 950 MB |
| Remove those 300,000 duplicate rows (two runs) | 18 to 30 s | 0.4 to 0.5 s | 970 MB |

The database for this sheet is 600 MB on disk. The filter rows were measured on a sheet like it with an AI column and an enrichment (a status column and two outputs), each with 20,000 runs.

A filter has to check every row to count the matches, so a filtered read takes about half a second at a million rows. It checks them a slice at a time, about 25 ms each, so other requests keep being answered meanwhile.

While a big job (import, sort, column rename or delete, cleaning a column, filling a formula column, removing duplicates, preparing a run's rows) works on a sheet, other changes to that sheet wait for it: your cell edits stay queued and save when it finishes, and anything else gets a "this sheet is busy" message. Other sheets are not affected. If Cubex stops in the middle of one of these jobs, it finishes it (or, for an import, removes the partly imported rows) the next time it starts.
