//! Closed route table, capability URL and generation/request-bound receipts.
use super::*;
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{Read, Write},
    net::{TcpListener, TcpStream},
};
pub(crate) struct OriginState {
    pub generation: u64,
    pub token: String,
    pub origin: String,
    pub assets: PathBuf,
    pub state: Mutex<SessionState>,
    pub changed: Condvar,
    pub closed: AtomicBool,
    pub clients: AtomicU64,
}

pub(super) fn verify_assets(root: &std::path::Path) -> Result<String, NativeError> {
    let manifest_bytes = fs::read(root.join("ASSETS.json"))
        .map_err(|e| NativeError::from_io(&e, "LOWA manifest is unavailable"))?;
    if manifest_bytes != include_bytes!("../../vendor/lowa/ASSETS.json") {
        return Err(NativeError::new(
            "ECONVERTER_ASSETS",
            "LOWA manifest does not match this application build",
        ));
    }
    let manifest: serde_json::Value = serde_json::from_slice(&manifest_bytes)
        .map_err(|_| NativeError::new("ECONVERTER_ASSETS", "Invalid LOWA manifest"))?;
    for entry in manifest["files"]
        .as_array()
        .ok_or_else(|| NativeError::new("ECONVERTER_ASSETS", "Invalid LOWA assets"))?
    {
        let name = entry["path"].as_str().unwrap_or("");
        if name.is_empty() || name.contains("..") || name.starts_with('/') {
            return Err(NativeError::new(
                "ECONVERTER_ASSETS",
                "Invalid LOWA asset path",
            ));
        }
        let bytes = fs::read(root.join(name))
            .map_err(|e| NativeError::from_io(&e, "LOWA asset is unavailable"))?;
        if format!("{:x}", Sha256::digest(&bytes)) != entry["sha256"].as_str().unwrap_or("") {
            return Err(NativeError::new(
                "ECONVERTER_ASSETS",
                format!("LOWA checksum mismatch: {name}"),
            ));
        }
    }
    Ok(format!("{:x}", Sha256::digest(&manifest_bytes)))
}
const CSP: &str = "default-src 'none'; script-src 'self' 'wasm-unsafe-eval' 'unsafe-eval' data:; worker-src 'self' blob:; connect-src 'self'; img-src 'self' data: blob:; font-src 'self' data:; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; frame-ancestors 'none'";
fn reply(stream: &mut TcpStream, status: &str, mime: &str, bytes: &[u8], br: bool) {
    let encoding = if br { "Content-Encoding: br\r\n" } else { "" };
    let headers = format!("HTTP/1.1 {status}\r\nContent-Type: {mime}\r\nContent-Length: {}\r\n{encoding}Connection: close\r\nCross-Origin-Opener-Policy: same-origin\r\nCross-Origin-Embedder-Policy: require-corp\r\nCross-Origin-Resource-Policy: same-origin\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nContent-Security-Policy: {CSP}\r\n\r\n", bytes.len());

    // A closed client connection is routine; it is only logged in debug builds,
    // so the binding is unused in release builds.
    if let Err(_error) = stream
        .write_all(headers.as_bytes())
        .and_then(|_| stream.write_all(bytes))
    {
        #[cfg(debug_assertions)]
        eprintln!("LOWA reply error: {_error}");
    }
}
pub(super) fn serve(listener: TcpListener, session: Arc<OriginState>) -> Result<(), NativeError> {
    listener
        .set_nonblocking(true)
        .map_err(|e| NativeError::from_io(&e, "Unable to start LOWA origin"))?;
    std::thread::spawn(move || {
        while !session.closed.load(Ordering::Acquire) {
            match listener.accept() {
                Ok((mut stream, peer)) => {
                    // Darwin and Windows may inherit the listener's nonblocking
                    // mode. write_all otherwise fails mid-asset with EWOULDBLOCK.
                    if stream.set_nonblocking(false).is_err() {
                        continue;
                    }
                    if !peer.ip().is_loopback() || session.clients.load(Ordering::Acquire) >= 16 {
                        continue;
                    }
                    session.clients.fetch_add(1, Ordering::AcqRel);
                    let session = Arc::clone(&session);
                    std::thread::spawn(move || {
                        let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
                        let _ = stream.set_write_timeout(Some(Duration::from_secs(20)));
                        handle(&mut stream, &session);
                        session.clients.fetch_sub(1, Ordering::AcqRel);
                    });
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(10))
                }
                Err(_) => {
                    session.closed.store(true, Ordering::Release);
                    session.changed.notify_all();
                    break;
                }
            }
        }
    });
    Ok(())
}
fn handle(stream: &mut TcpStream, session: &OriginState) {
    let mut bytes = vec![];
    let mut block = [0u8; 8192];
    let header_end = loop {
        let Ok(n) = stream.read(&mut block) else {
            return;
        };
        if n == 0 {
            return;
        }
        bytes.extend_from_slice(&block[..n]);
        if let Some(pos) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
            break pos + 4;
        }
        if bytes.len() > 16 * 1024 {
            return;
        }
    };
    let headers = String::from_utf8_lossy(&bytes[..header_end]).to_string();
    let mut first = headers.lines().next().unwrap_or("").split_whitespace();
    let method = first.next().unwrap_or("");
    let path = first.next().unwrap_or("");

    let mut len = 0;
    for line in headers.lines().skip(1).filter(|line| !line.is_empty()) {
        let Some((name, value)) = line.split_once(':') else {
            return;
        };
        if name.eq_ignore_ascii_case("origin") && value.trim() != session.origin {
            #[cfg(debug_assertions)]
            eprintln!("LOWA origin rejected {}", value.trim());
            reply(
                stream,
                "403 Forbidden",
                "text/plain",
                b"origin denied",
                false,
            );
            return;
        }
        if name.eq_ignore_ascii_case("host")
            && value.trim() != session.origin.trim_start_matches("http://")
        {
            #[cfg(debug_assertions)]
            eprintln!("LOWA Host rejected {}", value.trim());
            return;
        }
        if name.eq_ignore_ascii_case("content-length") {
            let Ok(n) = value.trim().parse::<usize>() else {
                return;
            };
            len = n;
        }
        if name.eq_ignore_ascii_case("transfer-encoding") {
            return;
        }
    }
    if len > MAX_BYTES {
        return;
    }
    let prefix = format!("/{}/{}/", session.token, session.generation);
    let Some(route) = path.strip_prefix(&prefix) else {
        reply(stream, "404 Not Found", "text/plain", b"not found", false);
        return;
    };
    if session.closed.load(Ordering::Acquire) {
        reply(
            stream,
            "409 Conflict",
            "text/plain",
            b"expired generation",
            false,
        );
        return;
    }
    while bytes.len() < header_end + len {
        let Ok(n) = stream.read(&mut block) else {
            return;
        };
        if n == 0 {
            return;
        }
        bytes.extend_from_slice(&block[..n]);
    }
    let body = &bytes[header_end..header_end + len];
    if method == "POST" {
        let mut state = session.state.lock().unwrap();
        if session.closed.load(Ordering::Acquire) {
            return;
        }
        #[cfg(debug_assertions)]
        if route == "security-probe" {
            state.network_blocked = Some(body == b"blocked");
            drop(state);
            session.changed.notify_all();
            reply(stream, "200 OK", "application/json", b"{}", false);
            return;
        }
        if route == "fatal" {
            state.fatal = Some(String::from_utf8_lossy(body).chars().take(1500).collect());
        } else if route == "diagnostic" {
            #[cfg(debug_assertions)]
            eprintln!(
                "LOWA diagnostic: {}",
                String::from_utf8_lossy(body)
                    .chars()
                    .take(1500)
                    .collect::<String>()
            );
        } else if route == "ready" {
            if let Ok(value) = serde_json::from_slice::<serde_json::Value>(body) {
                state.init_ms = value["initMs"].as_f64().unwrap_or(0.0);
            }
        } else if let Some(id) = route
            .strip_prefix("output/")
            .or_else(|| route.strip_prefix("failure/"))
        {
            let Some(job) = state
                .job
                .as_mut()
                .filter(|j| j.id == id && j.result.is_none())
            else {
                reply(
                    stream,
                    "409 Conflict",
                    "text/plain",
                    b"stale request",
                    false,
                );
                return;
            };
            if route.starts_with("failure/") {
                job.result = Some(Err(NativeError::new(
                    "ECONVERTER",
                    String::from_utf8_lossy(body)
                        .chars()
                        .take(1500)
                        .collect::<String>(),
                )));
            } else {
                let valid = if job.format == "pptx" {
                    body.starts_with(b"%PDF-")
                } else {
                    body.starts_with(b"PK\x03\x04")
                };
                job.result = Some(if valid {
                    Ok(body.to_vec())
                } else {
                    Err(NativeError::new(
                        "ECONVERTER_OUTPUT",
                        "LOWA returned invalid document bytes",
                    ))
                });
            }
        } else {
            reply(stream, "404 Not Found", "text/plain", b"not found", false);
            return;
        }
        drop(state);
        session.changed.notify_all();
        reply(stream, "200 OK", "application/json", b"{}", false);
        return;
    }
    if method != "GET" {
        reply(
            stream,
            "405 Method Not Allowed",
            "text/plain",
            b"method denied",
            false,
        );
        return;
    }
    if route == "job" {
        let state = session.state.lock().unwrap();
        if let Some(job) = state.job.as_ref().filter(|j| j.result.is_none()) {
            let meta = serde_json::json!({"id":job.id,"format":job.format,"target":if job.format=="pptx" {"pdf"} else {"docx"}});
            reply(
                stream,
                "200 OK",
                "application/json",
                &serde_json::to_vec(&meta).unwrap(),
                false,
            );
        } else {
            reply(stream, "204 No Content", "text/plain", b"", false);
        }
        return;
    }
    if let Some(id) = route.strip_prefix("input/") {
        let state = session.state.lock().unwrap();
        if let Some(job) = state
            .job
            .as_ref()
            .filter(|j| j.id == id && j.result.is_none())
        {
            reply(
                stream,
                "200 OK",
                "application/octet-stream",
                &job.input,
                false,
            );
        } else {
            reply(
                stream,
                "409 Conflict",
                "text/plain",
                b"stale request",
                false,
            );
        }
        return;
    }
    let (file, mime, br) = match route {
        "" => ("web/index.html", "text/html", false),
        "boot.js" => ("web/boot.js", "application/javascript", false),
        "office_thread.js" => ("web/office_thread.js", "application/javascript", false),
        "vendor/zeta.js" => ("web/vendor/zeta.js", "application/javascript", false),
        "vendor/zetaHelper.js" => ("web/vendor/zetaHelper.js", "application/javascript", false),
        "soffice.js" => ("soffice.js.br", "application/javascript", true),
        "soffice.wasm" => ("soffice.wasm.br", "application/wasm", true),
        "soffice.data" => ("soffice.data.br", "application/octet-stream", true),
        "soffice.data.js.metadata" => ("soffice.data.js.metadata.br", "application/json", true),
        "font/NotoSansCJKjp-Regular.otf" => ("fonts/NotoSansCJKjp-Regular.otf", "font/otf", false),
        _ => {
            reply(stream, "404 Not Found", "text/plain", b"not found", false);
            return;
        }
    };
    match fs::read(session.assets.join(file)) {
        Ok(bytes) => reply(stream, "200 OK", mime, &bytes, br),
        Err(_) => reply(
            stream,
            "404 Not Found",
            "text/plain",
            b"asset unavailable",
            false,
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> Arc<OriginState> {
        Arc::new(OriginState {
            generation: 7,
            token: "test-capability".into(),
            origin: "http://127.0.0.1:1234".into(),
            assets: PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("vendor/lowa"),
            state: Mutex::new(SessionState {
                #[cfg(debug_assertions)]
                network_blocked: None,
                job: Some(Job {
                    id: "new-job".into(),
                    format: "pptx".into(),
                    input: b"owned source".to_vec(),
                    result: None,
                }),
                init_ms: 0.0,
                fatal: None,
            }),
            changed: Condvar::new(),
            closed: AtomicBool::new(false),
            clients: AtomicU64::new(0),
        })
    }
    fn request(
        origin: &Arc<OriginState>,
        method: &str,
        route: &str,
        external: bool,
        body: &[u8],
    ) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let mut client = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        client
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        let (mut server, _) = listener.accept().unwrap();
        server
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        let state = Arc::clone(origin);
        let worker = std::thread::spawn(move || handle(&mut server, &state));
        let mut request = format!("{method} {route} HTTP/1.1\r\nHost: 127.0.0.1:1234\r\nOrigin: {}\r\nContent-Length: {}\r\n\r\n", if external { "https://external.invalid" } else { "http://127.0.0.1:1234" }, body.len()).into_bytes();
        request.extend_from_slice(body);
        // Send one bounded request, avoiding a split write racing an early
        // rejection/close of a stale generation on macOS/Windows TCP.
        client.write_all(&request).unwrap();
        let mut response = vec![];
        client.read_to_end(&mut response).unwrap();
        worker.join().unwrap();
        String::from_utf8_lossy(&response).into_owned()
    }
    #[test]
    fn serves_real_headers_and_blocks_external_origin_and_paths() {
        let origin = fixture();
        let response = request(&origin, "GET", "/test-capability/7/", false, b"");
        assert!(response.starts_with("HTTP/1.1 200"));
        for header in [
            "Cross-Origin-Opener-Policy: same-origin",
            "Cross-Origin-Embedder-Policy: require-corp",
            "Cross-Origin-Resource-Policy: same-origin",
            "Cache-Control: no-store",
            "X-Content-Type-Options: nosniff",
            "connect-src 'self'",
        ] {
            assert!(response.contains(header));
        }
        assert!(
            request(&origin, "GET", "/test-capability/7/", true, b"").starts_with("HTTP/1.1 403")
        );
        assert!(request(&origin, "GET", "/wrong/7/", false, b"").starts_with("HTTP/1.1 404"));
        assert!(request(
            &origin,
            "GET",
            "/test-capability/7/../../secret",
            false,
            b""
        )
        .starts_with("HTTP/1.1 404"));
        assert!(CSP.contains("frame-src 'none'"));
        assert!(!CSP.contains("https:"));
    }
    #[test]
    fn only_current_request_in_live_generation_accepts_output() {
        let origin = fixture();
        assert!(request(
            &origin,
            "POST",
            "/test-capability/6/output/new-job",
            false,
            b"%PDF-1.7"
        )
        .starts_with("HTTP/1.1 404"));
        assert!(request(
            &origin,
            "POST",
            "/test-capability/7/output/old-job",
            false,
            b"%PDF-1.7"
        )
        .starts_with("HTTP/1.1 409"));
        assert!(origin
            .state
            .lock()
            .unwrap()
            .job
            .as_ref()
            .unwrap()
            .result
            .is_none());
        assert!(request(
            &origin,
            "POST",
            "/test-capability/7/output/new-job",
            false,
            b"%PDF-1.7"
        )
        .starts_with("HTTP/1.1 200"));
        assert!(request(
            &origin,
            "POST",
            "/test-capability/7/output/new-job",
            false,
            b"%PDF-1.7"
        )
        .starts_with("HTTP/1.1 409"));
        origin.closed.store(true, Ordering::Release);
        assert!(
            request(&origin, "GET", "/test-capability/7/job", false, b"")
                .starts_with("HTTP/1.1 409")
        );
    }
    #[test]
    fn nonblocking_listener_delivers_a_complete_large_asset() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let mut origin = fixture();
        Arc::get_mut(&mut origin).unwrap().origin = format!("http://{address}");
        serve(listener, Arc::clone(&origin)).unwrap();
        let mut client = TcpStream::connect(address).unwrap();
        client
            .set_read_timeout(Some(Duration::from_secs(10)))
            .unwrap();
        write!(client, "GET /test-capability/7/font/NotoSansCJKjp-Regular.otf HTTP/1.1\r\nHost: {address}\r\n\r\n").unwrap();
        let mut bytes = vec![];
        client.read_to_end(&mut bytes).unwrap();
        origin.closed.store(true, Ordering::Release);
        let header = bytes.windows(4).position(|w| w == b"\r\n\r\n").unwrap() + 4;
        assert!(bytes.starts_with(b"HTTP/1.1 200"));
        assert_eq!(
            &bytes[header..],
            fs::read(origin.assets.join("fonts/NotoSansCJKjp-Regular.otf")).unwrap()
        );
    }
    #[test]
    fn packaged_assets_match_compiled_manifest() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("vendor/lowa");
        assert_eq!(verify_assets(&root).unwrap().len(), 64);
    }
}
