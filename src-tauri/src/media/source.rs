//! Provider content and network addresses remain distinct logical sources.
use crate::{
    filesystem::Filesystem, mpv::stream::MpvStreamRegistry, provider_content::ContentSource,
    ssh::SshManager,
};
use serde::Deserialize;
use std::sync::Arc;

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaSource {
    #[serde(default)]
    pub source_type: Option<String>,
    #[serde(default)]
    pub provider_id: Option<String>,
    pub filesystem_id: Option<String>,
    #[serde(default)]
    pub path: String,
    pub url: Option<String>,
}
pub struct ResolvedSource {
    pub uri: String,
    pub content: Option<ContentSource>,
    pub history_enabled: bool,
}
impl MediaSource {
    pub fn network_url(&self) -> Result<Option<String>, String> {
        if self.source_type.as_deref() != Some("url") {
            return Ok(None);
        }
        let parsed = url::Url::parse(self.url.as_deref().unwrap_or_default().trim())
            .map_err(|_| "Enter a valid HTTP or HTTPS URL".to_string())?;
        if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
            return Err("Only HTTP and HTTPS URLs are supported".into());
        }
        Ok(Some(parsed.to_string()))
    }
    pub fn resolve(
        &self,
        filesystem: &Filesystem,
        ssh: &Arc<SshManager>,
        registry: &Arc<MpvStreamRegistry>,
    ) -> Result<ResolvedSource, String> {
        if let Some(uri) = self.network_url()? {
            return Ok(ResolvedSource {
                uri,
                content: None,
                history_enabled: false,
            });
        }
        if self.source_type.as_deref().is_some_and(|v| v != "provider") {
            return Err("Unsupported media source".into());
        }
        let content = ContentSource::open(
            filesystem,
            ssh,
            self.provider_id
                .as_deref()
                .or(self.filesystem_id.as_deref()),
            &self.path,
        )
        .map_err(|e| e.message)?;
        let playlist = self.path.to_ascii_lowercase().ends_with(".m3u8");
        let hls = if playlist {
            let bytes = content
                .read_range(ssh, 0, content.metadata().size.min(1024 * 1024))
                .map_err(|e| e.message)?;
            String::from_utf8_lossy(&bytes)
                .lines()
                .any(|line| line.trim().starts_with("#EXT-X-"))
        } else {
            false
        };
        let uri = if hls {
            let local = content.local_path().ok_or(
                "HLS manifests with sibling segments are supported only on the local provider",
            )?;
            // Already sandbox-resolved by ContentSource; native paths preserve Unicode.
            local.to_string_lossy().into_owned()
        } else {
            registry.register(content.clone())
        };
        Ok(ResolvedSource {
            uri,
            content: Some(content),
            history_enabled: !hls,
        })
    }
}
