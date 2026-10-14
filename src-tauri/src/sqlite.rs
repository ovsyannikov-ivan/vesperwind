use crate::error::NativeError;
use rusqlite::{
    config::DbConfig,
    fallible_iterator::FallibleIterator,
    hooks::{AuthAction, AuthContext, Authorization},
    types::ValueRef,
    Batch, Connection, InterruptHandle, OpenFlags,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs::File,
    io::Read,
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};

const MAX_ROWS: usize = 500;
const MAX_RESULT: usize = 4 * 1024 * 1024;
const MAX_SQL: usize = 1024 * 1024;
const TIMEOUT: Duration = Duration::from_secs(30);
fn error(message: impl Into<String>) -> NativeError {
    NativeError::new("ESQLITE", message)
}
fn sql_error(e: rusqlite::Error) -> NativeError {
    error(e.to_string())
}
fn quote(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    pub session_id: String,
    pub action: String,
    pub sql: Option<String>,
    pub table: Option<String>,
    pub offset: Option<u64>,
}
impl Request {
    fn validate(&self) -> Result<(), NativeError> {
        if self.session_id.is_empty()
            || self.session_id.len() > 128
            || !self
                .session_id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        {
            return Err(error("Invalid database session"));
        }
        match self.action.as_str() {
            "schema" => {}
            "query" => {
                if !self.sql.as_ref().is_some_and(|s| {
                    !s.trim().is_empty() && s.len() <= MAX_SQL && !s.contains('\0')
                }) {
                    return Err(error(
                        "SQL must contain between 1 byte and 1 MiB, without NUL characters",
                    ));
                }
            }
            "structure" | "data" => {
                if !self
                    .table
                    .as_ref()
                    .is_some_and(|s| !s.is_empty() && s.len() <= 4096)
                {
                    return Err(error("Choose a table or view"));
                }
                if self.action == "data" && !self.offset.is_some_and(|n| n <= 1_000_000_000) {
                    return Err(error("Invalid page offset"));
                }
            }
            _ => return Err(error("Unknown database action")),
        }
        Ok(())
    }
}
struct Session {
    db: Mutex<Database>,
    interrupt: InterruptHandle,
    closed: Arc<AtomicBool>,
}
#[derive(Default)]
pub struct SqliteSessions {
    sessions: Mutex<HashMap<String, Arc<Session>>>,
}
impl SqliteSessions {
    pub fn open(&self, id: &str, path: &Path) -> Result<Value, NativeError> {
        Request {
            session_id: id.into(),
            action: "schema".into(),
            sql: None,
            table: None,
            offset: None,
        }
        .validate()?;
        let db = open_database(path)?;
        let objects = schema(&db)?;
        let session = Arc::new(Session {
            interrupt: db.get_interrupt_handle(),
            db: Mutex::new(db),
            closed: Arc::new(AtomicBool::new(false)),
        });
        let mut sessions = self.sessions.lock().unwrap();
        if sessions.contains_key(id) || sessions.len() >= 16 {
            return Err(error("Too many open databases or a duplicate session"));
        }
        sessions.insert(id.into(), session);
        Ok(json!({"ok":true,"objects":objects,"inTransaction":false}))
    }
    pub fn close(&self, id: &str) {
        if let Some(session) = self.sessions.lock().unwrap().remove(id) {
            session.closed.store(true, Ordering::Relaxed);
            session.interrupt.interrupt();
            // Dropping the connection after the worker finishes rolls back an open transaction.
        }
    }
    pub fn run(&self, request: Request) -> Value {
        if let Err(e) = request.validate() {
            return json!({"ok":false,"error":e});
        }
        let session = self
            .sessions
            .lock()
            .unwrap()
            .get(&request.session_id)
            .cloned();
        let Some(session) = session else {
            return json!({"ok":false,"error":{"code":"ESQLITE_CLOSED","message":"The database session ended. Reopen this database."}});
        };
        let Ok(db) = session.db.try_lock() else {
            return json!({"ok":false,"error":{"code":"ESQLITE_BUSY","message":"A query is already running"}});
        };
        let start = Instant::now();
        let closed = Arc::clone(&session.closed);
        if let Err(e) = db.progress_handler(
            1000,
            Some(move || closed.load(Ordering::Relaxed) || start.elapsed() >= TIMEOUT),
        ) {
            return json!({"ok":false,"error":sql_error(e)});
        }
        let output = if session.closed.load(Ordering::Relaxed) {
            Err(error("The database session ended"))
        } else {
            execute(&db, &request)
        };
        let _ = db.progress_handler(0, None::<fn() -> bool>);
        if session.closed.load(Ordering::Relaxed) || start.elapsed() >= TIMEOUT {
            self.close(&request.session_id);
            return json!({"ok":false,"inTransaction":false,"error":{"code":"ECANCELLED","message":"Query stopped; uncommitted changes were rolled back. Reopen this database."}});
        }
        match output {
            Ok(mut value) => {
                value["ok"] = json!(true);
                value["inTransaction"] = json!(!db.is_autocommit());
                value["elapsedMs"] = json!(start.elapsed().as_millis() as u64);
                value
            }
            Err(e) => json!({"ok":false,"error":e,"inTransaction":!db.is_autocommit()}),
        }
    }
}
struct Database {
    db: Connection,
    vacuum: Arc<AtomicBool>,
}
impl std::ops::Deref for Database {
    type Target = Connection;
    fn deref(&self) -> &Connection {
        &self.db
    }
}
impl std::fmt::Debug for Database {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("SQLite database")
    }
}
struct VacuumGuard(Arc<AtomicBool>);
impl Drop for VacuumGuard {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Relaxed);
    }
}
fn open_database(path: &Path) -> Result<Database, NativeError> {
    let mut file =
        File::open(path).map_err(|e| NativeError::from_io(&e, "Unable to open this database"))?;
    if !file
        .metadata()
        .map_err(|e| NativeError::from_io(&e, "Unable to inspect this database"))?
        .is_file()
    {
        return Err(error("This item is not a database file"));
    }
    let mut header = [0_u8; 16];
    if file.read_exact(&mut header).is_err() || &header != b"SQLite format 3\0" {
        return Err(error("This file is not a SQLite 3 database"));
    }
    // Opening never creates a database from a missing/renamed file.
    let check =
        Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(sql_error)?;
    check
        .query_row("SELECT count(*) FROM sqlite_schema", [], |_| Ok(()))
        .map_err(sql_error)?;
    drop(check);
    let db =
        Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_WRITE).map_err(sql_error)?;
    db.busy_timeout(Duration::from_secs(1)).map_err(sql_error)?;
    db.set_db_config(DbConfig::SQLITE_DBCONFIG_DEFENSIVE, true)
        .map_err(sql_error)?;
    db.execute_batch("PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF")
        .map_err(sql_error)?;
    let vacuum = Arc::new(AtomicBool::new(false));
    let allow_vacuum = Arc::clone(&vacuum);
    db.authorizer(Some(move |context: AuthContext<'_>| match context.action {
        AuthAction::Attach { filename }
            if !(filename.is_empty() && allow_vacuum.load(Ordering::Relaxed)) =>
        {
            Authorization::Deny
        }
        AuthAction::Detach { .. } => Authorization::Deny,
        AuthAction::Function { function_name }
            if ["load_extension", "writefile", "readfile"]
                .contains(&function_name.to_ascii_lowercase().as_str()) =>
        {
            Authorization::Deny
        }
        AuthAction::Pragma { pragma_name, .. }
            if [
                "temp_store_directory",
                "data_store_directory",
                "writable_schema",
            ]
            .contains(&pragma_name.to_ascii_lowercase().as_str()) =>
        {
            Authorization::Deny
        }
        _ => Authorization::Allow,
    }))
    .map_err(sql_error)?;
    Ok(Database { db, vacuum })
}
fn schema(db: &Connection) -> Result<Vec<Value>, NativeError> {
    let mut statement = db.prepare("SELECT name,type,sql FROM sqlite_schema WHERE type IN ('table','view') ORDER BY name COLLATE NOCASE").map_err(sql_error)?;
    let values = statement.query_map([], |row| Ok(json!({"name":row.get::<_,String>(0)?,"type":row.get::<_,String>(1)?,"sql":row.get::<_,Option<String>>(2)?}))).map_err(sql_error)?;
    values.collect::<Result<Vec<_>, _>>().map_err(sql_error)
}
fn cell(value: ValueRef<'_>) -> Value {
    match value {
        ValueRef::Null => json!({"type":"null","value":null}),
        ValueRef::Integer(n) => json!({"type":"integer","value":n.to_string()}),
        ValueRef::Real(n) => json!({"type":"real","value":n.to_string()}),
        ValueRef::Text(bytes) => {
            let text = String::from_utf8_lossy(bytes);
            json!({"type":"text","value":text.chars().take(4096).collect::<String>(),"truncated":text.chars().count()>4096})
        }
        ValueRef::Blob(bytes) => {
            json!({"type":"blob","value":bytes.iter().take(64).map(|b|format!("{b:02x}")).collect::<String>(),"bytes":bytes.len(),"truncated":bytes.len()>64})
        }
    }
}
fn execute(db: &Database, request: &Request) -> Result<Value, NativeError> {
    if request.action == "schema" {
        return Ok(json!({"objects":schema(db)?}));
    }
    if request.action == "structure" || request.action == "data" {
        if !schema(db)?
            .iter()
            .any(|o| o["name"].as_str() == request.table.as_deref())
        {
            return Err(error(
                "The table or view no longer exists. Refresh the schema.",
            ));
        }
    }
    if request.action == "structure" {
        let name = request.table.as_ref().unwrap();
        let object = schema(db)?
            .into_iter()
            .find(|o| o["name"].as_str() == Some(name))
            .unwrap();
        let mut columns = db
            .prepare("SELECT * FROM pragma_table_xinfo(?)")
            .map_err(sql_error)?;
        let columns = columns.query_map([name], |r| Ok(json!({"cid":r.get::<_,i64>(0)?,"name":r.get::<_,String>(1)?,"type":r.get::<_,String>(2)?,"notnull":r.get::<_,i64>(3)?,"dflt_value":r.get::<_,Option<String>>(4)?,"pk":r.get::<_,i64>(5)?,"hidden":r.get::<_,i64>(6)?}))).map_err(sql_error)?.collect::<Result<Vec<_>,_>>().map_err(sql_error)?;
        let mut keys = db
            .prepare("SELECT * FROM pragma_foreign_key_list(?)")
            .map_err(sql_error)?;
        let keys = keys.query_map([name], |r| Ok(json!({"id":r.get::<_,i64>(0)?,"seq":r.get::<_,i64>(1)?,"table":r.get::<_,String>(2)?,"from":r.get::<_,String>(3)?,"to":r.get::<_,Option<String>>(4)?,"on_update":r.get::<_,String>(5)?,"on_delete":r.get::<_,String>(6)?}))).map_err(sql_error)?.collect::<Result<Vec<_>,_>>().map_err(sql_error)?;
        let mut indexes = db
            .prepare("SELECT name,sql FROM sqlite_schema WHERE type='index' AND tbl_name=?")
            .map_err(sql_error)?;
        let indexes = indexes
            .query_map([name], |r| {
                Ok(json!({"name":r.get::<_,String>(0)?,"sql":r.get::<_,Option<String>>(1)?}))
            })
            .map_err(sql_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(sql_error)?;
        return Ok(json!({"object":object,"columns":columns,"foreignKeys":keys,"indexes":indexes}));
    }
    let sql = if request.action == "data" {
        format!(
            "SELECT * FROM {} LIMIT 501 OFFSET {}",
            quote(request.table.as_ref().unwrap()),
            request.offset.unwrap()
        )
    } else {
        request.sql.clone().unwrap()
    };
    let mut batch = Batch::new(db, &sql);
    let mut results = Vec::new();
    let mut budget = MAX_RESULT;
    while let Some(mut statement) = batch.next().map_err(sql_error)? {
        if results.len() >= 100 {
            return Err(error("A script may contain at most 100 statements"));
        }
        let columns: Vec<String> = statement
            .column_names()
            .iter()
            .map(|s| s.to_string())
            .collect();
        let source = statement.expanded_sql().unwrap_or_default();
        let source = source.trim().trim_end_matches(';').trim();
        db.vacuum.store(
            source.eq_ignore_ascii_case("VACUUM") || source.eq_ignore_ascii_case("VACUUM main"),
            Ordering::Relaxed,
        );
        let _vacuum_guard = VacuumGuard(Arc::clone(&db.vacuum));
        let before = db.total_changes();
        let mut rows = Vec::new();
        let mut seen = 0;
        let mut truncated = false;
        let mut cursor = statement.query([]).map_err(sql_error)?;
        while let Some(row) = cursor.next().map_err(sql_error)? {
            seen += 1;
            if rows.len() >= MAX_ROWS || budget == 0 {
                truncated = true;
                continue;
            }
            let cells = (0..columns.len())
                .map(|i| row.get_ref(i).map(cell))
                .collect::<Result<Vec<_>, _>>()
                .map_err(sql_error)?;
            let length = serde_json::to_vec(&cells).unwrap().len();
            if length > budget {
                budget = 0;
                truncated = true;
                continue;
            }
            budget -= length;
            rows.push(cells);
        }
        drop(cursor);
        results.push(json!({"columns":columns,"rows":rows,"truncated":truncated,"changes":(db.total_changes()-before).to_string(),"hasMore":request.action=="data" && seen>rows.len()}));
    }
    Ok(json!({"results":results}))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> std::path::PathBuf {
        let path =
            std::env::temp_dir().join(format!("vesperwind-sqlite-{}.db", uuid::Uuid::new_v4()));
        let db = Connection::open(&path).unwrap();
        db.execute_batch("CREATE TABLE sample(id INTEGER PRIMARY KEY, text TEXT, data BLOB); INSERT INTO sample VALUES(9223372036854775807,'Привет',x'00ff'); CREATE VIEW labels AS SELECT text FROM sample;").unwrap();
        path
    }
    fn query(sql: &str) -> Request {
        Request {
            session_id: "test".into(),
            action: "query".into(),
            sql: Some(sql.into()),
            table: None,
            offset: None,
        }
    }
    #[test]
    fn signature_schema_and_missing_file_are_checked() {
        let path = fixture();
        assert!(open_database(&path).is_ok());
        std::fs::remove_file(&path).unwrap();
        assert!(open_database(&path).is_err());
        assert!(!path.exists());
        std::fs::write(&path, b"not a sqlite file").unwrap();
        assert!(open_database(&path)
            .unwrap_err()
            .message
            .contains("not a SQLite"));
        std::fs::write(
            &path,
            [b"SQLite format 3\0".as_slice(), &[0_u8; 100]].concat(),
        )
        .unwrap();
        assert!(open_database(&path).is_err());
        std::fs::remove_file(path).unwrap();
    }
    #[test]
    fn schema_structure_and_typed_rows() {
        let path = fixture();
        let db = open_database(&path).unwrap();
        assert_eq!(schema(&db).unwrap().len(), 2);
        let rows = execute(
            &db,
            &query("SELECT id,text,data,NULL,id AS duplicate,id AS duplicate FROM sample"),
        )
        .unwrap();
        assert_eq!(
            rows["results"][0]["rows"][0][0]["value"],
            "9223372036854775807"
        );
        assert_eq!(rows["results"][0]["rows"][0][1]["value"], "Привет");
        assert_eq!(rows["results"][0]["rows"][0][2]["value"], "00ff");
        assert_eq!(rows["results"][0]["rows"][0][3]["type"], "null");
        let mut request = query("");
        request.action = "structure".into();
        request.table = Some("sample".into());
        assert_eq!(execute(&db, &request).unwrap()["columns"][0]["pk"], 1);
        drop(db);
        std::fs::remove_file(path).unwrap();
    }
    #[test]
    fn scripts_triggers_transactions_and_full_returning_execution() {
        let path = fixture();
        let db = open_database(&path).unwrap();
        execute(&db,&query("CREATE TABLE audit(value); CREATE TRIGGER log AFTER INSERT ON audit BEGIN UPDATE audit SET value=value||';'; END; INSERT INTO audit VALUES('x');")).unwrap();
        assert_eq!(
            db.query_row("SELECT value FROM audit", [], |r| r.get::<_, String>(0))
                .unwrap(),
            "x;"
        );
        execute(&db, &query("BEGIN; UPDATE audit SET value='pending'")).unwrap();
        assert!(!db.is_autocommit());
        execute(&db, &query("ROLLBACK")).unwrap();
        assert!(db.is_autocommit());
        let result = execute(&db,&query("CREATE TABLE many(x); WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<700) INSERT INTO many SELECT x FROM n RETURNING x;")).unwrap();
        assert_eq!(result["results"][1]["rows"].as_array().unwrap().len(), 500);
        assert_eq!(
            db.query_row("SELECT count(*) FROM many", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            700
        );
        execute(
            &db,
            &query("ALTER TABLE many ADD COLUMN extra; DELETE FROM many; VACUUM"),
        )
        .unwrap();
        drop(db);
        std::fs::remove_file(path).unwrap();
    }
    #[test]
    fn external_files_and_extensions_are_denied() {
        let path = fixture();
        let db = open_database(&path).unwrap();
        for sql in [
            "ATTACH ':memory:' AS other",
            "ATTACH '' AS other",
            "SELECT load_extension('missing')",
            "PRAGMA writable_schema=ON",
            "VACUUM INTO 'must-not-create.db'",
        ] {
            assert!(execute(&db, &query(sql)).is_err(), "{sql}");
        }
        drop(db);
        std::fs::remove_file(path).unwrap();
    }
    #[test]
    fn cancellation_interrupts_the_vm_and_rolls_back() {
        let path = fixture();
        let sessions = Arc::new(SqliteSessions::default());
        sessions.open("test", &path).unwrap();
        assert_eq!(
            sessions.run(query("BEGIN; CREATE TABLE not_committed(x)"))["inTransaction"],
            true
        );
        let worker = Arc::clone(&sessions);
        let handle = std::thread::spawn(move || {
            worker.run(query("WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n) SELECT sum(x) FROM n"))
        });
        std::thread::sleep(Duration::from_millis(50));
        sessions.close("test");
        assert_eq!(handle.join().unwrap()["error"]["code"], "ECANCELLED");
        let db = open_database(&path).unwrap();
        assert!(!schema(&db)
            .unwrap()
            .iter()
            .any(|o| o["name"] == "not_committed"));
        drop(db);
        std::fs::remove_file(path).unwrap();
    }
}
