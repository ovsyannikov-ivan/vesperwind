use super::{can_serve, content_type, parse_range};
use crate::{
    error::NativeError,
    filesystem::{availability::require_content_ready, Filesystem},
};
use std::{
    fs::{self, File},
    io::{self, BufRead, BufReader, Read, Seek, SeekFrom, Write},
    net::{TcpListener, TcpStream},
    sync::Arc,
};
use uuid::Uuid;

const MAX_REQUEST_HEADER_BYTES: usize = 32 * 1024;

#[derive(Debug)]
pub struct MediaHttpServer {
    origin: String,
    token: String,
}

impl MediaHttpServer {
    pub fn start(filesystem: Arc<Filesystem>) -> io::Result<Arc<Self>> {
        let listener = TcpListener::bind(("127.0.0.1", 0))?;
        let port = listener.local_addr()?.port();
        let server = Arc::new(Self {
            origin: format!("http://127.0.0.1:{port}"),
            token: Uuid::new_v4().to_string(),
        });
        let expected_token = server.token.clone();

        std::thread::Builder::new()
            .name("vesperwind-media-http".to_string())
            .spawn(move || {
                for connection in listener.incoming() {
                    match connection {
                        Ok(stream) => {
                            let filesystem = Arc::clone(&filesystem);
                            let token = expected_token.clone();
                            let _ = std::thread::Builder::new()
                                .name("vesperwind-media-request".to_string())
                                .spawn(move || {
                                    if let Err(error) =
                                        handle_connection(stream, &filesystem, &token)
                                    {
                                        eprintln!(
                                            "[vesperwind-media-http] connection_error={error:?}"
                                        );
                                    }
                                });
                        }
                        Err(error) => {
                            eprintln!("[vesperwind-media-http] accept_error={error:?}");
                        }
                    }
                }
            })?;

        eprintln!("[vesperwind-media-http] listening={}", server.origin);
        Ok(server)
    }

    pub fn source(&self, provider_id: Option<&str>, path: &str) -> String {
        let query = url::form_urlencoded::Serializer::new(String::new())
            .append_pair("path", path)
            .append_pair("filesystemId", provider_id.unwrap_or("local"))
            .append_pair("token", &self.token)
            .finish();
        format!("{}/content?{query}", self.origin)
    }
}

#[derive(Debug)]
struct ParsedRequest {
    method: String,
    target: String,
    range: Option<String>,
}

fn handle_connection(
    stream: TcpStream,
    filesystem: &Filesystem,
    expected_token: &str,
) -> io::Result<()> {
    stream.set_read_timeout(Some(std::time::Duration::from_secs(10)))?;
    stream.set_write_timeout(Some(std::time::Duration::from_secs(60)))?;
    let mut reader = BufReader::new(stream);
    let request = read_request(&mut reader)?;
    let mut stream = reader.into_inner();

    if request.method == "OPTIONS" {
        write!(
            stream,
            "HTTP/1.1 204 No Content\r\nContent-Length: 0\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Methods: GET, HEAD, OPTIONS\r\nAccess-Control-Allow-Headers: Range\r\nAccess-Control-Max-Age: 86400\r\nConnection: close\r\n\r\n"
        )?;
        return stream.flush();
    }

    if request.method != "GET" && request.method != "HEAD" {
        return write_request_error(
            &mut stream,
            &request,
            "<unparsed>",
            405,
            "Method Not Allowed",
            &NativeError::new("EMETHOD", "Only GET and HEAD are supported"),
        );
    }

    let url = url::Url::parse(&format!("http://localhost{}", request.target))
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidInput, error))?;
    let parameters: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();
    if parameters.get("token").map(String::as_str) != Some(expected_token) {
        return write_request_error(
            &mut stream,
            &request,
            "<unauthorized>",
            403,
            "Forbidden",
            &NativeError::new("EAUTH", "Invalid media access token"),
        );
    }
    let provider_id = parameters.get("filesystemId").map(String::as_str);
    let Some(requested) = parameters.get("path").filter(|path| !path.is_empty()) else {
        return write_request_error(
            &mut stream,
            &request,
            "<missing>",
            400,
            "Bad Request",
            &NativeError::new("EINVAL", "A media file path is required"),
        );
    };
    if !can_serve(requested) {
        return write_request_error(
            &mut stream,
            &request,
            requested,
            415,
            "Unsupported Media Type",
            &NativeError::new("EMEDIA_TYPE", "This file format is not supported"),
        );
    }

    let real = match require_content_ready(filesystem, provider_id, requested) {
        Ok(real) => real,
        Err(error) => {
            let (status, reason) = status_for_error(&error);
            return write_request_error(&mut stream, &request, requested, status, reason, &error);
        }
    };
    let metadata = match fs::metadata(&real) {
        Ok(metadata) if metadata.is_file() => metadata,
        Ok(_) => {
            return write_request_error(
                &mut stream,
                &request,
                requested,
                400,
                "Bad Request",
                &NativeError::new("ENOTFILE", "The requested path is not a file"),
            )
        }
        Err(error) => {
            let native = NativeError::from_io(&error, "Unable to inspect media file")
                .with_path(&real)
                .with_native_error(error.to_string());
            let (status, reason) = status_for_error(&native);
            return write_request_error(&mut stream, &request, requested, status, reason, &native);
        }
    };
    let size = metadata.len();
    let range = match parse_range(request.range.as_deref(), size) {
        Ok(range) => range,
        Err(error) => {
            log_request_error(&request, requested, 416, &error);
            return write_range_error(&mut stream, &error, size, request.method == "HEAD");
        }
    };
    let (status, reason, start, end) = range
        .map(|(start, end)| (206, "Partial Content", start, end))
        .unwrap_or_else(|| (200, "OK", 0, size.saturating_sub(1)));
    let length = if size == 0 { 0 } else { end - start + 1 };

    write!(
        stream,
        "HTTP/1.1 {status} {reason}\r\nContent-Type: {}\r\nContent-Length: {length}\r\nAccept-Ranges: bytes\r\nCache-Control: no-store\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Expose-Headers: Accept-Ranges, Content-Length, Content-Range\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n",
        content_type(&real.to_string_lossy())
    )?;
    if range.is_some() {
        write!(stream, "Content-Range: bytes {start}-{end}/{size}\r\n")?;
    }
    write!(stream, "\r\n")?;

    eprintln!(
        "[vesperwind-media-http] method={} path={requested:?} decoded_path={requested:?} range={:?} status={status} content_length={length} content_range={:?}",
        request.method,
        request.range,
        range.map(|_| format!("bytes {start}-{end}/{size}"))
    );

    if request.method == "HEAD" || length == 0 {
        return stream.flush();
    }

    let mut file = File::open(&real).map_err(|error| {
        log_stream_error(&request, requested, &real, "open", &error);
        error
    })?;
    file.seek(SeekFrom::Start(start)).map_err(|error| {
        log_stream_error(&request, requested, &real, "seek", &error);
        error
    })?;
    let copied = io::copy(&mut file.take(length), &mut stream).map_err(|error| {
        log_stream_error(&request, requested, &real, "stream", &error);
        error
    })?;
    if copied != length {
        return Err(io::Error::new(
            io::ErrorKind::UnexpectedEof,
            format!("expected {length} media bytes, copied {copied}"),
        ));
    }
    stream.flush()
}

fn read_request(reader: &mut BufReader<TcpStream>) -> io::Result<ParsedRequest> {
    let mut request_line = String::new();
    reader.read_line(&mut request_line)?;
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or_default().to_string();
    let target = parts.next().unwrap_or_default().to_string();
    if method.is_empty() || target.is_empty() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "invalid HTTP request",
        ));
    }

    let mut bytes_read = request_line.len();
    let mut range = None;
    loop {
        let mut line = String::new();
        let count = reader.read_line(&mut line)?;
        if count == 0 || line == "\r\n" || line == "\n" {
            break;
        }
        bytes_read += count;
        if bytes_read > MAX_REQUEST_HEADER_BYTES {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "HTTP request headers are too large",
            ));
        }
        if let Some((name, value)) = line.split_once(':') {
            if name.eq_ignore_ascii_case("range") {
                range = Some(value.trim().to_string());
            }
        }
    }
    Ok(ParsedRequest {
        method,
        target,
        range,
    })
}

fn write_range_error(
    stream: &mut TcpStream,
    error: &NativeError,
    size: u64,
    head_only: bool,
) -> io::Result<()> {
    let body = serde_json::to_vec(&serde_json::json!({ "ok": false, "error": error }))?;
    write!(
        stream,
        "HTTP/1.1 416 Range Not Satisfiable\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: {}\r\nContent-Range: bytes */{size}\r\nAccept-Ranges: bytes\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Expose-Headers: Accept-Ranges, Content-Length, Content-Range\r\nConnection: close\r\n\r\n",
        body.len()
    )?;
    if head_only {
        stream.flush()
    } else {
        stream.write_all(&body)
    }
}

fn write_error(
    stream: &mut TcpStream,
    status: u16,
    reason: &str,
    error: &NativeError,
    head_only: bool,
) -> io::Result<()> {
    let body = serde_json::to_vec(&serde_json::json!({ "ok": false, "error": error }))?;
    write!(
        stream,
        "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: {}\r\nAccept-Ranges: bytes\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Expose-Headers: Accept-Ranges, Content-Length, Content-Range\r\nConnection: close\r\n\r\n",
        body.len()
    )?;
    if head_only {
        stream.flush()
    } else {
        stream.write_all(&body)
    }
}

fn write_request_error(
    stream: &mut TcpStream,
    request: &ParsedRequest,
    path: &str,
    status: u16,
    reason: &str,
    error: &NativeError,
) -> io::Result<()> {
    log_request_error(request, path, status, error);
    write_error(stream, status, reason, error, request.method == "HEAD")
}

fn log_request_error(request: &ParsedRequest, path: &str, status: u16, error: &NativeError) {
    eprintln!(
        "[vesperwind-media-http] method={} path={path:?} decoded_path={path:?} range={:?} status={status} error={error:?}",
        request.method, request.range
    );
}

fn log_stream_error(
    request: &ParsedRequest,
    requested: &str,
    real: &std::path::Path,
    action: &str,
    error: &io::Error,
) {
    eprintln!(
        "[vesperwind-media-http] method={} path={requested:?} decoded_path={requested:?} real_path={real:?} range={:?} action={action} error={error:?}",
        request.method, request.range
    );
}

fn status_for_error(error: &NativeError) -> (u16, &'static str) {
    match error.code.as_str() {
        "EFILE_NOT_FOUND" | "ENOENT" => (404, "Not Found"),
        "EFILE_PERMISSION" | "EACCES" | "EPERM" | "EOUTSIDE_ROOT" => (403, "Forbidden"),
        "ECLOUD_NOT_LOCAL"
        | "ECLOUD_DOWNLOAD_FAILED"
        | "ECLOUD_DOWNLOAD_STALLED"
        | "ECLOUD_OFFLINE"
        | "ECONTENT_MATERIALIZING" => (503, "Service Unavailable"),
        "EINVAL" | "EFILESYSTEM_ID" => (400, "Bad Request"),
        _ => (500, "Internal Server Error"),
    }
}

#[cfg(test)]
mod tests {
    use super::MediaHttpServer;
    use crate::filesystem::Filesystem;
    use std::{
        fs::{self, File},
        io::{Read, Seek, SeekFrom, Write},
        net::TcpStream,
        sync::{
            atomic::{AtomicU64, Ordering},
            Arc,
        },
        time::Duration,
    };

    static FIXTURE_ID: AtomicU64 = AtomicU64::new(0);

    fn request(source: &str, method: &str, range: Option<&str>) -> Vec<u8> {
        let url = url::Url::parse(source).unwrap();
        let port = url.port().unwrap();
        let target = match url.query() {
            Some(query) => format!("{}?{query}", url.path()),
            None => url.path().to_string(),
        };
        let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        write!(
            stream,
            "{method} {target} HTTP/1.1\r\nHost: {}\r\nConnection: close\r\n",
            url.host_str().unwrap()
        )
        .unwrap();
        if let Some(range) = range {
            write!(stream, "Range: {range}\r\n").unwrap();
        }
        write!(stream, "\r\n").unwrap();
        let mut response = Vec::new();
        stream.read_to_end(&mut response).unwrap();
        response
    }

    fn parts(response: &[u8]) -> (&str, &[u8]) {
        let boundary = response
            .windows(4)
            .position(|bytes| bytes == b"\r\n\r\n")
            .unwrap();
        (
            std::str::from_utf8(&response[..boundary]).unwrap(),
            &response[boundary + 4..],
        )
    }

    #[test]
    fn streams_http_get_head_and_large_ranges() {
        let id = FIXTURE_ID.fetch_add(1, Ordering::Relaxed);
        let root =
            std::env::temp_dir().join(format!("vesperwind-media-http-{}-{id}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("Большой файл, 41.pdf");
        let small_path = root.join("small.pdf");
        let video_path = root.join("seek test.mp4");
        fs::write(&small_path, b"%PDF-1.7\nsmall").unwrap();
        let mut video = File::create(&video_path).unwrap();
        video.set_len(2 * 1024 * 1024).unwrap();
        video.write_all(b"....ftyp").unwrap();
        video.seek(SeekFrom::Start(1024 * 1024)).unwrap();
        video.write_all(b"seek-target-0001").unwrap();
        let size = 5 * 1024 * 1024 * 1024 + 123;
        let mut file = File::create(&path).unwrap();
        file.set_len(size).unwrap();
        file.write_all(b"%PDF-1.7").unwrap();
        file.seek(SeekFrom::Start(size - 16)).unwrap();
        file.write_all(b"vesperwind-tail!").unwrap();

        let filesystem = Arc::new(Filesystem::from_root(&root, root.clone()).unwrap());
        let server = MediaHttpServer::start(filesystem).unwrap();
        let source = server.source(Some("local"), &path.to_string_lossy());

        let small_source = server.source(Some("local"), &small_path.to_string_lossy());
        let response = request(&small_source, "GET", None);
        let (headers, body) = parts(&response);
        assert!(headers.starts_with("HTTP/1.1 200 OK"));
        assert!(headers.contains("Content-Type: application/pdf"));
        assert!(headers.contains("Content-Length: 14"));
        assert!(headers.contains("Accept-Ranges: bytes"));
        assert_eq!(body, b"%PDF-1.7\nsmall");

        // Browser media seeking issues non-sequential ranges against the same
        // source. Exercise a forward seek and then a jump back to the header.
        let video_source = server.source(Some("local"), &video_path.to_string_lossy());
        let response = request(&video_source, "GET", Some("bytes=1048576-1048591"));
        let (headers, body) = parts(&response);
        assert!(headers.starts_with("HTTP/1.1 206 Partial Content"));
        assert!(headers.contains("Content-Type: video/mp4"));
        assert!(headers.contains("Content-Range: bytes 1048576-1048591/2097152"));
        assert_eq!(body, b"seek-target-0001");
        let response = request(&video_source, "GET", Some("bytes=0-7"));
        let (headers, body) = parts(&response);
        assert!(headers.starts_with("HTTP/1.1 206 Partial Content"));
        assert_eq!(body, b"....ftyp");

        let response = request(&source, "GET", Some("bytes=0-65535"));
        let (headers, body) = parts(&response);
        assert!(headers.starts_with("HTTP/1.1 206 Partial Content"));
        assert!(headers.contains("Content-Type: application/pdf"));
        assert!(headers.contains("Content-Length: 65536"));
        assert!(headers.contains("Accept-Ranges: bytes"));
        assert!(headers.contains(
            "Access-Control-Expose-Headers: Accept-Ranges, Content-Length, Content-Range"
        ));
        assert!(headers.contains(&format!("Content-Range: bytes 0-65535/{size}")));
        assert_eq!(body.len(), 65_536);
        assert_eq!(&body[..8], b"%PDF-1.7");

        let response = request(&source, "GET", Some("bytes=65536-131071"));
        let (headers, body) = parts(&response);
        assert!(headers.starts_with("HTTP/1.1 206 Partial Content"));
        assert!(headers.contains(&format!("Content-Range: bytes 65536-131071/{size}")));
        assert_eq!(body.len(), 65_536);

        let response = request(&source, "GET", Some(&format!("bytes={}-", size - 16)));
        let (headers, body) = parts(&response);
        assert!(headers.contains(&format!(
            "Content-Range: bytes {}-{}/{size}",
            size - 16,
            size - 1
        )));
        assert_eq!(body, b"vesperwind-tail!");

        let response = request(&source, "GET", Some("bytes=-16"));
        let (headers, body) = parts(&response);
        assert!(headers.starts_with("HTTP/1.1 206 Partial Content"));
        assert_eq!(body, b"vesperwind-tail!");

        let response = request(&source, "HEAD", None);
        let (headers, body) = parts(&response);
        assert!(headers.starts_with("HTTP/1.1 200 OK"));
        assert!(headers.contains(&format!("Content-Length: {size}")));
        assert!(body.is_empty());

        let response = request(&source, "HEAD", Some("bytes=65536-131071"));
        let (headers, body) = parts(&response);
        assert!(headers.starts_with("HTTP/1.1 206 Partial Content"));
        assert!(headers.contains("Content-Length: 65536"));
        assert!(headers.contains(&format!("Content-Range: bytes 65536-131071/{size}")));
        assert!(body.is_empty());

        let response = request(&source, "GET", Some(&format!("bytes={size}-")));
        let (headers, _) = parts(&response);
        assert!(headers.starts_with("HTTP/1.1 416 Range Not Satisfiable"));
        assert!(headers.contains(&format!("Content-Range: bytes */{size}")));

        let response = request(&source, "HEAD", Some(&format!("bytes={size}-")));
        let (headers, body) = parts(&response);
        assert!(headers.starts_with("HTTP/1.1 416 Range Not Satisfiable"));
        assert!(headers.contains(&format!("Content-Range: bytes */{size}")));
        assert!(body.is_empty());

        let response = request(&source, "OPTIONS", None);
        let (headers, body) = parts(&response);
        assert!(headers.starts_with("HTTP/1.1 204 No Content"));
        assert!(headers.contains("Access-Control-Allow-Methods: GET, HEAD, OPTIONS"));
        assert!(headers.contains("Access-Control-Allow-Headers: Range"));
        assert!(body.is_empty());

        fs::remove_dir_all(root).unwrap();
    }
}
