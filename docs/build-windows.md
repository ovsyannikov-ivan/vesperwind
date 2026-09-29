# Building Vesperwind on Windows

Windows Tauri builds need the following tools before `npm ci` and the native
build. Use the MSVC toolchain for the same architecture as your Node.js install.

| Requirement | Why it is needed |
| --- | --- |
| 64-bit Node.js 22.13+ and npm | Frontend build and native Node dependencies |
| Visual Studio Build Tools with **Desktop development with C++**, MSVC, and a Windows SDK | Tauri/Rust linking and native Node modules |
| Python 3 | `node-gyp` when installing native Node modules such as `node-pty` |
| Rust stable with `x86_64-pc-windows-msvc` | Tauri's Rust backend on 64-bit Windows |
| Microsoft Edge WebView2 Runtime | Tauri's Windows webview; it may already be installed |
| Strawberry Perl | Compiling vendored OpenSSL for the SSH/SFTP backend |

The [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) explain the
C++ Build Tools, WebView2, and Rust setup. Follow the
[node-gyp Windows instructions](https://github.com/nodejs/node-gyp#on-windows)
for Python and the C++ workload.

## Rust target and Strawberry Perl

Install Rust with the MSVC host toolchain. On 64-bit Windows, verify or add its
target in PowerShell:

```powershell
rustup show active-toolchain
rustup target add x86_64-pc-windows-msvc
```

Vesperwind's `src-tauri/Cargo.toml` enables `ssh2`'s `vendored-openssl` feature.
The vendored OpenSSL build requires Perl. Install Strawberry Perl with:

```powershell
winget install -e --id StrawberryPerl.StrawberryPerl
```

Open a **new terminal** so its PATH includes Perl, then verify:

```powershell
perl -v
where.exe perl
```

If `where.exe perl` finds several copies, make sure Strawberry Perl is the one
used for the build. The [OpenSSL Rust crate's build notes](https://docs.rs/openssl/latest/openssl/#vendored)
describe the C compiler, Perl, and make requirements for vendored OpenSSL.

## Build

```powershell
npm ci
```

Then run `npm run dev:tauri` for development or `npm run build:tauri` for a
production native build.

Both npm Tauri commands run `scripts/check-native-prereqs.mjs` first. On Windows,
it checks that `perl -v` succeeds and shows the Strawberry Perl installation
command before Cargo starts if Perl is missing. It does not verify the other
prerequisites or distinguish Strawberry Perl from another working Perl install.

If a build fails in `openssl-sys` after installing Strawberry Perl, restart the
terminal and confirm the `perl -v` and `where.exe perl` results before retrying.
If Tauri cannot start its webview, install or repair the
[WebView2 Runtime](https://developer.microsoft.com/en-us/microsoft-edge/webview2/).

Windows native libmpv rendering and DLL packaging are still planned. The Node
SEA packaging path is currently macOS-only; use the Tauri command above for a
Windows native build.
