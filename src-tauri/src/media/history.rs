//! App-owned position history. Only this worker accesses SQLite; player ticks stay in RAM.
use crate::provider_content::ContentSource;
use rusqlite::{params, Connection, OptionalExtension};
use std::{
    path::{Path, PathBuf},
    sync::{mpsc, Mutex},
    thread::{self, JoinHandle},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

pub const RETENTION_DAYS: i64 = 180;
/// UTC seconds; exactly 180 days old survives, only strictly older rows expire.
pub fn retention_cutoff(now: i64) -> i64 {
    now.saturating_sub(RETENTION_DAYS * 24 * 60 * 60)
}
fn timestamp() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
        .min(i64::MAX as u64) as i64
}
fn prune(c: &Connection, now: i64) -> rusqlite::Result<usize> {
    c.execute(
        "DELETE FROM media_history WHERE updated_at < ?1",
        [retention_cutoff(now)],
    )
}
pub const BEGINNING: f64 = 15.0;
pub const END_REMAINING: f64 = 30.0;
pub const CHECKPOINT: Duration = Duration::from_secs(120);
#[derive(Debug, Clone, PartialEq)]
pub struct Identity {
    pub provider: String,
    pub path: String,
    pub size: i64,
    pub modified: Option<String>,
}
impl Identity {
    pub fn from_source(source: &ContentSource) -> Self {
        let metadata = source.metadata();
        let local = source.local_path();
        Self {
            provider: metadata.provider_id.clone(),
            path: local
                .map(|p| p.to_string_lossy().into_owned())
                .unwrap_or_else(|| metadata.path.clone()),
            size: metadata.size.min(i64::MAX as u64) as i64,
            modified: local
                .and_then(|p| std::fs::metadata(p).ok())
                .and_then(|m| m.modified().ok())
                .and_then(|m| m.duration_since(UNIX_EPOCH).ok())
                .map(|m| m.as_nanos().to_string()),
        }
    }
}
pub fn resumable(position: f64, duration: f64) -> bool {
    position.is_finite()
        && duration.is_finite()
        && duration > 0.0
        && position >= BEGINNING
        && duration - position > END_REMAINING
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SaveReason {
    Pause,
    Close,
    Switch,
    Checkpoint,
    Eof,
}
/// Tracks accepted writes in RAM; unchanged pauses/closes never enqueue duplicate transactions.
pub struct Checkpoints {
    last: Option<(f64, f64, bool)>,
    at: Instant,
}
impl Checkpoints {
    pub fn new() -> Self {
        Self {
            last: None,
            at: Instant::now(),
        }
    }
    pub fn capture(
        &mut self,
        position: f64,
        duration: f64,
        reason: SaveReason,
        now: Instant,
    ) -> Option<(f64, f64, bool)> {
        if !position.is_finite() || !duration.is_finite() || duration <= 0.0 {
            return None;
        }
        let completed = reason == SaveReason::Eof || !resumable(position, duration);
        if let Some((previous, _, old_completed)) = self.last {
            if old_completed == completed && (completed || (previous - position).abs() < 1.0) {
                return None;
            }
            if reason == SaveReason::Checkpoint
                && ((previous - position).abs() < 5.0 || now.duration_since(self.at) < CHECKPOINT)
            {
                return None;
            }
        } else if reason == SaveReason::Checkpoint && now.duration_since(self.at) < CHECKPOINT {
            return None;
        }
        self.last = Some((position, duration, completed));
        self.at = now;
        Some((position, duration, completed))
    }
}
enum Job {
    Configure(PathBuf),
    Lookup(Identity, mpsc::SyncSender<Option<f64>>),
    Save(Identity, f64, f64, bool, SaveReason),
    Flush(mpsc::SyncSender<()>),
    Shutdown,
}
pub struct History {
    sender: mpsc::Sender<Job>,
    worker: Mutex<Option<JoinHandle<()>>>,
}
impl Default for History {
    fn default() -> Self {
        let (sender, receiver) = mpsc::channel();
        let worker = thread::Builder::new().name("vesperwind-media-history".into()).spawn(move || {
            let mut database: Option<Connection> = None;
            for job in receiver {
                match job {
                    Job::Configure(path) => {
                        database = match open(&path) { Ok(c) => { eprintln!("[media-history] database={}", path.display()); Some(c) }, Err(e) => { eprintln!("[media-history] disabled: {e}"); None } };
                    }
                    Job::Lookup(identity, reply) => {
                        let result = database.as_ref().and_then(|c| match lookup(c, &identity) { Ok(p) => p, Err(e) => { eprintln!("[media-history] lookup failed: {e}"); None } });
                        let _ = reply.send(result);
                    }
                    Job::Save(identity, position, duration, completed, reason) => {
                        if let Some(c) = &database {
                            match save(c, &identity, position, duration, completed) { Ok(changed) => eprintln!("[media-history] reason={reason:?} changed={changed} position={position:.3} completed={completed}"), Err(e) => eprintln!("[media-history] save failed: {e}") }
                        }
                    }
                    Job::Flush(reply) => { let _ = reply.send(()); }
                    Job::Shutdown => break,
                }
            }
        }).expect("media history worker");
        Self {
            sender,
            worker: Mutex::new(Some(worker)),
        }
    }
}
impl History {
    pub fn configure(&self, path: PathBuf) {
        let _ = self.sender.send(Job::Configure(path));
    }
    pub fn lookup(&self, identity: Identity) -> Option<f64> {
        let (reply, receive) = mpsc::sync_channel(1);
        self.sender.send(Job::Lookup(identity, reply)).ok()?;
        receive.recv_timeout(Duration::from_secs(5)).ok().flatten()
    }
    pub fn save(
        &self,
        identity: &Identity,
        position: f64,
        duration: f64,
        completed: bool,
        reason: SaveReason,
    ) {
        let _ = self.sender.send(Job::Save(
            identity.clone(),
            position,
            duration,
            completed,
            reason,
        ));
    }
    pub fn flush(&self) {
        let (reply, receive) = mpsc::sync_channel(1);
        if self.sender.send(Job::Flush(reply)).is_ok() {
            let _ = receive.recv();
        }
    }
}
impl Drop for History {
    fn drop(&mut self) {
        let _ = self.sender.send(Job::Shutdown);
        if let Some(worker) = self.worker.get_mut().unwrap().take() {
            let _ = worker.join();
        }
    }
}
fn open(path: &Path) -> rusqlite::Result<Connection> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?;
    }
    let mut c = Connection::open(path)?;
    c.busy_timeout(Duration::from_secs(2))?;
    c.pragma_update(None, "journal_mode", "WAL")?;
    c.pragma_update(None, "synchronous", "FULL")?;
    migrate(&mut c)?;
    let pruned = prune(&c, timestamp())?;
    if pruned > 0 {
        eprintln!("[media-history] pruned={pruned} retention_days={RETENTION_DAYS}");
    }
    Ok(c)
}
fn migrate(c: &mut Connection) -> rusqlite::Result<()> {
    let version: i64 = c.pragma_query_value(None, "user_version", |r| r.get(0))?;
    if version > 1 {
        return Err(rusqlite::Error::InvalidQuery);
    }
    if version == 0 {
        let transaction = c.transaction()?;
        transaction.execute_batch("CREATE TABLE IF NOT EXISTS media_history (
            provider_id TEXT NOT NULL, path TEXT NOT NULL, file_size INTEGER NOT NULL, modified_at TEXT,
            duration REAL NOT NULL, position REAL NOT NULL, updated_at INTEGER NOT NULL,
            PRIMARY KEY(provider_id, path)); PRAGMA user_version=1;")?;
        transaction.commit()?;
    }
    Ok(())
}
fn lookup(c: &Connection, identity: &Identity) -> rusqlite::Result<Option<f64>> {
    lookup_at(c, identity, timestamp())
}
fn lookup_at(c: &Connection, identity: &Identity, now: i64) -> rusqlite::Result<Option<f64>> {
    let row: Option<(i64, Option<String>, f64, f64)> = c.query_row("SELECT file_size, modified_at, position, duration FROM media_history WHERE provider_id=?1 AND path=?2", params![identity.provider, identity.path], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))).optional()?;
    let Some((size, modified, position, duration)) = row else {
        return Ok(None);
    };
    if size != identity.size || modified != identity.modified || !resumable(position, duration) {
        c.execute(
            "DELETE FROM media_history WHERE provider_id=?1 AND path=?2",
            params![identity.provider, identity.path],
        )?;
        return Ok(None);
    }
    c.execute(
        "UPDATE media_history SET updated_at=?3 WHERE provider_id=?1 AND path=?2",
        params![identity.provider, identity.path, now],
    )?;
    Ok(Some(position))
}
fn save(
    c: &Connection,
    identity: &Identity,
    position: f64,
    duration: f64,
    completed: bool,
) -> rusqlite::Result<usize> {
    if completed || !resumable(position, duration) {
        return c.execute(
            "DELETE FROM media_history WHERE provider_id=?1 AND path=?2",
            params![identity.provider, identity.path],
        );
    }
    let now = timestamp();
    c.execute("INSERT INTO media_history(provider_id,path,file_size,modified_at,duration,position,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7)
        ON CONFLICT(provider_id,path) DO UPDATE SET file_size=excluded.file_size, modified_at=excluded.modified_at, duration=excluded.duration, position=excluded.position, updated_at=excluded.updated_at
        WHERE file_size IS NOT excluded.file_size OR modified_at IS NOT excluded.modified_at OR duration IS NOT excluded.duration OR abs(position-excluded.position)>=1.0",
        params![identity.provider, identity.path, identity.size, identity.modified, duration, position, now])
}
#[cfg(test)]
mod tests {
    use super::*;
    fn db() -> Connection {
        let mut c = Connection::open_in_memory().unwrap();
        migrate(&mut c).unwrap();
        c
    }
    fn identity(path: &str) -> Identity {
        Identity {
            provider: "local".into(),
            path: path.into(),
            size: 123,
            modified: Some("100".into()),
        }
    }
    #[test]
    fn retention_is_deterministic_and_lookup_keeps_returning_media_active() {
        let c = db();
        let now = 2_000_000_000;
        let cutoff = retention_cutoff(now);
        assert_eq!(cutoff, now - 180 * 86400);
        assert_eq!(retention_cutoff(i64::MIN), i64::MIN);
        for (name, updated) in [
            ("old", cutoff - 1),
            ("boundary", cutoff),
            ("recent", now),
            ("active", cutoff - 1),
        ] {
            save(&c, &identity(name), 47.375, 120.0, false).unwrap();
            c.execute(
                "UPDATE media_history SET updated_at=?2 WHERE path=?1",
                params![name, updated],
            )
            .unwrap();
        }
        assert_eq!(
            lookup_at(&c, &identity("active"), now).unwrap(),
            Some(47.375)
        );
        let refreshed: i64 = c
            .query_row(
                "SELECT updated_at FROM media_history WHERE path='active'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(refreshed, now);
        assert_eq!(prune(&c, now).unwrap(), 1);
        assert_eq!(lookup_at(&c, &identity("old"), now).unwrap(), None);
        for name in ["boundary", "recent", "active"] {
            assert_eq!(lookup_at(&c, &identity(name), now).unwrap(), Some(47.375));
        }
        assert_eq!(prune(&c, now).unwrap(), 0);
        save(&c, &identity("active"), 120.0, 120.0, true).unwrap();
        assert_eq!(lookup_at(&c, &identity("active"), now).unwrap(), None);
    }
    #[test]
    fn configuration_prunes_on_the_existing_worker_connection() {
        let root = std::env::temp_dir().join(format!("vw-retention-{}", uuid::Uuid::new_v4()));
        let path = root.join("history.sqlite3");
        let c = open(&path).unwrap();
        save(&c, &identity("abandoned"), 47.375, 120.0, false).unwrap();
        save(&c, &identity("recent"), 47.375, 120.0, false).unwrap();
        c.execute(
            "UPDATE media_history SET updated_at=?1 WHERE path='abandoned'",
            [retention_cutoff(timestamp()) - 1],
        )
        .unwrap();
        drop(c);
        let worker = History::default();
        worker.configure(path);
        assert_eq!(worker.lookup(identity("abandoned")), None);
        assert_eq!(worker.lookup(identity("recent")), Some(47.375));
        drop(worker);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn first_open_reopen_separate_sources_and_invalidation() {
        let c = db();
        let a = identity("a");
        assert_eq!(lookup(&c, &a).unwrap(), None);
        assert_eq!(save(&c, &a, 475.0, 7200.0, false).unwrap(), 1);
        assert_eq!(lookup(&c, &a).unwrap(), Some(475.0));
        let b = identity("b");
        assert_eq!(lookup(&c, &b).unwrap(), None);
        save(&c, &b, 100.0, 600.0, false).unwrap();
        assert_eq!(lookup(&c, &a).unwrap(), Some(475.0));
        let mut changed = a.clone();
        changed.size = 124;
        assert_eq!(lookup(&c, &changed).unwrap(), None);
        save(&c, &a, 475.0, 7200.0, false).unwrap();
        changed = a.clone();
        changed.modified = Some("101".into());
        assert_eq!(lookup(&c, &changed).unwrap(), None);
    }
    #[test]
    fn thresholds_eof_and_duplicate_writes() {
        let c = db();
        let a = identity("a");
        for p in [0.0, 14.99, 7170.0, 7200.0] {
            save(&c, &a, p, 7200.0, false).unwrap();
            assert_eq!(lookup(&c, &a).unwrap(), None);
        }
        assert!(resumable(15.0, 7200.0));
        assert!(!resumable(f64::NAN, 7200.0));
        assert_eq!(save(&c, &a, 475.0, 7200.0, false).unwrap(), 1);
        assert_eq!(save(&c, &a, 475.0, 7200.0, false).unwrap(), 0);
        save(&c, &a, 475.0, 7200.0, true).unwrap();
        assert_eq!(lookup(&c, &a).unwrap(), None);
    }
    #[test]
    fn pause_close_switch_and_checkpoint_gate() {
        let t = Instant::now();
        let mut gate = Checkpoints::new();
        assert_eq!(gate.capture(20.0, 600.0, SaveReason::Checkpoint, t), None);
        assert!(gate.capture(100.0, 600.0, SaveReason::Pause, t).is_some());
        assert_eq!(gate.capture(100.0, 600.0, SaveReason::Close, t), None);
        assert_eq!(
            gate.capture(
                200.0,
                600.0,
                SaveReason::Checkpoint,
                t + Duration::from_secs(119)
            ),
            None
        );
        assert!(gate
            .capture(220.0, 600.0, SaveReason::Checkpoint, t + CHECKPOINT)
            .is_some());
        assert_eq!(
            gate.capture(
                221.0,
                600.0,
                SaveReason::Checkpoint,
                t + CHECKPOINT + CHECKPOINT
            ),
            None
        );
        assert!(gate
            .capture(
                240.0,
                600.0,
                SaveReason::Switch,
                t + CHECKPOINT + CHECKPOINT
            )
            .is_some());
        assert!(
            gate.capture(0.0, 600.0, SaveReason::Eof, t + CHECKPOINT + CHECKPOINT)
                .unwrap()
                .2
        );
    }
    #[test]
    fn migration_stale_and_corrupt_rows() {
        let mut c = db();
        migrate(&mut c).unwrap();
        assert_eq!(
            c.pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
                .unwrap(),
            1
        );
        let a = identity("a");
        c.execute(
            "INSERT INTO media_history VALUES ('local','a',123,'100',600,1,0)",
            [],
        )
        .unwrap();
        assert_eq!(lookup(&c, &a).unwrap(), None);
        c.execute(
            "INSERT INTO media_history VALUES ('local','a',123,'100',600,'broken',0)",
            [],
        )
        .unwrap();
        assert!(lookup(&c, &a).is_err());
        c.pragma_update(None, "user_version", 2).unwrap();
        assert!(migrate(&mut c).is_err());
    }
    #[test]
    fn worker_serialization_durability_and_flush() {
        let root = std::env::temp_dir().join(format!("vw-history-{}", uuid::Uuid::new_v4()));
        let path = root.join("history.sqlite3");
        {
            let history = History::default();
            history.configure(path.clone());
            let a = identity("a");
            history.save(&a, 475.0, 7200.0, false, SaveReason::Close);
            history.flush();
            assert_eq!(history.lookup(a), Some(475.0));
        }
        let c = open(&path).unwrap();
        assert_eq!(lookup(&c, &identity("a")).unwrap(), Some(475.0));
        assert_eq!(
            c.pragma_query_value(None, "journal_mode", |r| r.get::<_, String>(0))
                .unwrap(),
            "wal"
        );
        drop(c);
        std::fs::remove_dir_all(root).unwrap();
    }
}

/// Browser-backed audio/video keep current position in this native RAM mirror so
/// graceful app exit can save even when the WebView has already stopped responding.
pub struct WebHistory {
    history: std::sync::Arc<History>,
    sessions: Mutex<std::collections::HashMap<String, WebSession>>,
}
struct WebSession {
    identity: Identity,
    gate: Checkpoints,
    position: f64,
    duration: f64,
    ready: bool,
}
impl WebHistory {
    pub fn new(history: std::sync::Arc<History>) -> Self {
        Self {
            history,
            sessions: Mutex::new(Default::default()),
        }
    }
    pub fn open(&self, id: String, identity: Identity) -> Option<f64> {
        let resume = self.history.lookup(identity.clone());
        self.sessions.lock().unwrap().insert(
            id,
            WebSession {
                identity,
                gate: Checkpoints::new(),
                position: resume.unwrap_or(0.0),
                duration: 0.0,
                ready: false,
            },
        );
        resume
    }
    pub fn update(&self, id: &str, position: f64, duration: f64, event: &str) {
        let mut sessions = self.sessions.lock().unwrap();
        let Some(s) = sessions.get_mut(id) else {
            return;
        };
        // Invalid/unloaded snapshots never erase a previous history record.
        if position.is_finite() && duration.is_finite() && duration > 0.0 {
            s.position = position;
            s.duration = duration;
            s.ready = true;
            let reason = match event {
                "pause" => SaveReason::Pause,
                "close" => SaveReason::Close,
                "eof" => SaveReason::Eof,
                _ => SaveReason::Checkpoint,
            };
            if let Some((p, d, c)) = s.gate.capture(position, duration, reason, Instant::now()) {
                self.history.save(&s.identity, p, d, c, reason);
            }
        }
        if event == "close" {
            sessions.remove(id);
        }
    }
    pub fn close_all(&self) {
        let mut sessions = self.sessions.lock().unwrap();
        for (_, mut s) in sessions.drain() {
            if s.ready {
                if let Some((p, d, c)) =
                    s.gate
                        .capture(s.position, s.duration, SaveReason::Close, Instant::now())
                {
                    self.history.save(&s.identity, p, d, c, SaveReason::Close);
                }
            }
        }
    }
}

#[cfg(test)]
mod web_tests {
    use super::*;
    #[test]
    fn web_exit_source_switch_unloaded_and_eof() {
        let root = std::env::temp_dir().join(format!("vw-web-history-{}", uuid::Uuid::new_v4()));
        let history = std::sync::Arc::new(History::default());
        history.configure(root.join("history.sqlite3"));
        let identity = |path: &str| Identity {
            provider: "local".into(),
            path: path.into(),
            size: 10,
            modified: None,
        };
        let web = WebHistory::new(std::sync::Arc::clone(&history));
        assert_eq!(web.open("a1".into(), identity("a")), None);
        web.update("a1", 475.0, 7200.0, "tick");
        assert_eq!(history.lookup(identity("a")), None);
        web.close_all();
        history.flush();
        assert_eq!(history.lookup(identity("a")), Some(475.0));
        assert_eq!(web.open("a2".into(), identity("a")), Some(475.0));
        web.update("a2", 0.0, 0.0, "close");
        history.flush();
        assert_eq!(history.lookup(identity("a")), Some(475.0));
        web.open("a3".into(), identity("a"));
        web.update("a3", 600.0, 7200.0, "close");
        web.open("b1".into(), identity("b"));
        web.update("b1", 100.0, 600.0, "pause");
        history.flush();
        assert_eq!(history.lookup(identity("a")), Some(600.0));
        assert_eq!(history.lookup(identity("b")), Some(100.0));
        web.update("b1", 600.0, 600.0, "eof");
        web.update("b1", 0.0, 600.0, "close");
        history.flush();
        assert_eq!(history.lookup(identity("b")), None);
        drop(web);
        drop(history);
        std::fs::remove_dir_all(root).unwrap();
    }
}
