pub mod http;

use crate::{
    error::NativeError, filesystem::Filesystem, provider_content::ContentSource, ssh::SshManager,
};
use std::sync::Arc;
use tauri::http::{header, Method, Request, Response, StatusCode};

// Tauri custom-protocol responses have an in-memory body. Keep open-ended
// ranges bounded so a request such as `bytes=0-` does not materialize a large
// media file before the WebView can ask for the next chunk.
const MAX_RANGE_RESPONSE_LENGTH: u64 = 1024 * 1024;

pub fn serve(
    filesystem: &Arc<Filesystem>,
    ssh: &Arc<SshManager>,
    request: Request<Vec<u8>>,
) -> Response<Vec<u8>> {
    let method = request.method().clone();
    let path = requested_path(&request).unwrap_or_else(|| "<missing>".to_string());
    let range = request
        .headers()
        .get(header::RANGE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("<none>")
        .to_string();

    match serve_inner(filesystem, ssh, &request) {
        Ok(response) => {
            if media_debug_enabled() {
                let content_length = response
                    .headers()
                    .get(header::CONTENT_LENGTH)
                    .and_then(|value| value.to_str().ok())
                    .unwrap_or("<missing>");
                let content_range = response
                    .headers()
                    .get(header::CONTENT_RANGE)
                    .and_then(|value| value.to_str().ok())
                    .unwrap_or("<none>");
                eprintln!(
                    "[vesperwind-media] method={method} path={path:?} range={range:?} status={} content_length={content_length:?} content_range={content_range:?}",
                    response.status(),
                );
            }
            response
        }
        Err((status, error, size)) => {
            eprintln!(
                "[vesperwind-media] method={method} path={path:?} range={range:?} status={status} error={error:?}"
            );
            error_response(status, error, size, method == Method::HEAD)
        }
    }
}

fn requested_path(request: &Request<Vec<u8>>) -> Option<String> {
    let query = request.uri().query()?;
    url::form_urlencoded::parse(query.as_bytes())
        .find_map(|(key, value)| (key == "path").then(|| value.into_owned()))
}

fn media_debug_enabled() -> bool {
    cfg!(debug_assertions) || std::env::var_os("VESPERWIND_MEDIA_DEBUG").is_some()
}

fn serve_inner(
    filesystem: &Filesystem,
    ssh: &Arc<SshManager>,
    request: &Request<Vec<u8>>,
) -> Result<Response<Vec<u8>>, (StatusCode, NativeError, Option<u64>)> {
    if request.method() != Method::GET && request.method() != Method::HEAD {
        return Err((
            StatusCode::METHOD_NOT_ALLOWED,
            NativeError::new("EMETHOD", "Only GET and HEAD are supported"),
            None,
        ));
    }

    let query = request.uri().query().unwrap_or("");
    let parameters: std::collections::HashMap<_, _> = url::form_urlencoded::parse(query.as_bytes())
        .into_owned()
        .collect();
    let requested = parameters
        .get("path")
        .filter(|path| !path.is_empty())
        .ok_or_else(|| {
            (
                StatusCode::BAD_REQUEST,
                NativeError::new("EINVAL", "A media file path is required"),
                None,
            )
        })?;
    if !can_serve(requested) {
        return Err((
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            NativeError::new(
                "EMEDIA_TYPE",
                "This file format is not supported by the built-in viewer",
            ),
            None,
        ));
    }
    let source = ContentSource::open(
        filesystem,
        ssh,
        parameters.get("filesystemId").map(String::as_str),
        requested,
    )
    .map_err(|error| (status_for_availability_error(&error), error, None))?;
    let size = source.metadata().size;
    let range_header = request
        .headers()
        .get(header::RANGE)
        .map(|value| {
            value
                .to_str()
                .map_err(|_| NativeError::new("ERANGE", "Invalid byte range"))
        })
        .transpose()
        .map_err(|error| (StatusCode::RANGE_NOT_SATISFIABLE, error, Some(size)))?;
    let range = parse_range(range_header, size)
        .map_err(|error| (StatusCode::RANGE_NOT_SATISFIABLE, error, Some(size)))?;
    let range = range.map(bound_range);
    let (status, start, end) = range
        .map(|(start, end)| (StatusCode::PARTIAL_CONTENT, start, end))
        .unwrap_or_else(|| (StatusCode::OK, 0, size.saturating_sub(1)));
    let length = if size == 0 { 0 } else { end - start + 1 };
    let body = if request.method() == Method::HEAD || length == 0 {
        Vec::new()
    } else {
        source
            .read_range(ssh, start, length)
            .map_err(|error| (StatusCode::INTERNAL_SERVER_ERROR, error, Some(size)))?
    };

    let mut builder = Response::builder()
        .status(status)
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CACHE_CONTROL, "no-store")
        .header(header::CONTENT_TYPE, content_type(requested))
        .header(header::CONTENT_LENGTH, length.to_string())
        .header("access-control-allow-origin", "*")
        .header("x-content-type-options", "nosniff");
    if range.is_some() {
        builder = builder.header(header::CONTENT_RANGE, format!("bytes {start}-{end}/{size}"));
    }
    Ok(builder.body(body).expect("valid media response"))
}

fn status_for_availability_error(error: &NativeError) -> StatusCode {
    match error.code.as_str() {
        "EFILE_NOT_FOUND" | "ENOENT" => StatusCode::NOT_FOUND,
        "EFILE_PERMISSION" | "EACCES" | "EPERM" | "EOUTSIDE_ROOT" => StatusCode::FORBIDDEN,
        "ECLOUD_NOT_LOCAL"
        | "ECLOUD_DOWNLOAD_FAILED"
        | "ECLOUD_DOWNLOAD_TIMEOUT"
        | "ECLOUD_OFFLINE"
        | "ECLOUD_DOWNLOAD_STALLED"
        | "ECONTENT_MATERIALIZING" => StatusCode::SERVICE_UNAVAILABLE,
        "EFILESYSTEM_ID" | "EINVAL" => StatusCode::BAD_REQUEST,
        _ => StatusCode::INTERNAL_SERVER_ERROR,
    }
}

fn parse_range(header: Option<&str>, size: u64) -> Result<Option<(u64, u64)>, NativeError> {
    let Some(header) = header else {
        return Ok(None);
    };
    let Some(value) = header.trim().strip_prefix("bytes=") else {
        return Err(NativeError::new("ERANGE", "Invalid byte range"));
    };
    if value.contains(',') || size == 0 {
        return Err(NativeError::new("ERANGE", "Invalid byte range"));
    }
    let Some((start_text, end_text)) = value.split_once('-') else {
        return Err(NativeError::new("ERANGE", "Invalid byte range"));
    };
    if start_text.is_empty() {
        let suffix: u64 = end_text
            .parse()
            .ok()
            .filter(|value| *value > 0)
            .ok_or_else(|| NativeError::new("ERANGE", "Invalid byte range"))?;
        return Ok(Some((size.saturating_sub(suffix), size - 1)));
    }
    let start: u64 = start_text
        .parse()
        .map_err(|_| NativeError::new("ERANGE", "Invalid byte range"))?;
    let end: u64 = if end_text.is_empty() {
        size - 1
    } else {
        end_text
            .parse()
            .map_err(|_| NativeError::new("ERANGE", "Invalid byte range"))?
    };
    if start >= size || end < start {
        return Err(NativeError::new("ERANGE", "Invalid byte range"));
    }
    Ok(Some((start, end.min(size - 1))))
}

fn bound_range((start, end): (u64, u64)) -> (u64, u64) {
    (
        start,
        end.min(start.saturating_add(MAX_RANGE_RESPONSE_LENGTH - 1)),
    )
}

fn error_response(
    status: StatusCode,
    error: NativeError,
    size: Option<u64>,
    head_only: bool,
) -> Response<Vec<u8>> {
    let error_body =
        serde_json::to_vec(&serde_json::json!({ "ok": false, "error": error })).unwrap_or_default();
    let mut builder = Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "application/json; charset=utf-8")
        .header(header::CONTENT_LENGTH, error_body.len().to_string())
        .header(header::ACCEPT_RANGES, "bytes")
        .header("access-control-allow-origin", "*");
    if status == StatusCode::METHOD_NOT_ALLOWED {
        builder = builder.header(header::ALLOW, "GET, HEAD");
    }
    if status == StatusCode::RANGE_NOT_SATISFIABLE {
        if let Some(size) = size {
            builder = builder.header(header::CONTENT_RANGE, format!("bytes */{size}"));
        }
    }
    builder
        .body(if head_only { Vec::new() } else { error_body })
        .expect("valid media error response")
}

fn extension(path: &str) -> &str {
    path.rsplit('.').next().unwrap_or("")
}

fn can_serve(path: &str) -> bool {
    matches!(
        extension(path).to_ascii_lowercase().as_str(),
        "mp4"
            | "m4v"
            | "mov"
            | "webm"
            | "ogv"
            | "mkv"
            | "ts"
            | "m2ts"
            | "mp3"
            | "m4a"
            | "aac"
            | "wav"
            | "wave"
            | "ogg"
            | "oga"
            | "opus"
            | "flac"
            | "aif"
            | "aiff"
            | "caf"
            | "jpg"
            | "jpeg"
            | "png"
            | "gif"
            | "webp"
            | "avif"
            | "bmp"
            | "pdf"
    )
}

fn content_type(path: &str) -> &'static str {
    match extension(path).to_ascii_lowercase().as_str() {
        "mp4" => "video/mp4",
        "m4v" => "video/x-m4v",
        "mov" => "video/quicktime",
        "webm" => "video/webm",
        "ogv" => "video/ogg",
        "mkv" => "video/x-matroska",
        "ts" | "m2ts" => "video/mp2t",
        "mp3" => "audio/mpeg",
        "m4a" => "audio/mp4",
        "aac" => "audio/aac",
        "wav" | "wave" => "audio/wav",
        "ogg" | "oga" => "audio/ogg",
        "opus" => "audio/ogg; codecs=opus",
        "flac" => "audio/flac",
        "aif" | "aiff" => "audio/aiff",
        "caf" => "audio/x-caf",
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "bmp" => "image/bmp",
        "pdf" => "application/pdf",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::{parse_range, serve, MAX_RANGE_RESPONSE_LENGTH};
    use crate::{filesystem::Filesystem, ssh::SshManager};
    use std::{
        fs::{self, File},
        io::{Seek, SeekFrom, Write},
        path::PathBuf,
        sync::{
            atomic::{AtomicU64, Ordering},
            Arc,
        },
    };
    use tauri::http::{header, Method, Request, StatusCode};

    static FIXTURE_ID: AtomicU64 = AtomicU64::new(0);

    struct Fixture {
        root: PathBuf,
        filesystem: Arc<Filesystem>,
        ssh: Arc<SshManager>,
        large_pdf: PathBuf,
        small_pdf: PathBuf,
        unicode_pdf: PathBuf,
        large_size: u64,
    }

    impl Fixture {
        fn new() -> Self {
            let id = FIXTURE_ID.fetch_add(1, Ordering::Relaxed);
            let root = std::env::temp_dir().join(format!(
                "vesperwind-media-protocol-{}-{id}",
                std::process::id()
            ));
            fs::create_dir_all(&root).unwrap();

            let small_pdf = root.join("small.pdf");
            fs::write(&small_pdf, b"%PDF-1.7\nsmall").unwrap();
            let unicode_pdf = root.join("Положение о Совете, 41.pdf");
            fs::write(&unicode_pdf, b"%PDF-1.7\nunicode").unwrap();

            // Sparse files keep the test cheap while exercising offsets beyond
            // 32-bit integer limits.
            let large_size = 5 * 1024 * 1024 * 1024 + 123;
            let large_pdf = root.join("large.pdf");
            let mut file = File::create(&large_pdf).unwrap();
            file.set_len(large_size).unwrap();
            file.write_all(b"%PDF").unwrap();
            file.seek(SeekFrom::Start(large_size - 16)).unwrap();
            file.write_all(b"vesperwind-tail!").unwrap();

            let filesystem = Arc::new(
                Filesystem::from_root(&root, root.clone()).expect("valid test filesystem"),
            );
            Self {
                root,
                filesystem,
                ssh: SshManager::new(),
                large_pdf,
                small_pdf,
                unicode_pdf,
                large_size,
            }
        }

        fn request(
            &self,
            method: Method,
            path: &std::path::Path,
            range: Option<&str>,
        ) -> Request<Vec<u8>> {
            let query = url::form_urlencoded::Serializer::new(String::new())
                .append_pair("path", &path.to_string_lossy())
                .append_pair("filesystemId", "local")
                .finish();
            let mut builder = Request::builder()
                .method(method)
                .uri(format!("vesperwind-media://localhost/content?{query}"));
            if let Some(range) = range {
                builder = builder.header(header::RANGE, range);
            }
            builder.body(Vec::new()).unwrap()
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn parses_media_ranges() {
        assert_eq!(
            parse_range(Some("bytes=10-19"), 100).unwrap(),
            Some((10, 19))
        );
        assert_eq!(parse_range(Some("bytes=-10"), 100).unwrap(), Some((90, 99)));
        assert_eq!(parse_range(Some("bytes=10-"), 100).unwrap(), Some((10, 99)));
        assert!(parse_range(Some("bytes=100-"), 100).is_err());
    }

    #[test]
    fn serves_get_and_head_with_complete_headers() {
        let fixture = Fixture::new();
        let get = serve(
            &fixture.filesystem,
            &fixture.ssh,
            fixture.request(Method::GET, &fixture.small_pdf, None),
        );
        assert_eq!(get.status(), StatusCode::OK);
        assert_eq!(get.headers()[header::CONTENT_TYPE], "application/pdf");
        assert_eq!(get.headers()[header::ACCEPT_RANGES], "bytes");
        assert_eq!(get.headers()[header::CONTENT_LENGTH], "14");
        assert_eq!(get.body(), b"%PDF-1.7\nsmall");

        let head = serve(
            &fixture.filesystem,
            &fixture.ssh,
            fixture.request(Method::HEAD, &fixture.small_pdf, None),
        );
        assert_eq!(head.status(), StatusCode::OK);
        assert_eq!(head.headers()[header::CONTENT_LENGTH], "14");
        assert!(head.body().is_empty());
    }

    #[test]
    fn decodes_and_serves_unicode_paths_exactly() {
        let fixture = Fixture::new();
        let response = serve(
            &fixture.filesystem,
            &fixture.ssh,
            fixture.request(Method::GET, &fixture.unicode_pdf, Some("bytes=0-7")),
        );
        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(response.headers()[header::CONTENT_RANGE], "bytes 0-7/16");
        assert_eq!(response.body(), b"%PDF-1.7");
    }

    #[test]
    fn serves_large_file_ranges_without_32_bit_truncation() {
        let fixture = Fixture::new();
        for (range, expected_start, expected_end) in [
            ("bytes=0-65535".to_string(), 0, 65_535),
            ("bytes=65536-131071".to_string(), 65_536, 131_071),
            (
                format!("bytes={}-", fixture.large_size - 16),
                fixture.large_size - 16,
                fixture.large_size - 1,
            ),
            (
                "bytes=-16".to_string(),
                fixture.large_size - 16,
                fixture.large_size - 1,
            ),
        ] {
            let response = serve(
                &fixture.filesystem,
                &fixture.ssh,
                fixture.request(Method::GET, &fixture.large_pdf, Some(&range)),
            );
            let expected_length = expected_end - expected_start + 1;
            assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
            assert_eq!(response.headers()[header::CONTENT_TYPE], "application/pdf");
            assert_eq!(response.headers()[header::ACCEPT_RANGES], "bytes");
            assert_eq!(
                response.headers()[header::CONTENT_RANGE],
                format!(
                    "bytes {expected_start}-{expected_end}/{}",
                    fixture.large_size
                )
            );
            assert_eq!(
                response.headers()[header::CONTENT_LENGTH],
                expected_length.to_string()
            );
            assert_eq!(response.body().len() as u64, expected_length);
            if range == "bytes=0-65535" {
                assert_eq!(&response.body()[..4], b"%PDF");
            }
            if range == "bytes=-16" || expected_start == fixture.large_size - 16 {
                assert_eq!(response.body(), b"vesperwind-tail!");
            }
        }
    }

    #[test]
    fn bounds_open_ended_ranges_in_memory() {
        let fixture = Fixture::new();
        let response = serve(
            &fixture.filesystem,
            &fixture.ssh,
            fixture.request(Method::GET, &fixture.large_pdf, Some("bytes=0-")),
        );
        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(response.body().len() as u64, MAX_RANGE_RESPONSE_LENGTH);
        assert_eq!(
            response.headers()[header::CONTENT_RANGE],
            format!(
                "bytes 0-{}/{}",
                MAX_RANGE_RESPONSE_LENGTH - 1,
                fixture.large_size
            )
        );
    }

    #[test]
    fn returns_416_for_unsatisfiable_large_file_range() {
        let fixture = Fixture::new();
        let response = serve(
            &fixture.filesystem,
            &fixture.ssh,
            fixture.request(
                Method::GET,
                &fixture.large_pdf,
                Some(&format!("bytes={}-", fixture.large_size)),
            ),
        );
        assert_eq!(response.status(), StatusCode::RANGE_NOT_SATISFIABLE);
        assert_eq!(
            response.headers()[header::CONTENT_RANGE],
            format!("bytes */{}", fixture.large_size)
        );
        assert_eq!(response.headers()[header::ACCEPT_RANGES], "bytes");
    }

    #[test]
    fn head_range_has_range_headers_without_a_body() {
        let fixture = Fixture::new();
        let response = serve(
            &fixture.filesystem,
            &fixture.ssh,
            fixture.request(Method::HEAD, &fixture.large_pdf, Some("bytes=65536-131071")),
        );
        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(response.headers()[header::CONTENT_LENGTH], "65536");
        assert_eq!(
            response.headers()[header::CONTENT_RANGE],
            format!("bytes 65536-131071/{}", fixture.large_size)
        );
        assert!(response.body().is_empty());
    }
}
