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
| Fill a lookup column from another sheet of 1,000,000 rows, by "is exactly" (that column's index built in 7 s, then the fill) | 17 s | 0.06 s | 770 MB |
| Another lookup on the same column of that sheet (its index already built) | 6.4 s | 0.04 s | 660 MB |
| A lookup that counts the matching rows, 5,000 matches for each value | 12 s | 0.05 s | 860 MB |
| A lookup by "contains", company names in both sheets (the text index built in 51 s, then the fill) | 60 s | 0.11 s | 770 MB |
| Check for duplicates, 300,000 rows repeating an email (by email 2.6 s, as plain text 2.1 to 2.5 s, by domain 3.3 to 3.5 s, by phone 5.6 to 7.7 s, three columns 5.2 to 6.9 s, keeping the most filled-in row 6.3 to 12.9 s) | 2 to 13 s | 0.04 to 0.14 s | 950 MB |
| Remove those 300,000 duplicate rows (two runs) | 18 to 30 s | 0.4 to 0.5 s | 970 MB |
| Search: the first match of a common name, or the next one 900,000 rows in | 0.03 s | none | 470 MB |
| Search: a text found only near the end (the grid then shows that part of the sheet in 0.05 s) | 0.4 s | 0.01 s | 470 MB |
| Search: a text in no cell (0.3 s; 1.1 s for letters a quick text check can't fold, such as Cyrillic or "ß"), or one that is also a column name (1.8 s) | 0.3 to 1.8 s | 0.01 to 0.04 s | 470 MB |
| Search count: "3 of 1,240" (stops at 10,000 matches, 0.05 s; a rare text reads the whole sheet) | 0.05 to 0.35 s | 0.01 s | 470 MB |
| Search in a filtered view (Country is Germany, 33,000 rows), going on from row 990,000 | 0.65 s | 0.01 s | 560 MB |
| An agent counting rows per value (`group_by` Industry, 30 values; while a big job holds the sheet it answers busy at once) | 1.0 s | 0.01 s | 470 MB |
| `group_by` two columns (900 groups) with sum, average, min, max and a count | 2.5 s | 0.02 s | 480 MB |
| The sum of a column over every row | 0.8 s | 0.01 s | 480 MB |
| `group_by` a column of a million different emails (stops past 100,000 groups) | 0.2 s | 0.01 s | 550 MB |
| "Is any of" listing a column's values with counts (0.7 s in a filtered view) | 1.0 s | 0.01 s | 560 MB |

The database for this sheet is 600 MB on disk. The filter rows were measured on a sheet like it with an AI column and an enrichment (a status column and two outputs), each with 20,000 runs.

Search, counts per value and the "Is any of" list were measured on a sheet of 1,000,000 rows and 11 columns (a 670 MB database) with an AI column and an enrichment status column. Search first drops the rows that can't match with one quick check of each row's text, then reads only the rest; a text that is also a column name passes that check everywhere, which is why it takes longer.

A filter has to check every row to count the matches, so a filtered read takes about half a second at a million rows. It checks them a slice at a time, about 25 ms each, so other requests keep being answered meanwhile.

Lookups were measured with two sheets of 1,000,000 rows, one looking up the other. The column a lookup reads in the other sheet gets an index, built in the background the first time: about 70 MB for a million short values, 175 MB with contains. Writing to that sheet costs a little more while it's looked up: changing another of its columns takes 15 to 30% longer in a big run, and a sheet nobody looks up pays nothing measurable. After a sort of a looked-up sheet, the index reads every row's new position again in the background (about 2 to 7 s at a million rows), and lookups into that sheet wait until it has. Contains on a million different values against a million rows depends on the words: about a minute for company names, more when every value shares the same few letters.

While a big job (import, sort, column rename or delete, cleaning a column, filling a formula or lookup column, removing duplicates, preparing a run's rows) works on a sheet, other changes to that sheet wait for it: your cell edits stay queued and save when it finishes, and anything else gets a "this sheet is busy" message. Other sheets are not affected. If Cubex stops in the middle of one of these jobs, it finishes it (or, for an import, removes the partly imported rows) the next time it starts.
