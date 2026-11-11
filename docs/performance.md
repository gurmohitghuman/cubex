# Performance

Measured on one sheet with 1,000,000 rows and 10 columns (a 160 MB CSV), on an Apple M4 laptop with 16 GB of memory that was busy with other work. A small VPS takes longer on the big jobs, but the waits stay short because those jobs work in batches. "Others waited" is the longest any other request had to wait while the action ran.

| Action | Time | Others waited | Peak memory |
|---|---|---|---|
| Import the CSV | 8 to 9.5 s | 0.05 to 0.35 s | 300 MB |
| Open the sheet | 0.07 s | none | 300 MB |
| Scroll to the middle or the end | 0.1 to 0.2 s | none | 480 MB |
| Edit a cell | 0.05 to 0.1 s | none | 490 MB |
| Filter a column by "contains" | 0.6 s | 0.02 s | 580 MB |
| Filter a run column to its failed rows ("Rows with errors"), at the top or 150,000 rows in | 0.6 s (0.9 s on an enrichment output, which reads its status column) | 0.02 s | 580 MB |
| An agent counting the rows where any run failed (`has_error` over 4 run columns, 216,667 rows) | 1.2 s | 0.02 s | 570 MB |
| An agent reading a page of those rows, at the start or 900,000 rows in | 0.01 s | 0.01 s | 560 MB |
| Download those 216,667 rows as CSV (`create_download_link` with `where`) | 1.4 s | 0.01 s | 620 MB |
| A run column's menu counts its rows: empty, out of date (10,000 whose input changed) and failed | 2.6 s | 0.01 s | 510 MB |
| Find those 10,000 out-of-date rows for a rerun (mode `out_of_date`) | 1.5 s | 0.02 s | 510 MB |
| An agent counting out-of-date rows (`where` with `out_of_date`) | 1.8 s | 0.01 s | 520 MB |
| A page of rows with `include_status` (out of date included), 500,000 rows in | 0.001 s | none | 520 MB |
| Copy 8,334 rows a `where` picks to another sheet (`transfer_rows`, one transaction) | 0.8 s | 0.8 s | 570 MB |
| Add a column | 0.05 s | none | 510 MB |
| Rename a column | 5 s | 0.07 s | 620 MB |
| Delete a column | 0.8 s | 0.02 s | 890 MB |
| Sort every row by a column | 24 s | 0.15 s | 680 MB |
| Copy the sheet's values to a new sheet (a sheet sorted since its rows went in takes as long) | 7 to 8.6 s | 0.07 to 0.17 s | 500 MB |
| Export to CSV | 2.7 s | 0.04 s | 590 MB |
| Receive a webhook (adds row 1,000,001) | 0.08 s | 0.04 s | 850 MB |
| Start an HTTP run on every row | answers in 0.1 s; the run starts 2.8 s later (about 1 s more since a run keeps what it overwrites, so it can be undone) | 0.08 s | 890 MB |
| Stop that run | answers in 0.03 s; leftover cells get back what they held before the run, in the background (measured again below) | 0.04 s | 620 MB |
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
| An agent's `get_sheet` with column details (no counts) | 0.03 s | none | 460 MB |
| An agent's `get_sheet` counting filled, empty and error rows (one column 0.7 s, 12 columns 3.6 s) | 0.7 to 3.6 s | 0.04 s | 510 MB |
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

While a big job (import, sort, column rename or delete, cleaning a column, filling a formula or lookup column, removing duplicates, restoring rows from the trash, preparing a run's rows, undoing a run, copying a sheet's values into a new one) works on a sheet, other changes to that sheet wait for it: your cell edits stay queued and save when it finishes, and anything else gets a "this sheet is busy" message. Other sheets are not affected, and a sheet whose values are being copied keeps taking edits and new rows; only the big jobs above say it's busy until the copy is done. If Cubex stops in the middle of one of these jobs, it finishes it (or, for an import, removes the partly imported rows) the next time it starts.

### Date filters and filter groups

Measured with a script on the same laptop while other work ran, on a sheet of 1,000,000 rows and 10 columns whose date column is written five ways (2024-01-31, 1/31/2024, Jan 31, 2024, 31.1.2024, and with a time), with one row in six not a date:

| Action | Time | Others waited |
|---|---|---|
| Count the rows on or after a date (277,623 rows); "contains" on a text column, for comparison, 0.55 s | 0.57 s | 0.01 s |
| The grid's first page and row count with that date filter | 0.57 s | 0.01 s |
| The first page of a date only 457 rows hold | 0.12 s | 0.01 s |
| Groups three deep: (a date and a plan) or (a country and (an industry or a number)) | 0.87 s | 0.01 to 0.03 s |
| Ten date conditions | 1.8 s | 0.01 s |
| One date condition with 20 more turned off | 0.57 s | 0.02 s |
| "Only run if" checking a date rule on every row (`is on or after`) | 0.72 s | 0.02 s |

A date condition costs about what a text one does: reading the cell is most of the work. Each more condition adds about 0.13 s at a million rows, and conditions turned off add nothing.

### Auto-dedupe

Measured with a script on the same laptop while other work ran, on a sheet of 1,000,000 rows keyed by email:

| Action | Time | Others waited |
|---|---|---|
| Turn auto-dedupe on (the keys of the 1,000,000 rows already there read in the background) | 7 to 10 s | 0.02 s |
| Add one row through the API or a webhook (the same with auto-dedupe off: most of it is the row limit check) | 0.03 s | none |
| Type a key into a row | under 0.01 s | none |
| Import 100,000 rows, 10,000 of them already in the sheet, keeping the newest (3 s with auto-dedupe off) | 7.5 to 9.4 s | 0.2 to 0.3 s |

Writing to a sheet without auto-dedupe costs nothing measurable. The keys take about 85 MB for a million emails. While an import's rows are checked, the sheet stays busy, so auto-run doesn't start on rows that are about to go.

### The trash

Deleted rows go to the trash, a slice at a time. Measured with a script on the same laptop while other work ran, on a sheet of 1,000,000 rows and 10 columns (a 1.1 GB database):

| Action | Time | Others waited |
|---|---|---|
| Delete 2,000 selected rows (the grid sends a bigger selection 2,000 rows a call) | 0.09 s | 0.09 s |
| Delete a sheet of 1,000,000 rows (it's hidden at once, kept whole) | 0.05 s | 0.05 s |
| Empty that sheet from the trash (in the background) | 41 s | 0.5 s |
| A CSV import replacing 990,000 rows: the old rows moving to the trash, before the new ones go in | 52 s | 0.7 s |
| Restore those 990,000 rows | 55 s | 0.6 s |
| Empty a batch of 990,000 rows from the trash | 9 s | 0.5 s |

A deleted column goes to the trash the same way: its cells move into the trash 1,000 rows at a time as they leave the rows, each slice followed by a checkpoint of its own. Measured with a script on a 4-core Linux server (AMD EPYC, 8 GB) while other work ran, two runs each, on a sheet of 100,000 rows and 5 columns, the column's 85,714 cells (3.8 MB in the trash) deleted and restored through a running server, which a read of the sheet's first page every 20 ms kept asking:

| Action | Time | Others waited |
|---|---|---|
| Delete a column to the trash (the answer comes once its cells are in) | 1.6 to 1.9 s | 0.03 s |
| The same delete with Settings keeping 0 days, as before (100,000 cells) | 0.75 to 0.8 s | 0.07 s |
| Restore it | answers in 0.01 to 0.03 s (`"state": "restoring"`); the column shows again with every cell 4.4 to 4.7 s later | 0.04 s |

Run in the server's process to time each transaction, on a sheet of 200,000 rows (171,428 cells): a slice of the delete's move held the database at most 12 to 24 ms and a checkpoint 9 to 28 ms, and the whole delete took 2.7 to 3.2 s (1.3 to 1.5 s with nothing kept, in slices of 5,000 rows holding it up to 96 ms). With cells of 2 KB (100,000 rows, 177 MB in the trash) a slice held it at most 68 to 71 ms, against 127 to 140 ms for the delete with nothing kept, and the whole delete took 4.8 to 5.4 s (2.1 to 2.2 s). A restore writes 250 cells a transaction, fewer when clean, formula or lookup columns read the column (each restored cell queues its row for them): its longest transaction took 11 to 16 ms and its longest checkpoint 12 to 29 ms, and the whole restore 5.7 to 6.1 s with no such column, 11 to 17 s with one and 18 to 41 s with three (random row ids the slower end); 6.3 to 6.7 s for the 2 KB cells.

"Stop that run" was measured again with a script on a 4-core Linux server, once a stopped run's cells got back what they held before it: 1,000,000 rows of 10 columns, both of the run's columns holding an earlier answer in every row, stopped before any row ran. The stop answered in 0.02 to 0.03 s, and every cell had its earlier answer back 13.2 to 13.8 s later. On that server the clear that only emptied those cells took 8.3 s (3.2 s on the laptop above). No other request would have waited longer than 0.09 s (0.1 s when the clear only emptied them).

Rows in the trash keep their space in the database until they leave it. The file doesn't shrink then: SQLite reuses the freed space for new rows.

### Undoing a run

Before a run writes a cell, it keeps what the cell held, so the run can be undone. Measured with a script on the same laptop while other work ran, on a sheet of 1,000,000 rows and 12 columns (a 600 MB database), with an HTTP API run filling 2 columns of every row (half of them held an earlier answer):

| Action | Time | Others waited |
|---|---|---|
| Put ⏳ in every row as the run starts (2.5 s without keeping anything) | 3.5 s | 0.03 s |
| Write one row's result (0.035 ms without) | 0.06 ms | none |
| Undo the run: 1,960,000 cells back, 40,000 changed since by a person or another run left as they are (answers at once, then in the background) | 5.2 s | 0.03 s |
| Delete what it kept, once undone (in the background) | 1.2 s | 0.03 s |

What a run keeps takes about 50 bytes a cell when the old values are short, more when they're long: 97 MB for this run. It's kept 7 days after the run starts, then deleted a slice at a time; an undone run's is deleted right away.

A run that is cancelled or fails puts back, from what it kept, the cells of the rows it hadn't reached. Measured with a script on a sheet of 200,000 rows whose every row held an earlier answer, a run cancelled before it reached any row, 7 to 10 times each (in brackets: the same clear emptying those cells instead): putting one column back took 1.4 to 1.6 s in the background (1.0 to 1.2 s) and two columns 2.1 to 2.5 s (1.2 to 1.3 s), in slices of about 21 ms (19 to 25 ms). The longest slice of a clear was 53 to 90 ms for one column (56 to 104 ms) and 56 to 67 ms for two (58 to 94 ms), once 296 ms; each was a commit in which SQLite copied its log back into the database. With 3 formula columns reading the column it took 22 to 25 s, as before (22 s), in slices of up to 41 ms (39 ms) and checkpoints of up to 81 ms (66 ms).


### Setup versions

A setup version holds how a sheet's columns are set up, never a cell, so saving, comparing and restoring one read and write only the setup: their time doesn't grow with the rows. Measured with a script on the same laptop, on a sheet of 1,000,000 rows and 7 columns (an AI, an HTTP API, a formula and a clean column among them):

| Action | Time |
|---|---|
| Save a version | 1 ms |
| Compare a version with the sheet | 2 ms |
| Restore it (an AI and a formula column set up again, the order back, the setup it replaced kept first) | 2 ms |
| Rename a column, with 1 or with 100 versions naming it (the rename itself moves every row's cell) | 3.3 s either way |

A sheet keeps up to 100 versions, each at most 4 MB. At those limits (100 versions of 4 MB on the sheet and 100 more on another sheet, `SETUP_VERSIONS_PERF_MB=4 npm run test:unit -- setup-versions-fences`), listing them takes about 0.2 s (the counts are worked out in SQLite, no version is read whole into the server), and the versions' part of a column rename about 0.2 s when no version names the column (only the versions that can name it are read) and 0.9 s when all 100 do. Versions of a usual size take a millisecond or two.

### Reading rows by id and rows changed since a time

Measured with a script on a 4-core Linux server (AMD EPYC, 8 GB), on a sheet of 1,000,000 rows and 10 columns (a 970 MB database) whose rows came in as an import does, about 110,000 a second, with 20,000 rows edited later:

| Action | Time |
|---|---|
| The upgrade that adds the index on when rows changed (migration 050) | 2.0 to 2.2 s (the index itself 1.6 s, 66 MB) |
| A page of 100 changed rows (`updated_since`), from the start, 550,000 rows in (inside a second 110,000 rows share) or near the end | 0.75 to 1.1 ms |
| The same with `include_status` | 1.3 to 2.1 ms |
| A page of 500 (the REST limit) | 2.5 to 3.2 ms |
| 1,000 rows by id (`row_ids`), spread over the sheet | 11 to 12 ms (17 ms with `include_status`) |
| 1,000 failed rows by id with `include_status`, on a column with 20,000 runs, each row's failure in another run | 84 to 95 ms; 11 to 14 of the 1,000 rows got their run's full message, the rest the cell's words |
| 1 to 1,000 failed rows by id with `include_status`, on a column with 60,000 runs and no result at those rows (a separate small database) | 54 to 94 ms (1.2 s before the look had a time limit) |

Every page reads the index in order: no row outside the page is read and nothing is sorted. Finding a failed cell's full message looks through the column's runs from the newest, and stops after 2,000 lookups or 50 ms, so a read by id never holds the server longer than that for it; on a column with thousands of runs most failures come from older runs and keep the cell's words. The rest of those reads' time is reading the rows and, with `include_status`, the column's runs and their states (about 18 ms at 60,000 runs). Keeping that index up to date has a cost: rewriting every row of the sheet (as a run putting ⏳ in every row, a rename or a clean fill does) took 8.0 to 8.4 s without the index and 11.1 to 11.3 s with it, about a third longer, and the slowest slice of 5,000 rows went from 54 to 55 ms to 112 to 113 ms (two runs, measured with a script that rewrites every row in 5,000-row transactions).
