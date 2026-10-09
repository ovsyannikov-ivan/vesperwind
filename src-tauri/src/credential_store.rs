use crate::{connections::ConnectionProfile, error::NativeError};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
use zeroize::Zeroizing;

const SERVICE: &str = "com.vesperwind.credentials";
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum CredentialKind {
    Password,
    KeyPassphrase,
}
impl CredentialKind {
    fn suffix(self) -> &'static str {
        match self {
            Self::Password => "password",
            Self::KeyPassphrase => "key-passphrase",
        }
    }
}
pub fn credential_id(
    protocol: &str,
    profile_id: &str,
    kind: CredentialKind,
) -> Result<String, NativeError> {
    let valid = |value: &str| {
        !value.is_empty()
            && value.len() <= 80
            && value
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || "._-".contains(c))
    };
    if !valid(protocol) || !valid(profile_id) {
        return Err(NativeError::new("EINVAL", "Invalid credential identity"));
    }
    Ok(format!("{protocol}:{profile_id}:{}", kind.suffix()))
}
pub trait CredentialBackend: Send + Sync {
    fn get(&self, account: &str) -> Result<Option<Zeroizing<String>>, NativeError>;
    fn set(&self, account: &str, secret: &str) -> Result<(), NativeError>;
    fn delete(&self, account: &str) -> Result<(), NativeError>;
    fn exists(&self, account: &str) -> Result<bool, NativeError>;
    fn available(&self) -> bool {
        true
    }
}

#[cfg(test)]
#[derive(Default)]
pub struct MemoryBackend {
    pub(crate) values: Mutex<HashMap<String, Zeroizing<String>>>,
    pub fail: bool,
}
#[cfg(test)]
impl CredentialBackend for MemoryBackend {
    fn get(&self, account: &str) -> Result<Option<Zeroizing<String>>, NativeError> {
        if self.fail {
            return Err(unavailable());
        }
        Ok(self.values.lock().unwrap().get(account).cloned())
    }
    fn set(&self, account: &str, secret: &str) -> Result<(), NativeError> {
        if self.fail {
            return Err(unavailable());
        }
        self.values
            .lock()
            .unwrap()
            .insert(account.into(), Zeroizing::new(secret.into()));
        Ok(())
    }
    fn delete(&self, account: &str) -> Result<(), NativeError> {
        if self.fail {
            return Err(unavailable());
        }
        self.values.lock().unwrap().remove(account);
        Ok(())
    }
    fn exists(&self, account: &str) -> Result<bool, NativeError> {
        Ok(self.get(account)?.is_some())
    }
}
struct NativeBackend {
    store: Option<Arc<keyring_core::CredentialStore>>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connections::test_profile;
    struct FailingBackend {
        memory: MemoryBackend,
        deletes: std::sync::atomic::AtomicUsize,
        fail_read: bool,
        fail_restore: bool,
    }
    impl CredentialBackend for FailingBackend {
        fn get(&self, account: &str) -> Result<Option<Zeroizing<String>>, NativeError> {
            if self.fail_read {
                return Err(unavailable());
            }
            self.memory.get(account)
        }
        fn set(&self, account: &str, secret: &str) -> Result<(), NativeError> {
            if self.fail_restore && self.deletes.load(std::sync::atomic::Ordering::SeqCst) > 0 {
                return Err(unavailable());
            }
            self.memory.set(account, secret)
        }
        fn delete(&self, account: &str) -> Result<(), NativeError> {
            self.memory.delete(account)?;
            if self
                .deletes
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst)
                == 1
            {
                return Err(unavailable());
            }
            Ok(())
        }
        fn exists(&self, account: &str) -> Result<bool, NativeError> {
            self.memory.exists(account)
        }
    }

    #[test]
    fn partial_delete_failure_restores_every_attempted_secret_and_never_commits() {
        let backend = Arc::new(FailingBackend {
            memory: MemoryBackend::default(),
            deletes: Default::default(),
            fail_read: false,
            fail_restore: false,
        });
        let store = CredentialStore::with_backend(backend.clone());
        let mut profile = test_profile("auto");
        profile.save_password = true;
        profile.save_key_passphrase = true;
        for kind in [CredentialKind::Password, CredentialKind::KeyPassphrase] {
            store.set(&profile, kind, kind.suffix()).unwrap();
        }
        let result = store.reconcile_with_commit::<()>(&[profile.clone()], &[], || {
            panic!("must not save after cleanup fails")
        });
        assert_eq!(result.unwrap_err().code, "ECREDENTIAL_UNAVAILABLE");
        for kind in [CredentialKind::Password, CredentialKind::KeyPassphrase] {
            assert_eq!(
                store.get(&profile, kind).unwrap().unwrap().as_str(),
                kind.suffix()
            );
        }
        assert_eq!(backend.deletes.load(std::sync::atomic::Ordering::SeqCst), 2);
    }

    #[test]
    fn backup_failure_leaves_store_untouched_and_failed_rollback_is_explicit() {
        for fail_read in [true, false] {
            let backend = Arc::new(FailingBackend {
                memory: MemoryBackend::default(),
                deletes: Default::default(),
                fail_read,
                fail_restore: !fail_read,
            });
            let store = CredentialStore::with_backend(backend.clone());
            let mut profile = test_profile("password");
            profile.save_password = true;
            store
                .set(&profile, CredentialKind::Password, "synthetic-secret")
                .unwrap();
            let result = store
                .reconcile_with_commit::<()>(&[profile.clone()], &[], || {
                    if fail_read {
                        panic!("must not save without backup");
                    }
                    Err(NativeError::new("ESETTINGS", "Failed to save settings"))
                })
                .unwrap_err();
            assert!(!result.message.contains("synthetic-secret"));
            if fail_read {
                assert_eq!(backend.deletes.load(std::sync::atomic::Ordering::SeqCst), 0);
                assert!(backend
                    .memory
                    .exists(&credential_id("sftp", &profile.id, CredentialKind::Password).unwrap())
                    .unwrap());
            } else {
                assert_eq!(result.code, "ECREDENTIAL_ROLLBACK");
            }
        }
    }
    #[test]
    fn stable_protocol_profile_and_kind_identity() {
        assert_eq!(
            credential_id("sftp", "id-1", CredentialKind::Password).unwrap(),
            "sftp:id-1:password"
        );
        assert_ne!(
            credential_id("sftp", "id-1", CredentialKind::Password).unwrap(),
            credential_id("sftp", "id-1", CredentialKind::KeyPassphrase).unwrap()
        );
        assert_ne!(
            credential_id("sftp", "id-1", CredentialKind::Password).unwrap(),
            credential_id("ftp", "id-1", CredentialKind::Password).unwrap()
        );
        for value in ["", "../id", "id:password"] {
            assert!(credential_id("sftp", value, CredentialKind::Password).is_err());
        }
    }
    #[test]
    fn overwrite_missing_and_rename_do_not_expose_or_lose_credentials() {
        let store = CredentialStore::with_backend(Arc::new(MemoryBackend::default()));
        let mut profile = test_profile("password");
        profile.save_password = true;
        assert!(store
            .get(&profile, CredentialKind::Password)
            .unwrap()
            .is_none());
        store
            .set(&profile, CredentialKind::Password, "fixture-first")
            .unwrap();
        store
            .set(&profile, CredentialKind::Password, "fixture-replacement")
            .unwrap();
        let mut renamed = profile.clone();
        renamed.name = "Renamed".into();
        store.reconcile(&[profile], &[renamed.clone()]).unwrap();
        assert!(store
            .get(&renamed, CredentialKind::Password)
            .unwrap()
            .is_some_and(|v| v.as_str() == "fixture-replacement"));
        store.delete(&renamed, CredentialKind::Password).unwrap();
        store.delete(&renamed, CredentialKind::Password).unwrap();
        assert!(!store.exists(&renamed, CredentialKind::Password).unwrap());
    }
    #[test]
    fn removing_profiles_and_save_flags_cleans_credentials_without_orphans() {
        for mode in ["remove", "disable", "endpoint", "username", "auth"] {
            let store = CredentialStore::with_backend(Arc::new(MemoryBackend::default()));
            let mut profile = test_profile("auto");
            profile.save_password = true;
            profile.save_key_passphrase = true;
            store
                .set(&profile, CredentialKind::Password, "fixture")
                .unwrap();
            store
                .set(&profile, CredentialKind::KeyPassphrase, "fixture")
                .unwrap();
            let mut next = profile.clone();
            match mode {
                "disable" => {
                    next.save_password = false;
                    next.save_key_passphrase = false;
                }
                "endpoint" => next.host = "different.invalid".into(),
                "username" => next.username = "other".into(),
                "auth" => next.auth_type = "agent".into(),
                _ => {}
            }
            store
                .reconcile(
                    &[profile.clone()],
                    if mode == "remove" {
                        &[]
                    } else {
                        std::slice::from_ref(&next)
                    },
                )
                .unwrap();
            assert!(!store.exists(&profile, CredentialKind::Password).unwrap());
            assert!(!store
                .exists(&profile, CredentialKind::KeyPassphrase)
                .unwrap());
        }
    }
    #[test]
    fn private_key_to_auto_keeps_saved_passphrase_and_failed_deletion_is_reported() {
        let store = CredentialStore::with_backend(Arc::new(MemoryBackend::default()));
        let mut old = test_profile("privateKey");
        old.save_key_passphrase = true;
        store
            .set(&old, CredentialKind::KeyPassphrase, "fixture")
            .unwrap();
        let mut next = old.clone();
        next.auth_type = "auto".into();
        store
            .reconcile(std::slice::from_ref(&old), &[next])
            .unwrap();
        assert!(store.exists(&old, CredentialKind::KeyPassphrase).unwrap());
        let failing = CredentialStore::with_backend(Arc::new(MemoryBackend {
            fail: true,
            ..Default::default()
        }));
        assert!(failing.reconcile(&[old], &[]).is_err());
        assert!(!map_error(keyring_core::Error::BadEncoding(vec![
            115, 101, 99, 114, 101, 116
        ]))
        .message
        .contains("secret"));
        assert_eq!(
            map_error(keyring_core::Error::NoEntry).code,
            "ECREDENTIAL_MISSING"
        );
    }
}
impl NativeBackend {
    fn new() -> Self {
        #[cfg(target_os = "macos")]
        let store = apple_native_keyring_store::keychain::Store::new()
            .ok()
            .map(|store| store as Arc<keyring_core::CredentialStore>);
        #[cfg(target_os = "windows")]
        let store = windows_native_keyring_store::Store::new()
            .ok()
            .map(|store| store as Arc<keyring_core::CredentialStore>);
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        let store = None;
        Self { store }
    }
    fn entry(&self, account: &str) -> Result<keyring_core::Entry, NativeError> {
        let store = self.store.as_ref().ok_or_else(unavailable)?;
        // Local persistence on Windows; no credential search feature or roaming.
        #[cfg(target_os = "windows")]
        let modifiers = HashMap::from([("persistence", "local")]);
        #[cfg(target_os = "windows")]
        let options = Some(&modifiers);
        #[cfg(not(target_os = "windows"))]
        let options: Option<&HashMap<&str, &str>> = None;
        store.build(SERVICE, account, options).map_err(map_error)
    }
}
fn unavailable() -> NativeError {
    NativeError::new(
        "ECREDENTIAL_UNAVAILABLE",
        "The system credential store is unavailable. Secrets have not been saved.",
    )
}
fn map_error(error: keyring_core::Error) -> NativeError {
    // Error Debug/Display may carry arbitrary platform data or bad UTF-8 bytes.
    // Return only a fixed, classified message across IPC and logs.
    match error {
        keyring_core::Error::NoEntry => NativeError::new("ECREDENTIAL_MISSING", "No saved credential was found"),
        keyring_core::Error::NoDefaultStore => unavailable(),
        _ => NativeError::new("ECREDENTIAL_STORE", "Unable to access the system credential store. Check that it is unlocked and accessible."),
    }
}
impl CredentialBackend for NativeBackend {
    fn get(&self, account: &str) -> Result<Option<Zeroizing<String>>, NativeError> {
        match self.entry(account)?.get_password() {
            Ok(value) => Ok(Some(Zeroizing::new(value))),
            Err(keyring_core::Error::NoEntry) => Ok(None),
            Err(error) => Err(map_error(error)),
        }
    }
    fn set(&self, account: &str, secret: &str) -> Result<(), NativeError> {
        self.entry(account)?.set_password(secret).map_err(map_error)
    }
    fn delete(&self, account: &str) -> Result<(), NativeError> {
        match self.entry(account)?.delete_credential() {
            Ok(()) | Err(keyring_core::Error::NoEntry) => Ok(()),
            Err(error) => Err(map_error(error)),
        }
    }
    fn exists(&self, account: &str) -> Result<bool, NativeError> {
        match self.entry(account)?.get_credential() {
            Ok(_) => Ok(true),
            Err(keyring_core::Error::NoEntry) => Ok(false),
            Err(error) => Err(map_error(error)),
        }
    }
    fn available(&self) -> bool {
        self.store.is_some()
    }
}
pub struct CredentialStore {
    backend: Arc<dyn CredentialBackend>,
    lock: Mutex<()>,
}
impl CredentialStore {
    pub fn native() -> Arc<Self> {
        Self::with_backend(Arc::new(NativeBackend::new()))
    }
    pub fn with_backend(backend: Arc<dyn CredentialBackend>) -> Arc<Self> {
        Arc::new(Self {
            backend,
            lock: Mutex::new(()),
        })
    }
    pub fn available(&self) -> bool {
        self.backend.available()
    }
    pub fn get(
        &self,
        profile: &ConnectionProfile,
        kind: CredentialKind,
    ) -> Result<Option<Zeroizing<String>>, NativeError> {
        let _guard = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        self.backend
            .get(&credential_id(&profile.protocol, &profile.id, kind)?)
    }
    pub fn set(
        &self,
        profile: &ConnectionProfile,
        kind: CredentialKind,
        secret: &str,
    ) -> Result<(), NativeError> {
        let _guard = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        self.backend.set(
            &credential_id(&profile.protocol, &profile.id, kind)?,
            secret,
        )
    }
    pub fn delete(
        &self,
        profile: &ConnectionProfile,
        kind: CredentialKind,
    ) -> Result<(), NativeError> {
        let _guard = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        self.backend
            .delete(&credential_id(&profile.protocol, &profile.id, kind)?)
    }
    pub fn exists(
        &self,
        profile: &ConnectionProfile,
        kind: CredentialKind,
    ) -> Result<bool, NativeError> {
        let _guard = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        self.backend
            .exists(&credential_id(&profile.protocol, &profile.id, kind)?)
    }
    #[cfg(test)]
    pub fn reconcile(
        &self,
        previous: &[ConnectionProfile],
        next: &[ConnectionProfile],
    ) -> Result<Vec<String>, NativeError> {
        self.reconcile_with_commit(previous, next, || Ok(()))
            .map(|(_, disconnected)| disconnected)
    }

    /// Retain zeroizing snapshots until the settings write succeeds. This is
    /// rollback for reported failures, not a cross-store crash transaction.
    pub fn reconcile_with_commit<T>(
        &self,
        previous: &[ConnectionProfile],
        next: &[ConnectionProfile],
        commit: impl FnOnce() -> Result<T, NativeError>,
    ) -> Result<(T, Vec<String>), NativeError> {
        let _guard = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        let mut disconnected = vec![];
        let mut accounts = vec![];
        for old in previous {
            let new = next
                .iter()
                .find(|item| item.id == old.id && item.protocol == old.protocol);
            let changed = new.is_none_or(|p| {
                p.host != old.host
                    || p.port != old.port
                    || p.username != old.username
                    || p.ssh_config_host != old.ssh_config_host
            });
            if changed
                || new.is_some_and(|p| {
                    p.auth_type != old.auth_type
                        || p.private_key_path != old.private_key_path
                        || p.save_password != old.save_password
                        || p.save_key_passphrase != old.save_key_passphrase
                })
            {
                disconnected.push(old.id.clone());
            }
            if (changed && (self.available() || old.save_password))
                || (old.save_password
                    && new.is_none_or(|p| !p.save_password || !p.permits_password()))
            {
                accounts.push(credential_id(
                    &old.protocol,
                    &old.id,
                    CredentialKind::Password,
                )?);
            }
            if (changed && (self.available() || old.save_key_passphrase))
                || (old.save_key_passphrase
                    && new.is_none_or(|p| {
                        !p.save_key_passphrase
                            || !p.permits_passphrase()
                            || p.private_key_path != old.private_key_path
                    }))
            {
                accounts.push(credential_id(
                    &old.protocol,
                    &old.id,
                    CredentialKind::KeyPassphrase,
                )?);
            }
        }
        // Read all backups before deleting anything. A locked/unavailable store
        // must leave both settings and credentials untouched.
        accounts.sort();
        accounts.dedup();
        let backups = accounts
            .iter()
            .map(|account| self.backend.get(account).map(|secret| (account, secret)))
            .collect::<Result<Vec<_>, _>>()?;
        let mut attempted = 0;
        let result = (|| {
            for account in &accounts {
                attempted += 1;
                self.backend.delete(account)?;
            }
            commit()
        })();
        match result {
            Ok(value) => Ok((value, disconnected)),
            Err(error) => {
                let mut restored = true;
                for (account, secret) in backups.iter().take(attempted) {
                    if let Some(secret) = secret {
                        if self.backend.set(account, secret).is_err() {
                            restored = false;
                        }
                    }
                }
                if restored {
                    Err(error)
                } else {
                    Err(NativeError::new("ECREDENTIAL_ROLLBACK", "The settings update failed and some saved credentials could not be restored. The previous settings are kept; re-enter the affected credentials."))
                }
            }
        }
    }
}
