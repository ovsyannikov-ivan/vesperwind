//! Deterministic loopback fixtures; no public streaming services.
use std::{
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    thread::{self, JoinHandle},
    time::Duration,
};
pub(crate) struct Server {
    address: String,
    stop: Arc<AtomicBool>,
    worker: Option<JoinHandle<()>>,
}
impl Server {
    pub(crate) fn new() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap().to_string();
        listener.set_nonblocking(true).unwrap();
        let stop = Arc::new(AtomicBool::new(false));
        let done = Arc::clone(&stop);
        let worker = thread::spawn(move || {
            while !done.load(Ordering::Acquire) {
                match listener.accept() {
                    Ok((stream, _)) => {
                        let done = Arc::clone(&done);
                        thread::spawn(move || serve(stream, done));
                    }
                    Err(_) => thread::sleep(Duration::from_millis(10)),
                }
            }
        });
        Self {
            address,
            stop,
            worker: Some(worker),
        }
    }
    pub(crate) fn url(&self, path: &str) -> String {
        format!("http://{}{path}", self.address)
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        self.worker.take().unwrap().join().unwrap();
    }
}
fn serve(mut stream: TcpStream, stop: Arc<AtomicBool>) {
    // Winsock accept inherits the listener's nonblocking mode. This worker
    // uses blocking reads: otherwise arriving before the HTTP headers resets
    // the connection instead of waiting for the client, making fixtures flaky.
    stream.set_nonblocking(false).unwrap();
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    let mut request = Vec::new();
    let mut bytes = [0; 1024];
    while request.len() < 8192 {
        let Ok(count) = stream.read(&mut bytes) else {
            return;
        };
        if count == 0 {
            return;
        }
        request.extend_from_slice(&bytes[..count]);
        if request.windows(4).any(|s| s == b"\r\n\r\n") {
            break;
        }
    }
    let request = String::from_utf8_lossy(&request);
    let path = request
        .lines()
        .next()
        .and_then(|s| s.split_whitespace().nth(1))
        .unwrap_or("/")
        .split('?')
        .next()
        .unwrap();
    if path == "/redirect" {
        let _ = stream.write_all(b"HTTP/1.1 302 Found\r\nLocation: /native.flac\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        return;
    }
    if path == "/slow" {
        for _ in 0..50 {
            if stop.load(Ordering::Acquire) {
                return;
            }
            thread::sleep(Duration::from_millis(100));
        }
    }
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../test/fixtures/media");
    if path.contains("..") {
        return;
    }
    let Ok(data) = std::fs::read(root.join(path.trim_start_matches('/'))) else {
        let _ = stream
            .write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        return;
    };
    let range = request.lines().find_map(|s| {
        s.to_ascii_lowercase()
            .strip_prefix("range: bytes=")
            .and_then(|v| v.split('-').next())
            .and_then(|v| v.parse::<usize>().ok())
    });
    let start = range.unwrap_or(0).min(data.len());
    let content_type = if path.ends_with("m3u8") {
        "application/vnd.apple.mpegurl"
    } else {
        "application/octet-stream"
    };
    let range_header = if range.is_some() {
        format!(
            "Content-Range: bytes {start}-{}/{}\r\n",
            data.len().saturating_sub(1),
            data.len()
        )
    } else {
        String::new()
    };
    let status = if range.is_some() {
        "206 Partial Content"
    } else {
        "200 OK"
    };
    let _ = write!(stream, "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nAccept-Ranges: bytes\r\n{range_header}Connection: close\r\n\r\n", data.len() - start);
    let _ = stream.write_all(&data[start..]);
}

#[test]
fn fixture_waits_for_delayed_fragmented_headers_on_inherited_nonblocking_socket() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let mut client = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
    client
        .set_read_timeout(Some(Duration::from_secs(2)))
        .unwrap();
    let (accepted, _) = listener.accept().unwrap();
    // Reproduce Winsock inheritance on every OS, so this regression is covered
    // locally as well as on the Windows runner.
    accepted.set_nonblocking(true).unwrap();
    let worker = thread::spawn(move || serve(accepted, Arc::new(AtomicBool::new(false))));
    thread::sleep(Duration::from_millis(40));
    client
        .write_all(b"GET /tagged.flac HTTP/1.1\r\nHost:")
        .unwrap();
    thread::sleep(Duration::from_millis(20));
    client
        .write_all(b" localhost\r\nConnection: close\r\n\r\n")
        .unwrap();
    let mut response = Vec::new();
    client.read_to_end(&mut response).unwrap();
    worker.join().unwrap();
    assert!(response.starts_with(b"HTTP/1.1 200 OK\r\n"));
    let body = std::fs::read(
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../test/fixtures/media/tagged.flac"),
    )
    .unwrap();
    assert!(response.ends_with(&body));
}
