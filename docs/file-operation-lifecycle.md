# Bounded native file operations

Tauri request options now honor `timeout` and `AbortSignal`. Each destructive
request has an operation ID, one terminal frontend state, and a native deadline
slightly earlier than the frontend deadline. Timeout returns `ETIMEDOUT`, abort
returns `ECANCELLED`, and late native responses are ignored. Socket.IO keeps its
existing timed acknowledgement behavior.

Local and SFTP delete have a **30-second** UI deadline. Other SFTP operations
have **120 seconds**; other local operations have **600 seconds**. A native
watchdog owns the operation independently of the invoking WebView.

Every native filesystem operation runs in a child of the same executable with
`--filesystem-helper`, before constructing Tauri. Requests/results use bounded
anonymous pipes. SFTP helpers obtain private connection snapshots through stdin
and open independent sessions with explicit socket/session timeouts. Credentials
are not written to files or logged. A failed helper cannot hold the application's
filesystem/session locks. On timeout/cancellation the parent kills the helper,
returns promptly and delegates reaping to a separate thread, so an uninterruptible
OS syscall cannot keep the UI awaiting it. The OS ultimately controls syscall
termination; the operation is not claimed to be transactional.

Local recursive delete uses iterative traversal with deadline checkpoints between
entries, `symlink_metadata`, and link unlinking rather than link traversal.
Existing root and real-parent-path guards remain. Native errors carry a stable
code, affected path, readable message and native diagnostic detail. Permission,
read-only, busy, nonempty, disappeared-source, timeout, cancellation and worker
loss are distinguishable.

The confirmation/drop lifecycle clears busy on every terminal result or transport
exception. Failure keeps a readable error and allows Close/Cancel and another
operation. The affected directory is refreshed even if no top-level source
finished, because some children may already have been deleted. Generation checks
also prevent a disposed/replaced request from updating selection or continuing
its remaining batch. Restart does not restore any busy job state.

For the reported `/Users/Public/Drop Box` incident, initial process inspection
found **no old Vesperwind/Tauri/LOWA process**. No process was killed and that
location was not modified. The exact historical cause could not be recovered.
The ineffective Tauri timeout was confirmed in code; it allowed an outstanding
blocking operation to leave its frontend waiting without a deadline. This is an
identified defect, not proof of the original incident's exact cause.

Native regression uses controlled owned temporary permission fixtures, normal
files/directories, symlinks, root rejection, a forced deadline and immediate
successful deletions after failures. Frontend tests cover busy release, partial
failure refresh, ignored late responses, subsequent requests and socket/SFTP
recovery. Real network-loss SFTP and interactive OS-error display remain distinct
from mocked transport and helper validation.
