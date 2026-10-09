<#
  Crapplet DCIM installer for Windows 10/11 (runs inside WSL2 Ubuntu).

  One-shot, from an Administrator PowerShell (public repository):
    irm https://raw.githubusercontent.com/singhhemant80/DCIM/main/scripts/install-windows.ps1 | iex

  Private repository: set a read-only token first:
    $env:CDCIM_GITHUB_TOKEN = 'github_pat_xxx'
    irm https://raw.githubusercontent.com/singhhemant80/DCIM/main/scripts/install-windows.ps1 -Headers @{Authorization="token $env:CDCIM_GITHUB_TOKEN"} | iex

  Optional: $env:CDCIM_REPO, $env:CDCIM_ADMIN_EMAIL, $env:CDCIM_BRANCH (default main), $env:CDCIM_DISTRO (default Ubuntu-24.04).
  Re-running upgrades the installation in place.
#>
$ErrorActionPreference = 'Stop'

$Repo   = if ($env:CDCIM_REPO) { $env:CDCIM_REPO } else { 'https://github.com/singhhemant80/DCIM.git' }
$Token  = $env:CDCIM_GITHUB_TOKEN
$Branch = if ($env:CDCIM_BRANCH) { $env:CDCIM_BRANCH } else { 'main' }
$Distro = if ($env:CDCIM_DISTRO) { $env:CDCIM_DISTRO } else { 'Ubuntu-24.04' }

if ($Repo -notmatch 'github\.com[/:]([^/]+)/([^/.]+)') { throw "Not a GitHub repository URL: $Repo" }
$RawUrl = "https://raw.githubusercontent.com/$($Matches[1])/$($Matches[2])/$Branch/scripts/install.sh"

# 1. WSL + Ubuntu
$installed = (wsl.exe --list --quiet 2>$null) -replace "`0", '' | Where-Object { $_.Trim() -eq $Distro }
if (-not $installed) {
  $isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  if (-not $isAdmin) { throw 'Installing WSL needs an Administrator PowerShell. Right-click PowerShell > Run as administrator, then run this again.' }
  Write-Host "Installing WSL and $Distro..." -ForegroundColor Cyan
  wsl.exe --install -d $Distro
  Write-Host ''
  Write-Host "Next steps:" -ForegroundColor Yellow
  Write-Host "  1. Restart Windows if asked."
  Write-Host "  2. Open '$Distro' from the Start menu once and create your Linux username and password."
  Write-Host "  3. Run this same command again to finish installing Crapplet DCIM."
  return
}

# 2. Run the Linux installer as root inside WSL (no sudo password needed)
$email = if ($env:CDCIM_ADMIN_EMAIL) { $env:CDCIM_ADMIN_EMAIL } else { Read-Host 'Administrator email (used only on first install; press Enter when upgrading)' }
$auth = if ($Token) { "-H 'Authorization: token $Token'" } else { '' }
$cmd = "curl -fsSL $auth '$RawUrl' | CDCIM_REPO='$Repo' CDCIM_BRANCH='$Branch' CDCIM_ADMIN_EMAIL='$email' CDCIM_GITHUB_TOKEN='$Token' bash"
Write-Host "Installing Crapplet DCIM inside $Distro..." -ForegroundColor Cyan
wsl.exe -d $Distro -u root -- bash -c $cmd
if ($LASTEXITCODE -ne 0) { throw "Installation failed (exit $LASTEXITCODE). Fix the error above and run the same command again." }

Write-Host ''
Write-Host 'Opening http://localhost:8080 ...' -ForegroundColor Green
Write-Host "If the page stops responding later (for example after a restart), run:  wsl -d $Distro -u root -- crapplet-dcim start"
Start-Process 'http://localhost:8080'
