# SQLite database tabs

Double-click a `.db`, `.sqlite`, `.sqlite3`, or `.db3` file to open a database tab.
Vesperwind checks the `SQLite format 3` header (including its terminating NUL)
and opens the schema with SQLite before accepting the file. A renamed text file,
an invalid database, or a missing file produces an error instead of a new database.

Local files, mounted disks and mounted network shares use the existing local
provider. Opening a cloud placeholder goes through the normal content preparation
and permission flow. SFTP/FTP/FTPS databases are not opened for editing: downloading
a database without its current WAL is not a consistent snapshot.

The native backend uses the bundled rusqlite engine. Browser/SEA uses Node's
built-in SQLite in a separate process; SQL editing requires Node.js 24.10 or newer.
Neither backend transfers the entire database to the WebView. SQLite accesses the
original database and its journal/WAL through its normal locking protocol.

## Data, structure and SQL

- **Data** displays tables and views in pages of 500 rows.
- **Structure** displays columns, primary keys, defaults, foreign keys, indexes
  and the object's SQL definition.
- **SQL** uses Monaco with the editor's font and theme settings. Run SQL or
  Cmd/Ctrl+Enter executes the current selection, or the entire script when there
  is no selection. SQLite parses statements, including trigger bodies and quoted
  semicolons. Each statement has its own result, selectable above the result table.

SQL supports INSERT, UPDATE, DELETE and schema changes. Changes are written when
SQLite commits them; there is no separate Save button. Statements normally commit
individually. Use BEGIN and COMMIT/ROLLBACK for an explicit transaction, including
across runs; the toolbar indicates an open transaction and exposes both actions.
Closing a database tab rolls back a transaction that has not been committed.

A script stops at its first error. Statements committed earlier in the script
remain committed. The schema refreshes after a run, including a failed run.

## Bounds and cancellation

Results preview at most 500 rows per statement and 4 MiB per run. Long text cells
and BLOB values show bounded previews; 64-bit integers retain their exact decimal
representation, and NULL remains distinct from an empty string. Preview limits do
not interrupt a write statement with RETURNING: it executes completely even when
only some returned rows are displayed. Scripts accept up to 100 statements and
1 MiB of SQL.

**Stop**, or the 30-second execution deadline, closes the session and rolls back
any uncommitted transaction. Already committed statements remain committed.
Use **Reopen database** to continue. Native cancellation interrupts SQLite's VM;
Node/SEA terminates the separate database process, keeping the server responsive.
Each database session allows one active request and releases its connection when
its tab closes; socket disconnect also releases Node sessions.

SQL is scoped to the opened database. ATTACH, DETACH, loading extensions,
VACUUM INTO and file-writing/reading extension functions are unavailable. Ordinary
VACUUM is supported. Browser paths use the normal FILE_MANAGER_ROOT containment
checks; native paths use the established filesystem and content access checks.

## Verification

Backend regression tests cover file validation, typed results, schema inspection,
DDL/DML scripts, trigger parsing, explicit transactions, full RETURNING execution,
external-file rejection and cancellation with rollback. UI acceptance uses a
separate temporary database, rather than an application or user database.
