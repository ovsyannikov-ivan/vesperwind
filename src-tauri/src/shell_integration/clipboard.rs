//! Provider-aware file clipboard shared by the native platform layers.
//!
//! Vesperwind keeps its own clipboard state (operation, `{ providerId, path }`
//! items and a token) and mirrors it into the system clipboard. The system
//! clipboard stays authoritative: when another application replaces it, the
//! internal state is discarded on the next read, so a stale Cut can never be
//! pasted. The frontend never sees platform formats.
use crate::error::NativeError;
use serde::{Deserialize, Serialize};
use std::sync::Mutex;

/// Upper bound for one clipboard selection. Larger selections are rejected
/// before any platform object or staging directory is created.
pub const MAX_CLIPBOARD_ITEMS: usize = 10_000;
/// Version of the custom Vesperwind clipboard representation.
pub const PAYLOAD_VERSION: u32 = 1;
pub const LOCAL_PROVIDER: &str = "local";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ClipboardOperation {
    Copy,
    Cut,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipboardFileRef {
    pub provider_id: String,
    pub path: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub is_directory: bool,
}

impl ClipboardFileRef {
    pub fn is_local(&self) -> bool {
        self.provider_id == LOCAL_PROVIDER
    }
}

/// Serialized into the custom pasteboard type / registered clipboard format.
/// `instance` identifies the running process: provider ids such as
/// `sftp:<uuid>` are meaningful only inside the instance that created them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipboardPayload {
    pub version: u32,
    pub instance: String,
    pub token: String,
    pub operation: ClipboardOperation,
    pub items: Vec<ClipboardFileRef>,
}

impl ClipboardPayload {
    pub fn encode(&self) -> Vec<u8> {
        serde_json::to_vec(self).unwrap_or_default()
    }

    /// Clipboard data comes from other processes. Reject malformed, oversized
    /// or unknown-version data instead of trusting it.
    pub fn decode(bytes: &[u8]) -> Option<Self> {
        if bytes.is_empty() || bytes.len() > 16 * 1024 * 1024 {
            return None;
        }
        let payload: Self = serde_json::from_slice(bytes).ok()?;
        (payload.version == PAYLOAD_VERSION
            && !payload.items.is_empty()
            && payload.items.len() <= MAX_CLIPBOARD_ITEMS
            && payload.items.iter().all(valid_ref))
        .then_some(payload)
    }
}

/// What the platform layer read from the system clipboard.
#[derive(Debug, Default, Clone)]
pub struct SystemClipboard {
    pub payload: Option<ClipboardPayload>,
    /// Real local files (file URLs / CF_HDROP), already stat-ed.
    pub local_files: Vec<ClipboardFileRef>,
    /// Windows "Preferred DropEffect". macOS has no file Cut, so it is `None`.
    pub preferred: Option<ClipboardOperation>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ClipboardSource {
    /// Written by this Vesperwind instance; provider refs are valid.
    Vesperwind,
    /// Files copied by Finder/Explorer or another application/instance.
    System,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipboardSnapshot {
    pub operation: ClipboardOperation,
    pub items: Vec<ClipboardFileRef>,
    pub source: ClipboardSource,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token: Option<String>,
}

#[derive(Debug, Clone)]
pub struct InternalClipboard {
    pub token: String,
    pub operation: ClipboardOperation,
    pub items: Vec<ClipboardFileRef>,
}

#[derive(Debug)]
pub struct ClipboardManager {
    instance: String,
    state: Mutex<Option<InternalClipboard>>,
}

impl Default for ClipboardManager {
    fn default() -> Self {
        Self::new(uuid::Uuid::new_v4().to_string())
    }
}

fn valid_ref(item: &ClipboardFileRef) -> bool {
    !item.provider_id.is_empty()
        && item.provider_id.len() <= 256
        && !item.path.is_empty()
        && item.path.len() <= 32 * 1024
        && !item.path.contains('\0')
        && !item.name.contains(['/', '\\', '\0'])
}

fn is_same_or_descendant(parent: &str, child: &str) -> bool {
    if parent == child {
        return true;
    }
    let trimmed = parent.trim_end_matches(['/', '\\']);
    child.len() > trimmed.len()
        && child.starts_with(trimmed)
        && matches!(child.as_bytes()[trimmed.len()], b'/' | b'\\')
}

/// Validate, de-duplicate and collapse selections. A selected folder already
/// contains its selected descendants; transferring both would copy twice.
pub fn normalize_items(items: Vec<ClipboardFileRef>) -> Result<Vec<ClipboardFileRef>, NativeError> {
    if items.is_empty() {
        return Err(NativeError::new("EINVAL", "Select at least one item"));
    }
    if items.len() > MAX_CLIPBOARD_ITEMS {
        return Err(NativeError::new(
            "ETOO_MANY_ITEMS",
            "Too many items are selected for the clipboard",
        ));
    }
    if let Some(item) = items.iter().find(|item| !valid_ref(item)) {
        return Err(NativeError::new("EINVAL", "Invalid clipboard item").with_path(&item.path));
    }
    let mut unique: Vec<ClipboardFileRef> = Vec::with_capacity(items.len());
    for item in items {
        if !unique
            .iter()
            .any(|other| other.provider_id == item.provider_id && other.path == item.path)
        {
            unique.push(item);
        }
    }
    let collapsed = unique
        .iter()
        .filter(|item| {
            !unique.iter().any(|parent| {
                !std::ptr::eq(*item, parent)
                    && parent.provider_id == item.provider_id
                    && parent.is_directory
                    && is_same_or_descendant(&parent.path, &item.path)
            })
        })
        .cloned()
        .collect();
    Ok(collapsed)
}

impl ClipboardManager {
    pub fn new(instance: String) -> Self {
        Self {
            instance,
            state: Mutex::new(None),
        }
    }

    /// Record a new Vesperwind clipboard and return the payload the platform
    /// layer must publish next to the system representations.
    pub fn set(
        &self,
        operation: ClipboardOperation,
        items: Vec<ClipboardFileRef>,
    ) -> Result<ClipboardPayload, NativeError> {
        let items = normalize_items(items)?;
        let token = uuid::Uuid::new_v4().to_string();
        *self.state.lock().unwrap_or_else(|v| v.into_inner()) = Some(InternalClipboard {
            token: token.clone(),
            operation,
            items: items.clone(),
        });
        Ok(ClipboardPayload {
            version: PAYLOAD_VERSION,
            instance: self.instance.clone(),
            token,
            operation,
            items,
        })
    }

    #[cfg(test)]
    pub fn current(&self) -> Option<InternalClipboard> {
        self.state.lock().unwrap_or_else(|v| v.into_inner()).clone()
    }

    /// Forget the internal state only if it still has `token`.
    pub fn clear_token(&self, token: &str) -> bool {
        let mut state = self.state.lock().unwrap_or_else(|v| v.into_inner());
        if state.as_ref().is_some_and(|entry| entry.token == token) {
            *state = None;
            true
        } else {
            false
        }
    }

    /// Reconcile the internal clipboard with the system clipboard.
    ///
    /// `system == None` means no native clipboard exists (browser/Node mode or
    /// an unsupported platform); the internal clipboard is then authoritative.
    pub fn resolve(&self, system: Option<SystemClipboard>) -> Option<ClipboardSnapshot> {
        let mut state = self.state.lock().unwrap_or_else(|v| v.into_inner());
        let Some(system) = system else {
            return state.as_ref().map(|entry| ClipboardSnapshot {
                operation: entry.operation,
                items: entry.items.clone(),
                source: ClipboardSource::Vesperwind,
                token: Some(entry.token.clone()),
            });
        };
        if let (Some(entry), Some(payload)) = (state.as_ref(), system.payload.as_ref()) {
            if payload.instance == self.instance && payload.token == entry.token {
                return Some(ClipboardSnapshot {
                    operation: entry.operation,
                    items: entry.items.clone(),
                    source: ClipboardSource::Vesperwind,
                    token: Some(entry.token.clone()),
                });
            }
        }
        // Another application (or another copy action) replaced the system
        // clipboard. A remembered Cut must not survive that.
        *state = None;
        drop(state);
        if system.local_files.is_empty() {
            return None;
        }
        // A Cut written by another Vesperwind instance keeps its semantics for
        // local files, which are meaningful across processes.
        let foreign_cut = system.payload.as_ref().is_some_and(|payload| {
            payload.operation == ClipboardOperation::Cut
                && payload.items.iter().all(|i| i.is_local())
        });
        let operation = if foreign_cut {
            ClipboardOperation::Cut
        } else {
            system.preferred.unwrap_or(ClipboardOperation::Copy)
        };
        Some(ClipboardSnapshot {
            operation,
            items: system.local_files,
            source: ClipboardSource::System,
            token: None,
        })
    }

    /// Called after a successful Paste. A Cut is used up; a Copy can be
    /// pasted again. Returns true when the system clipboard should be cleared.
    pub fn consume(&self, token: Option<&str>, operation: ClipboardOperation) -> bool {
        if operation != ClipboardOperation::Cut {
            return false;
        }
        match token {
            Some(token) => self.clear_token(token),
            // An external Cut (Explorer Ctrl+X) was performed by Vesperwind.
            None => true,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(provider: &str, path: &str, directory: bool) -> ClipboardFileRef {
        ClipboardFileRef {
            provider_id: provider.into(),
            path: path.into(),
            name: path.rsplit(['/', '\\']).next().unwrap().into(),
            is_directory: directory,
        }
    }

    #[test]
    fn normalizes_duplicates_and_selected_descendants() {
        let items = normalize_items(vec![
            item("local", "/a", true),
            item("local", "/a/b.txt", false),
            item("local", "/a", true),
            item("sftp:x", "/a/b.txt", false),
            item("local", "/ab", false),
        ])
        .unwrap();
        let paths: Vec<_> = items
            .iter()
            .map(|i| format!("{}:{}", i.provider_id, i.path))
            .collect();
        assert_eq!(paths, ["local:/a", "sftp:x:/a/b.txt", "local:/ab"]);
        let windows = normalize_items(vec![
            item("local", r"C:\Data", true),
            item("local", r"C:\Data\Отчёт.docx", false),
        ])
        .unwrap();
        assert_eq!(windows.len(), 1);
    }

    #[test]
    fn rejects_empty_invalid_and_oversized_selections() {
        assert_eq!(normalize_items(vec![]).unwrap_err().code, "EINVAL");
        assert_eq!(
            normalize_items(vec![item("local", "", false)])
                .unwrap_err()
                .code,
            "EINVAL"
        );
        let mut bad = item("local", "/x", false);
        bad.name = "../x".into();
        assert_eq!(normalize_items(vec![bad]).unwrap_err().code, "EINVAL");
        let many = (0..=MAX_CLIPBOARD_ITEMS)
            .map(|i| item("local", &format!("/f{i}"), false))
            .collect();
        assert_eq!(normalize_items(many).unwrap_err().code, "ETOO_MANY_ITEMS");
    }

    #[test]
    fn payload_round_trip_and_untrusted_decoding() {
        let manager = ClipboardManager::new("instance-a".into());
        let payload = manager
            .set(
                ClipboardOperation::Cut,
                vec![item("local", "/tmp/файл 'q'.txt", false)],
            )
            .unwrap();
        assert_eq!(
            ClipboardPayload::decode(&payload.encode()),
            Some(payload.clone())
        );
        assert!(ClipboardPayload::decode(b"").is_none());
        assert!(ClipboardPayload::decode(b"{\"version\":99}").is_none());
        let mut future = payload;
        future.version = 2;
        assert!(ClipboardPayload::decode(&future.encode()).is_none());
    }

    #[test]
    fn own_clipboard_is_used_until_another_application_replaces_it() {
        let manager = ClipboardManager::new("me".into());
        let payload = manager
            .set(
                ClipboardOperation::Cut,
                vec![item("sftp:1", "/srv/a", false)],
            )
            .unwrap();
        let own = SystemClipboard {
            payload: Some(payload.clone()),
            ..Default::default()
        };
        let snapshot = manager.resolve(Some(own)).unwrap();
        assert_eq!(snapshot.source, ClipboardSource::Vesperwind);
        assert_eq!(snapshot.operation, ClipboardOperation::Cut);
        assert_eq!(snapshot.items[0].provider_id, "sftp:1");

        // Text copied in another application: no files, and the Cut is gone.
        assert!(manager.resolve(Some(SystemClipboard::default())).is_none());
        assert!(manager.current().is_none());
        // Even if the same payload reappears later, the forgotten Cut stays gone.
        let snapshot = manager.resolve(Some(SystemClipboard {
            payload: Some(payload),
            ..Default::default()
        }));
        assert!(snapshot.is_none());
    }

    #[test]
    fn external_files_follow_the_platform_drop_effect() {
        let manager = ClipboardManager::new("me".into());
        let files = vec![item("local", r"C:\Users\Me\a b.txt", false)];
        let explorer_cut = manager
            .resolve(Some(SystemClipboard {
                local_files: files.clone(),
                preferred: Some(ClipboardOperation::Cut),
                ..Default::default()
            }))
            .unwrap();
        assert_eq!(explorer_cut.operation, ClipboardOperation::Cut);
        assert_eq!(explorer_cut.source, ClipboardSource::System);
        let finder = manager
            .resolve(Some(SystemClipboard {
                local_files: files.clone(),
                ..Default::default()
            }))
            .unwrap();
        assert_eq!(finder.operation, ClipboardOperation::Copy);

        // Another Vesperwind instance: SFTP refs are not valid here, local
        // files are used and its Cut of local files is honored.
        let other = ClipboardManager::new("other".into())
            .set(ClipboardOperation::Cut, files.clone())
            .unwrap();
        let foreign = manager
            .resolve(Some(SystemClipboard {
                payload: Some(other),
                local_files: files,
                preferred: None,
            }))
            .unwrap();
        assert_eq!(foreign.operation, ClipboardOperation::Cut);
        assert_eq!(foreign.source, ClipboardSource::System);
    }

    #[test]
    fn cut_is_consumed_once_and_copy_remains_available() {
        let manager = ClipboardManager::new("me".into());
        let copy = manager
            .set(ClipboardOperation::Copy, vec![item("local", "/a", false)])
            .unwrap();
        assert!(!manager.consume(Some(&copy.token), ClipboardOperation::Copy));
        assert!(manager.resolve(None).is_some());

        let cut = manager
            .set(ClipboardOperation::Cut, vec![item("local", "/a", false)])
            .unwrap();
        assert!(!manager.consume(Some(&copy.token), ClipboardOperation::Cut));
        assert!(manager.resolve(None).is_some());
        assert!(manager.consume(Some(&cut.token), ClipboardOperation::Cut));
        assert!(manager.resolve(None).is_none());
        assert!(manager.consume(None, ClipboardOperation::Cut));
    }

    #[test]
    fn browser_runtime_keeps_internal_clipboard_without_system_clipboard() {
        let manager = ClipboardManager::new("me".into());
        manager
            .set(ClipboardOperation::Copy, vec![item("sftp:a", "/x", true)])
            .unwrap();
        let snapshot = manager.resolve(None).unwrap();
        assert_eq!(snapshot.source, ClipboardSource::Vesperwind);
        assert_eq!(snapshot.items.len(), 1);
    }
}
