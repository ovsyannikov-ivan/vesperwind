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
            let path = local.to_string_lossy().into_owned();
            #[cfg(target_os = "windows")]
            let path = windows_hls_path(&path);
            path
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

// Rust canonical paths use verbatim Windows prefixes. FFmpeg's relative URL
// resolver needs ordinary drive/UNC syntax; validation has already happened.
// This changes spelling only, retaining the Unicode path and UNC share.
#[cfg(any(target_os = "windows", test))]
fn windows_hls_path(path: &str) -> String {
    if let Some(unc) = path.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{unc}")
    } else {
        path.strip_prefix(r"\\?\").unwrap_or(path).to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn windows_hls_keeps_unicode_drive_and_unc_paths_without_verbatim_url_prefix() {
        assert_eq!(
            windows_hls_path(r"\\?\C:\Music\日本語 Время\master.m3u8"),
            r"C:\Music\日本語 Время\master.m3u8"
        );
        assert_eq!(
            windows_hls_path(r"\\?\UNC\server\share\日本語\master.m3u8"),
            r"\\server\share\日本語\master.m3u8"
        );
        assert_eq!(
            windows_hls_path(r"C:\Music\master.m3u8"),
            r"C:\Music\master.m3u8"
        );
    }
}
