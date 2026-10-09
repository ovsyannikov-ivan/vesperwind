use crate::{
    credential_store::{CredentialKind, CredentialStore},
    error::NativeError,
    ssh_config::ResolvedProfile,
};
use serde::{Deserialize, Serialize};
use ssh2::{KeyboardInteractivePrompt, Prompt, Session};
use std::{
    path::{Path, PathBuf},
    sync::Arc,
};
use zeroize::Zeroizing;

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct AuthSecrets {
    pub password: Zeroizing<String>,
    pub key_passphrase: Zeroizing<String>,
}
impl AuthSecrets {
    pub fn legacy(auth_type: &str, secret: String) -> Self {
        let mut value = Self::default();
        if auth_type == "privateKey" {
            value.key_passphrase = Zeroizing::new(secret);
        } else {
            value.password = Zeroizing::new(secret);
        }
        value
    }
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthRequired {
    pub attempted: Vec<&'static str>,
    pub needs: &'static str,
}
pub struct AuthFailure {
    pub error: NativeError,
    pub auth: AuthRequired,
}
fn failed(attempted: Vec<&'static str>, needs: &'static str, message: &str) -> AuthFailure {
    AuthFailure {
        error: NativeError::new("EAUTHENTICATION_REQUIRED", message),
        auth: AuthRequired { attempted, needs },
    }
}
#[derive(Clone)]
pub struct AuthContext {
    pub transient: Arc<AuthSecrets>,
    pub store: Arc<CredentialStore>,
}
impl AuthContext {
    pub fn new(store: Arc<CredentialStore>, transient: AuthSecrets) -> Self {
        Self {
            transient: Arc::new(transient),
            store,
        }
    }
    pub fn saved(
        &self,
        resolved: &ResolvedProfile,
        kind: CredentialKind,
    ) -> Result<Option<Zeroizing<String>>, NativeError> {
        let enabled = match kind {
            CredentialKind::Password => resolved.profile.save_password,
            CredentialKind::KeyPassphrase => resolved.profile.save_key_passphrase,
        };
        if enabled {
            self.store.get(&resolved.profile, kind)
        } else {
            Ok(None)
        }
    }
    // The parent acquires saved credentials immediately before spawning the
    // transfer helper. Only its private stdin pipe carries these temporary values.
    pub fn for_helper(&self, resolved: &ResolvedProfile) -> Result<AuthSecrets, NativeError> {
        let mut values = (*self.transient).clone();
        if values.password.is_empty() {
            if let Some(value) = self.saved(resolved, CredentialKind::Password)? {
                values.password = value;
            }
        }
        if values.key_passphrase.is_empty() {
            if let Some(value) = self.saved(resolved, CredentialKind::KeyPassphrase)? {
                values.key_passphrase = value;
            }
        }
        Ok(values)
    }
    pub fn persist_after_connect(
        &mut self,
        profile: &crate::connections::ConnectionProfile,
    ) -> Option<NativeError> {
        let mut retained = (*self.transient).clone();
        let mut warning = None;
        for (kind, enabled, value) in [
            (
                CredentialKind::Password,
                profile.save_password && profile.permits_password(),
                &mut retained.password,
            ),
            (
                CredentialKind::KeyPassphrase,
                profile.save_key_passphrase && profile.permits_passphrase(),
                &mut retained.key_passphrase,
            ),
        ] {
            if enabled && !value.is_empty() {
                match self.store.set(profile, kind, value) {
                    Ok(()) => *value = Zeroizing::new(String::new()),
                    Err(error) => warning = Some(error),
                }
            }
        }
        self.transient = Arc::new(retained);
        warning
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{connections::test_profile, credential_store::MemoryBackend};
    struct Fake {
        calls: Vec<&'static str>,
        agent: bool,
        key: bool,
        password: bool,
        encrypted: bool,
    }
    impl AuthSession for Fake {
        fn agent(&mut self, _identities: Option<&[PathBuf]>) -> AgentResult {
            self.calls.push("agent");
            if self.agent {
                AgentResult::Success
            } else {
                AgentResult::Unavailable
            }
        }
        fn key(&mut self, _path: &Path, passphrase: Option<&str>) -> KeyResult {
            self.calls.push("key");
            if self.key && (!self.encrypted || passphrase == Some("fixture")) {
                KeyResult::Success
            } else if self.encrypted {
                KeyResult::NeedsPassphrase
            } else {
                KeyResult::Rejected
            }
        }
        fn password(&mut self, _value: &str) -> bool {
            self.calls.push("password");
            self.password
        }
    }
    fn fake() -> Fake {
        Fake {
            calls: vec![],
            agent: false,
            key: false,
            password: false,
            encrypted: false,
        }
    }
    fn fixture(mode: &str) -> (ResolvedProfile, AuthContext) {
        (
            ResolvedProfile {
                profile: test_profile(mode),
                identities: vec![],
                identities_only: true,
            },
            AuthContext::new(
                CredentialStore::with_backend(Arc::new(MemoryBackend::default())),
                AuthSecrets::default(),
            ),
        )
    }
    struct Key(PathBuf);
    impl Key {
        fn new() -> Self {
            let path =
                std::env::temp_dir().join(format!("vesper-key-fixture-{}", uuid::Uuid::new_v4()));
            std::fs::write(&path, "fixture").unwrap();
            Self(path)
        }
    }
    impl Drop for Key {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.0);
        }
    }
    #[test]
    fn auto_agent_success_never_attempts_keys_or_password() {
        let (resolved, mut context) = fixture("auto");
        context.transient = Arc::new(AuthSecrets::legacy("password", "fixture".into()));
        let mut session = fake();
        session.agent = true;
        assert!(authenticate(&mut session, &resolved, &context).is_ok());
        assert_eq!(session.calls, ["agent"]);
    }
    #[test]
    fn auto_agent_unavailable_config_identity_succeeds_before_password() {
        let key = Key::new();
        let (mut resolved, context) = fixture("auto");
        resolved.identities = vec![key.0.clone()];
        let mut session = fake();
        session.key = true;
        assert!(authenticate(&mut session, &resolved, &context).is_ok());
        assert_eq!(session.calls, ["agent", "key"]);
    }
    #[test]
    fn auto_keys_fail_then_saved_password_and_empty_auth_reports_password() {
        let key = Key::new();
        let (mut resolved, context) = fixture("auto");
        resolved.identities = vec![key.0.clone()];
        resolved.profile.save_password = true;
        context
            .store
            .set(&resolved.profile, CredentialKind::Password, "fixture")
            .unwrap();
        let mut session = fake();
        session.password = true;
        assert!(authenticate(&mut session, &resolved, &context).is_ok());
        assert_eq!(session.calls, ["agent", "key", "password"]);
        let (resolved, context) = fixture("auto");
        let failure = authenticate(&mut fake(), &resolved, &context)
            .err()
            .unwrap();
        assert_eq!(failure.auth.needs, "password");
        assert_eq!(failure.error.code, "EAUTHENTICATION_REQUIRED");
    }
    #[test]
    fn explicit_auth_modes_do_not_fall_back_to_other_methods() {
        let key = Key::new();
        for mode in ["password", "privateKey", "agent"] {
            let (mut resolved, mut context) = fixture(mode);
            resolved.profile.private_key_path = Some(key.0.to_string_lossy().into_owned());
            resolved.identities = vec![key.0.clone()];
            context.transient = Arc::new(AuthSecrets {
                password: Zeroizing::new("fixture".into()),
                key_passphrase: Zeroizing::new("fixture".into()),
            });
            let mut session = fake();
            let _ = authenticate(&mut session, &resolved, &context);
            assert_eq!(
                session.calls,
                [if mode == "password" {
                    "password"
                } else if mode == "privateKey" {
                    "key"
                } else {
                    "agent"
                }]
            );
        }
    }
    #[test]
    fn encrypted_private_key_uses_saved_passphrase_and_prompts_when_missing() {
        let key = Key::new();
        let (mut resolved, context) = fixture("privateKey");
        resolved.profile.private_key_path = Some(key.0.to_string_lossy().into_owned());
        resolved.profile.save_key_passphrase = true;
        context
            .store
            .set(&resolved.profile, CredentialKind::KeyPassphrase, "fixture")
            .unwrap();
        let mut session = fake();
        session.key = true;
        session.encrypted = true;
        assert!(authenticate(&mut session, &resolved, &context).is_ok());
        assert_eq!(session.calls, ["key", "key"]);
        context
            .store
            .delete(&resolved.profile, CredentialKind::KeyPassphrase)
            .unwrap();
        assert_eq!(
            authenticate(&mut session, &resolved, &context)
                .err()
                .unwrap()
                .auth
                .needs,
            "keyPassphrase"
        );
    }
    #[test]
    fn unchecked_secret_is_transient_checked_secret_is_stored_and_failure_is_not_success() {
        let (mut resolved, mut context) = fixture("password");
        context.transient = Arc::new(AuthSecrets::legacy("password", "fixture".into()));
        assert!(context.persist_after_connect(&resolved.profile).is_none());
        assert!(!context
            .store
            .exists(&resolved.profile, CredentialKind::Password)
            .unwrap());
        resolved.profile.save_password = true;
        assert!(context.persist_after_connect(&resolved.profile).is_none());
        assert!(context.transient.password.is_empty());
        assert!(context
            .store
            .exists(&resolved.profile, CredentialKind::Password)
            .unwrap());
        let mut failing = AuthContext::new(
            CredentialStore::with_backend(Arc::new(MemoryBackend {
                fail: true,
                ..Default::default()
            })),
            AuthSecrets::legacy("password", "fixture".into()),
        );
        assert!(failing.persist_after_connect(&resolved.profile).is_some());
        assert!(!failing.transient.password.is_empty());
    }
    #[test]
    fn identities_only_prevents_default_key_search_and_explicit_key_ignores_other_keys() {
        let (mut resolved, _) = fixture("auto");
        resolved.profile.private_key_path = Some("/fixture/explicit".into());
        resolved.identities = vec!["/fixture/config".into()];
        assert_eq!(identities(&resolved).len(), 2);
        resolved.identities_only = false;
        assert_eq!(identities(&resolved).len(), 5);
        resolved.profile.auth_type = "privateKey".into();
        assert_eq!(
            identities(&resolved),
            [("privateKey", PathBuf::from("/fixture/explicit"))]
        );
    }
}

pub enum AgentResult {
    Success,
    Unavailable,
    Rejected,
}
pub enum KeyResult {
    Success,
    NeedsPassphrase,
    Rejected,
}
// The same policy is exercised using a fake session in unit tests and the ssh2
// adapter in every real SFTP, terminal, reconnect and transfer-helper session.
pub trait AuthSession {
    fn agent(&mut self, identities: Option<&[PathBuf]>) -> AgentResult;
    fn key(&mut self, path: &Path, passphrase: Option<&str>) -> KeyResult;
    fn password(&mut self, value: &str) -> bool;
    fn interaction_required(&self) -> bool {
        false
    }
}
pub struct SshAuthSession<'a> {
    pub session: &'a Session,
    pub username: &'a str,
    interaction: bool,
}
impl<'a> SshAuthSession<'a> {
    pub fn new(session: &'a Session, username: &'a str) -> Self {
        Self {
            session,
            username,
            interaction: false,
        }
    }
}
fn encrypted_key(path: &Path) -> bool {
    let Ok(bytes) = std::fs::read(path).map(Zeroizing::new) else {
        return false;
    };
    let text = String::from_utf8_lossy(&bytes);
    if text.contains("ENCRYPTED") {
        return true;
    }
    if text.contains("BEGIN OPENSSH PRIVATE KEY") {
        use base64::Engine;
        let body: Zeroizing<String> = Zeroizing::new(
            text.lines()
                .filter(|line| !line.starts_with("-----"))
                .collect(),
        );
        if let Ok(data) = base64::engine::general_purpose::STANDARD
            .decode(body.as_bytes())
            .map(Zeroizing::new)
        {
            let magic = b"openssh-key-v1\0";
            if data.starts_with(magic) && data.len() >= magic.len() + 4 {
                let offset = magic.len();
                let size =
                    u32::from_be_bytes(data[offset..offset + 4].try_into().unwrap()) as usize;
                return data
                    .get(offset + 4..offset + 4 + size)
                    .is_some_and(|cipher| cipher != b"none");
            }
        }
    }
    false
}
impl AuthSession for SshAuthSession<'_> {
    fn agent(&mut self, identities: Option<&[PathBuf]>) -> AgentResult {
        use base64::Engine;
        let Ok(mut agent) = self.session.agent() else {
            return AgentResult::Unavailable;
        };
        if agent.connect().is_err() || agent.list_identities().is_err() {
            return AgentResult::Unavailable;
        }
        let Ok(available) = agent.identities() else {
            return AgentResult::Unavailable;
        };
        let allowed: Vec<Vec<u8>> = identities
            .into_iter()
            .flatten()
            .filter_map(|path| {
                let public = std::fs::read_to_string(format!("{}.pub", path.display())).ok()?;
                base64::engine::general_purpose::STANDARD
                    .decode(public.split_whitespace().nth(1)?)
                    .ok()
            })
            .collect();
        for identity in available {
            if identities.is_some() && !allowed.iter().any(|blob| blob == identity.blob()) {
                continue;
            }
            if agent.userauth(self.username, &identity).is_ok() && self.session.authenticated() {
                return AgentResult::Success;
            }
        }
        AgentResult::Rejected
    }
    fn key(&mut self, path: &Path, passphrase: Option<&str>) -> KeyResult {
        if self
            .session
            .userauth_pubkey_file(self.username, None, path, passphrase)
            .is_ok()
            && self.session.authenticated()
        {
            return KeyResult::Success;
        }
        if encrypted_key(path) {
            KeyResult::NeedsPassphrase
        } else {
            KeyResult::Rejected
        }
    }
    fn password(&mut self, value: &str) -> bool {
        if self.interaction {
            return false;
        }
        if self.session.userauth_password(self.username, value).is_ok()
            && self.session.authenticated()
        {
            return true;
        }
        let mut prompt = PasswordPrompt {
            password: value,
            unsupported: false,
            rounds: 0,
        };
        let result = self
            .session
            .userauth_keyboard_interactive(self.username, &mut prompt);
        self.interaction |= prompt.unsupported;
        result.is_ok() && !prompt.unsupported && self.session.authenticated()
    }
    fn interaction_required(&self) -> bool {
        self.interaction
    }
}
struct PasswordPrompt<'a> {
    password: &'a str,
    unsupported: bool,
    rounds: u8,
}
impl KeyboardInteractivePrompt for PasswordPrompt<'_> {
    fn prompt<'a>(
        &mut self,
        _username: &str,
        _instructions: &str,
        prompts: &[Prompt<'a>],
    ) -> Vec<String> {
        // Only a single non-echo password prompt is supported. Never send the
        // server password to an OTP, PIN, token, verification or arbitrary prompt.
        self.rounds = self.rounds.saturating_add(1);
        if self.rounds == 1
            && prompts.len() == 1
            && !prompts[0].echo
            && prompts[0].text.to_lowercase().contains("password")
            && !["otp", "token", "verification", "one-time"]
                .iter()
                .any(|word| prompts[0].text.to_lowercase().contains(word))
        {
            vec![self.password.to_owned()]
        } else {
            self.unsupported = true;
            vec![String::new(); prompts.len()]
        }
    }
}
pub fn identities(resolved: &ResolvedProfile) -> Vec<(&'static str, PathBuf)> {
    let mut paths = vec![];
    if resolved.profile.auth_type == "privateKey" {
        if let Some(path) = &resolved.profile.private_key_path {
            paths.push(("privateKey", PathBuf::from(path)));
        }
        return paths;
    }
    for path in &resolved.identities {
        paths.push(("configIdentity", path.clone()));
    }
    if let Some(path) = resolved
        .profile
        .private_key_path
        .as_ref()
        .filter(|p| !p.is_empty())
    {
        paths.push(("privateKey", PathBuf::from(path)));
    }
    if !resolved.identities_only {
        if let Some(home) = dirs::home_dir() {
            for key in ["id_ed25519", "id_ecdsa", "id_rsa"] {
                paths.push(("defaultIdentity", home.join(".ssh").join(key)));
            }
        }
    }
    let mut seen = std::collections::HashSet::new();
    paths.retain(|(_, path)| seen.insert(path.clone()));
    paths
}
pub fn authenticate(
    session: &mut dyn AuthSession,
    resolved: &ResolvedProfile,
    context: &AuthContext,
) -> Result<(), AuthFailure> {
    let profile = &resolved.profile;
    let mut attempted = vec![];
    let keys = identities(resolved);
    let agent_keys: Vec<_> = keys.iter().map(|(_, path)| path.clone()).collect();
    if matches!(profile.auth_type.as_str(), "auto" | "agent") {
        attempted.push("agent");
        let result = session.agent(resolved.identities_only.then_some(agent_keys.as_slice()));
        if matches!(result, AgentResult::Success) {
            return Ok(());
        }
        if profile.auth_type == "agent" {
            return Err(failed(
                attempted,
                "agent",
                if matches!(result, AgentResult::Unavailable) {
                    "SSH Agent is unavailable"
                } else {
                    "No usable identities were found in SSH Agent"
                },
            ));
        }
    }
    let mut needs_passphrase = false;
    let mut store_error = None;
    if matches!(profile.auth_type.as_str(), "auto" | "privateKey") {
        let saved = match context.saved(resolved, CredentialKind::KeyPassphrase) {
            Ok(value) => value,
            Err(error) => {
                store_error = Some(error);
                None
            }
        };
        let passphrase = if !context.transient.key_passphrase.is_empty() {
            Some(context.transient.key_passphrase.as_str())
        } else {
            saved.as_deref().map(String::as_str)
        };
        for (source, path) in keys {
            if !path.is_file() {
                continue;
            }
            if !attempted.contains(&source) {
                attempted.push(source);
            }
            // An unencrypted key needs no credential, even if a stale saved
            // passphrase exists. Retry with the supplied passphrase only as needed.
            match session.key(&path, None) {
                KeyResult::Success => return Ok(()),
                KeyResult::NeedsPassphrase => {
                    needs_passphrase = true;
                    if let Some(value) = passphrase {
                        if matches!(session.key(&path, Some(value)), KeyResult::Success) {
                            return Ok(());
                        }
                    }
                }
                KeyResult::Rejected => {}
            }
        }
    }
    if profile.permits_password() {
        // Explicit Password prefers typed input. Auto tries persisted password
        // before typed password, after exhausting eligible agent/key methods.
        if profile.auth_type == "password" && !context.transient.password.is_empty() {
            attempted.push("password");
            if session.password(&context.transient.password) {
                return Ok(());
            }
        } else {
            match context.saved(resolved, CredentialKind::Password) {
                Ok(Some(saved)) => {
                    attempted.push("savedPassword");
                    if session.password(&saved) {
                        return Ok(());
                    }
                }
                Ok(None) => {}
                Err(error) => store_error = Some(error),
            }
            if !context.transient.password.is_empty() {
                attempted.push("password");
                if session.password(&context.transient.password) {
                    return Ok(());
                }
            }
        }
    }
    if let Some(error) = store_error {
        return Err(AuthFailure {
            error,
            auth: AuthRequired {
                attempted,
                needs: if needs_passphrase {
                    "keyPassphrase"
                } else {
                    "password"
                },
            },
        });
    }
    let (needs, message) = if session.interaction_required() {
        ("interaction", "This server requires keyboard-interactive/MFA authentication that Vesperwind does not support yet")
    } else if needs_passphrase {
        ("keyPassphrase", "A key passphrase is required")
    } else if profile.auth_type == "privateKey" {
        (
            "privateKey",
            "The selected private key could not authenticate this user",
        )
    } else {
        ("password", "Password required for this server")
    };
    Err(failed(attempted, needs, message))
}
