# Acceptance helper: inspect the real Explorer window through its Shell COM API.
# Only the test's unique fixture folder is inspected or closed.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
$expectedItem = $env:VESPERWIND_EXPLORER_TEST_ITEM
if ([string]::IsNullOrWhiteSpace($expectedItem)) { throw 'Missing Explorer test item' }
$expectedFolder = [IO.Path]::GetDirectoryName($expectedItem)
$existingWindows = @($env:VESPERWIND_EXPLORER_EXISTING_WINDOWS -split ',')
$shell = New-Object -ComObject Shell.Application
$deadline = [DateTime]::UtcNow.AddSeconds(20)
$observed = @()
do {
    foreach ($window in @($shell.Windows())) {
        try {
            $folder = $window.Document.Folder.Self.Path
            if ($folder -ine $expectedFolder) { continue }
            $observed = @($window.Document.SelectedItems() | ForEach-Object { $_.Path })
            if ($observed.Count -eq 1 -and $observed[0] -ieq $expectedItem) {
                $receipt = @{ folder = $folder; selected = $observed }
                # Preserve any Explorer window/tabs that existed before this test.
                if ([string]$window.HWND -notin $existingWindows) { $window.Quit() }
                $receipt | ConvertTo-Json -Compress
                exit 0
            }
        } catch {
            # Explorer may still be navigating when the COM view is queried.
        }
    }
    Start-Sleep -Milliseconds 200
} while ([DateTime]::UtcNow -lt $deadline)
throw "Explorer did not select '$expectedItem' in '$expectedFolder'; observed: $observed"
