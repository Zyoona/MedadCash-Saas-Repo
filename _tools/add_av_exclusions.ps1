# ============================================================
#  مداد — إضافة استثناءات Windows Defender (تشغيل مرة واحدة)
#  يُشغَّل عبر Fix_Defender.bat (يرفع الصلاحية تلقائياً عبر UAC).
#  يضيف مسارات المشروع إلى ExclusionPath مع دمج الموجودة (لا يمسحها).
#  ملاحظة: Set-MpPreference يتطلب صلاحية Admin — يوجد self-elevation احتياطي بالأسفل.
# ============================================================
#Requires -Version 5.1

$ErrorActionPreference = 'Continue'

# ---------- 1) رفع الصلاحية إن لزم (احتياطي — الـ .bat يرفعها عادة قبل الوصول هنا) ----------
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
  [Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  Write-Output 'Restarting with administrator rights (UAC)...'
  Start-Process powershell.exe -Verb RunAs -Wait -ArgumentList @(
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"")
  exit $LASTEXITCODE
}

# ---------- 2) مسارات مداد فقط (مشتقة من موقع السكربت — يعمل من أي قرص/مسار) ----------
$root = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
$pgBin = Join-Path $root 'node_modules\@embedded-postgres\windows-x64\native\bin'
$paths = @(
  $root,
  (Join-Path $root '_tools\node\node.exe'),
  (Join-Path $pgBin 'postgres.exe'),
  (Join-Path $pgBin 'pg_ctl.exe'),
  (Join-Path $root '_tools\pgsql'),
  (Join-Path $root '_tools\backups'),
  (Join-Path $root '_tools\uploads')
)

Write-Output 'Project root:'
Write-Output "  $root"
Write-Output ''

# ---------- 3) دمج مع الاستثناءات الموجودة (Set-MpPreference يستبدل — لا تمسح ما عند المستخدم) ----------
try {
  $existing = @((Get-MpPreference -ErrorAction Stop).ExclusionPath)
} catch {
  Write-Output ('FAILED to read Defender settings: ' + $_.Exception.Message)
  Read-Host 'Press Enter to close'
  exit 1
}

$merged = @($existing + $paths | Where-Object { $_ -and $_.Trim() -ne '' } | Sort-Object -Unique)

try {
  Set-MpPreference -ExclusionPath $merged -ErrorAction Stop
} catch {
  Write-Output ('FAILED to set exclusions: ' + $_.Exception.Message)
  Read-Host 'Press Enter to close'
  exit 1
}

# ---------- 4) تأكيد النتيجة ----------
Write-Output 'Defender exclusions now include:'
(Get-MpPreference).ExclusionPath | Where-Object { $_ -like ($root + '*') } | ForEach-Object { Write-Output "  [+] $_" }
Write-Output ''
Write-Output 'OK — exclusions applied. You can now use the Medad shortcut.'
Read-Host 'Press Enter to close'
exit 0
