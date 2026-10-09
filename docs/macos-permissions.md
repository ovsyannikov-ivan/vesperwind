# macOS access setup

On the first launch after installing this version, Vesperwind offers a compact
access wizard before mounting the file panels. macOS shows separate system
prompts for Desktop, Documents and the local network. Each step is optional;
Set up later and Finish persist only `permissions.setupCompleted: true`.
If that write fails, the wizard shows a warning and offers Retry saving or
Continue without saving. Continuing mounts the file panels for this session;
it does not change the stored completion flag. The wizard may return on the
next launch, while permissions granted in macOS remain in effect.

That flag records completion of onboarding, **not** OS permission decisions.
An older settings file without the field gets the wizard once. The wizard can
be reopened from Settings → General → Set up access without remounting the file
manager or editor. Browser, SEA and Windows do not show it.

Before reading a local Desktop/Documents path, resolving it or opening/saving
its contents, the API prepares access in a separate native request. It opens and
enumerates at most one directory entry from the protected folder; it never reads
file bytes, opens files or materializes cloud placeholders. Folder access denied
by macOS returns `EPERMISSION_DENIED` and Files and Folders guidance.

The permission-preparation request is cancellable and has no ordinary IO timer.
The regular operation and its existing deadline begin only after access is
available. A late response after cancellation cannot start or complete the
operation. Cancellation stops the application request; it cannot dismiss a
system permission dialog that is already visible.

Local-network setup uses Network.framework to browse the declared SSH Bonjour
service `_ssh._tcp`. Discovered endpoints are never returned or authenticated.
The browser waits for connectivity/permission and resumes when access becomes
available. Before an SSH connection to an address on a broadcast-capable local
interface or a `.local` host, this preparation occurs before TCP/SSH and before
the normal connection timeout. Destinations outside these local subnets,
including ordinary Internet/VPN hosts, and loopback addresses do not require
this setup step.

macOS has no general API that distinguishes an unanswered local-network prompt
from a remembered denial. A policy-blocked request therefore remains in an
explicit waiting state with Cancel/Skip available and instructions for System
Settings → Privacy & Security → Local Network. It never reports an ordinary SSH
failure solely because the user has not answered the OS prompt.

The bundle declares `NSDesktopFolderUsageDescription`,
`NSDocumentsFolderUsageDescription`, `NSLocalNetworkUsageDescription` and
`NSBonjourServices` in Info.plist. No hidden permission database or private TCC
API is used.
Local-network preparation runs on macOS 15 and later. Network.framework is
weak-linked so this feature does not raise the existing macOS deployment target.

Tests cover first/subsequent launch, skipping and reopening, persistence errors,
strict settings normalization, cancellation and late replies, permission waits
outliving ordinary IO deadlines, protected path boundaries and LAN/VPN subnet
classification. Test fresh OS prompts with a separately identified, bundled
app launched through Launch Services. Command-line ancestry can change local
network permission enforcement; do not reset the real app's permissions merely
to exercise a test.

Apple documents the initial-operation race and preferred connectivity waiting
in [TN3179: Understanding local network privacy](https://developer.apple.com/documentation/technotes/tn3179-understanding-local-network-privacy).
Folder prompting is described in
[NSDesktopFolderUsageDescription](https://developer.apple.com/documentation/bundleresources/information-property-list/nsdesktopfolderusagedescription).
