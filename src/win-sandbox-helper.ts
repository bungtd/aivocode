/**
 * PowerShell + inline C# helper for a real Windows AppContainer sandbox.
 *
 * The TS side writes this script to ~/.aivokey/win-sandbox.ps1 and invokes it for
 * `run_shell`. The helper creates (or reuses) a stable AppContainer profile per
 * workspace+mode, grants the workspace ACL once, maps a temporary drive to the
 * workspace (so the child has a usable cwd without traversing untrusted parent
 * directories), launches PowerShell with
 * PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES, and puts the child in a Job Object
 * with kill-on-close.
 *
 * Network is denied unless the internetClient capability is explicitly included.
 * The script is a raw template string: do not use JS `${...}` interpolation or
 * backticks inside it.
 */
export const WINDOWS_SANDBOX_HELPER_SCRIPT = String.raw`
param(
  [Parameter(Mandatory = $true)][string]$Command,
  [Parameter(Mandatory = $true)][string]$Workspace,
  [string]$Cwd = $Workspace,
  [ValidateSet("allow", "deny")][string]$Network = "deny",
  [string]$Shell = "powershell.exe",
  [switch]$ReadOnly,
  [switch]$Probe
)

$ErrorActionPreference = "Stop"

Add-Type -TypeDefinition @"
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

public static class AivoWinSandbox {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct STARTUPINFO {
    public int cb;
    public string lpReserved;
    public string lpDesktop;
    public string lpTitle;
    public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
    public short wShowWindow, cbReserved2;
    public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct STARTUPINFOEX {
    public STARTUPINFO StartupInfo;
    public IntPtr lpAttributeList;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct PROCESS_INFORMATION {
    public IntPtr hProcess, hThread;
    public int dwProcessId, dwThreadId;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct SID_AND_ATTRIBUTES {
    public IntPtr Sid;
    public uint Attributes;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct SECURITY_CAPABILITIES {
    public IntPtr AppContainerSid;
    public IntPtr Capabilities;
    public uint CapabilityCount;
    public uint Reserved;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
    public long PerProcessUserTimeLimit;
    public long PerJobUserTimeLimit;
    public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize;
    public UIntPtr MaximumWorkingSetSize;
    public uint ActiveProcessLimit;
    public UIntPtr Affinity;
    public uint PriorityClass;
    public uint SchedulingClass;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct IO_COUNTERS {
    public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount;
    public ulong ReadTransferCount, WriteTransferCount, OtherTransferCount;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
    public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
    public IO_COUNTERS IoInfo;
    public UIntPtr ProcessMemoryLimit;
    public UIntPtr JobMemoryLimit;
    public UIntPtr PeakProcessMemoryUsed;
    public UIntPtr PeakJobMemoryUsed;
  }

  [DllImport("userenv.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern int CreateAppContainerProfile(string name, string display, string desc, IntPtr caps, uint count, out IntPtr sid);
  [DllImport("userenv.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern int DeriveAppContainerSidFromAppContainerName(string name, out IntPtr sid);
  [DllImport("userenv.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern int DeleteAppContainerProfile(string name);
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool ConvertSidToStringSid(IntPtr sid, out IntPtr str);
  [DllImport("advapi32.dll", SetLastError = true)]
  static extern bool ConvertStringSidToSid(string str, out IntPtr sid);
  [DllImport("kernel32.dll")]
  static extern IntPtr LocalFree(IntPtr h);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attr, IntPtr value, IntPtr size, IntPtr prev, IntPtr ret);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern void DeleteProcThreadAttributeList(IntPtr list);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool CreateProcess(string app, StringBuilder cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref STARTUPINFOEX si, out PROCESS_INFORMATION pi);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool DuplicateHandle(IntPtr srcProc, IntPtr src, IntPtr dstProc, out IntPtr dst, uint access, bool inherit, uint options);
  [DllImport("kernel32.dll")]
  static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern IntPtr GetStdHandle(int n);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern uint WaitForSingleObject(IntPtr h, uint ms);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool GetExitCodeProcess(IntPtr h, out uint code);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern IntPtr CreateJobObject(IntPtr a, string name);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool SetInformationJobObject(IntPtr job, int cls, IntPtr info, uint len);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool AssignProcessToJobObject(IntPtr job, IntPtr proc);

  public static string GetSidString(string name) {
    IntPtr sid;
    int hr = CreateAppContainerProfile(name, "AivoCode Sandbox", "AivoCode shell sandbox", IntPtr.Zero, 0, out sid);
    if (hr != 0) {
      hr = DeriveAppContainerSidFromAppContainerName(name, out sid);
      if (hr != 0) throw new Exception("CreateAppContainerProfile failed: 0x" + hr.ToString("X8"));
    }
    IntPtr text;
    if (!ConvertSidToStringSid(sid, out text)) throw new Win32Exception(Marshal.GetLastWin32Error());
    try { return Marshal.PtrToStringUni(text); }
    finally { LocalFree(text); }
  }

  public static int Run(string profileName, string shell, string scriptPath, string cwd, bool allowNetwork) {
    IntPtr profileSid;
    IntPtr capInternet = IntPtr.Zero;
    IntPtr capPrivate = IntPtr.Zero;
    IntPtr capArray = IntPtr.Zero;
    IntPtr secPtr = IntPtr.Zero;
    IntPtr attrList = IntPtr.Zero;
    IntPtr job = IntPtr.Zero;
    IntPtr inDup = IntPtr.Zero;
    IntPtr outDup = IntPtr.Zero;
    IntPtr errDup = IntPtr.Zero;
    PROCESS_INFORMATION pi = new PROCESS_INFORMATION();

    try {
      int hr = CreateAppContainerProfile(profileName, "AivoCode Sandbox", "AivoCode shell sandbox", IntPtr.Zero, 0, out profileSid);
      if (hr != 0) {
        hr = DeriveAppContainerSidFromAppContainerName(profileName, out profileSid);
        if (hr != 0) throw new Exception("CreateAppContainerProfile failed: 0x" + hr.ToString("X8"));
      }

      SECURITY_CAPABILITIES sec = new SECURITY_CAPABILITIES();
      sec.AppContainerSid = profileSid;
      if (allowNetwork) {
        int count = 0;
        if (ConvertStringSidToSid("S-1-15-3-1", out capInternet)) count++;
        if (ConvertStringSidToSid("S-1-15-3-3", out capPrivate)) count++;
        if (count > 0) {
          capArray = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(SID_AND_ATTRIBUTES)) * count);
          int offset = 0;
          if (capInternet != IntPtr.Zero) {
            SID_AND_ATTRIBUTES a = new SID_AND_ATTRIBUTES();
            a.Sid = capInternet;
            a.Attributes = 0x00000004;
            Marshal.StructureToPtr(a, IntPtr.Add(capArray, offset), false);
            offset += Marshal.SizeOf(typeof(SID_AND_ATTRIBUTES));
          }
          if (capPrivate != IntPtr.Zero) {
            SID_AND_ATTRIBUTES b = new SID_AND_ATTRIBUTES();
            b.Sid = capPrivate;
            b.Attributes = 0x00000004;
            Marshal.StructureToPtr(b, IntPtr.Add(capArray, offset), false);
          }
          sec.Capabilities = capArray;
          sec.CapabilityCount = (uint)count;
        }
      }
      secPtr = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(SECURITY_CAPABILITIES)));
      Marshal.StructureToPtr(sec, secPtr, false);

      IntPtr size = IntPtr.Zero;
      InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
      attrList = Marshal.AllocHGlobal(size);
      if (!InitializeProcThreadAttributeList(attrList, 1, 0, ref size)) throw new Win32Exception(Marshal.GetLastWin32Error());
      if (!UpdateProcThreadAttribute(attrList, 0, (IntPtr)0x00020009, secPtr, (IntPtr)Marshal.SizeOf(typeof(SECURITY_CAPABILITIES)), IntPtr.Zero, IntPtr.Zero)) {
        throw new Win32Exception(Marshal.GetLastWin32Error());
      }

      DuplicateHandle(GetCurrentProcess(), GetStdHandle(-10), GetCurrentProcess(), out inDup, 0, true, 2);
      DuplicateHandle(GetCurrentProcess(), GetStdHandle(-11), GetCurrentProcess(), out outDup, 0, true, 2);
      DuplicateHandle(GetCurrentProcess(), GetStdHandle(-12), GetCurrentProcess(), out errDup, 0, true, 2);

      STARTUPINFOEX si = new STARTUPINFOEX();
      si.StartupInfo.cb = Marshal.SizeOf(typeof(STARTUPINFOEX));
      si.StartupInfo.dwFlags = 0x00000100;
      si.StartupInfo.hStdInput = inDup;
      si.StartupInfo.hStdOutput = outDup;
      si.StartupInfo.hStdError = errDup;
      si.lpAttributeList = attrList;

      char q = (char)34;
      string cmdline = shell + " -NoLogo -NoProfile -NonInteractive -File " + q + scriptPath + q;

      if (!CreateProcess(null, new StringBuilder(cmdline), IntPtr.Zero, IntPtr.Zero, true, 0x00080000, IntPtr.Zero, cwd, ref si, out pi)) {
        throw new Win32Exception(Marshal.GetLastWin32Error());
      }

      job = CreateJobObject(IntPtr.Zero, null);
      if (job != IntPtr.Zero) {
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        info.BasicLimitInformation.LimitFlags = 0x00002000;
        IntPtr infoPtr = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION)));
        try {
          Marshal.StructureToPtr(info, infoPtr, false);
          SetInformationJobObject(job, 9, infoPtr, (uint)Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION)));
        } finally { Marshal.FreeHGlobal(infoPtr); }
        AssignProcessToJobObject(job, pi.hProcess);
      }

      WaitForSingleObject(pi.hProcess, 0xFFFFFFFF);
      uint code;
      GetExitCodeProcess(pi.hProcess, out code);
      return unchecked((int)code);
    } finally {
      if (pi.hProcess != IntPtr.Zero) CloseHandle(pi.hProcess);
      if (pi.hThread != IntPtr.Zero) CloseHandle(pi.hThread);
      if (inDup != IntPtr.Zero) CloseHandle(inDup);
      if (outDup != IntPtr.Zero) CloseHandle(outDup);
      if (errDup != IntPtr.Zero) CloseHandle(errDup);
      if (job != IntPtr.Zero) CloseHandle(job);
      if (attrList != IntPtr.Zero) { DeleteProcThreadAttributeList(attrList); Marshal.FreeHGlobal(attrList); }
      if (secPtr != IntPtr.Zero) Marshal.FreeHGlobal(secPtr);
      if (capArray != IntPtr.Zero) Marshal.FreeHGlobal(capArray);
      if (capInternet != IntPtr.Zero) LocalFree(capInternet);
      if (capPrivate != IntPtr.Zero) LocalFree(capPrivate);
    }
  }
}
"@

$realUserProfile = $env:USERPROFILE
$workspacePath = (Resolve-Path -LiteralPath $Workspace).Path
$cwdPath = (Resolve-Path -LiteralPath $Cwd).Path
$workspaceRoot = $workspacePath.TrimEnd([char]92)
$workspacePrefix = $workspaceRoot + [char]92
$cwdInsideWorkspace = $cwdPath.Equals($workspaceRoot, [StringComparison]::OrdinalIgnoreCase) -or
  $cwdPath.StartsWith($workspacePrefix, [StringComparison]::OrdinalIgnoreCase)

$modeKey = if ($ReadOnly.IsPresent) { "ro" } else { "rw" }
$profileName = if ($Probe) {
  "aivo-sbx-probe-" + [guid]::NewGuid().ToString("N").Substring(0, 12)
} else {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($workspaceRoot.ToLowerInvariant() + "|" + $modeKey)
    $hash = $sha.ComputeHash($bytes)
    "aivo-sbx-" + (($hash[0..7] | ForEach-Object { $_.ToString("x2") }) -join "")
  } finally {
    $sha.Dispose()
  }
}
$sid = $null
$mappedDrive = $null
$nodeCacheDir = $null
$nodeDrive = $null
$scriptPath = $null
$originalTemp = $env:TEMP
$originalTmp = $env:TMP
$originalHome = $env:HOME
$originalUserProfile = $env:USERPROFILE
$originalLocalAppData = $env:LOCALAPPDATA
$originalAppData = $env:APPDATA

$aclMutex = New-Object System.Threading.Mutex -ArgumentList $false, "Local\AivoCodeSandboxAcl"
function Lock-Acl {
  try { $null = $aclMutex.WaitOne(60000) } catch [System.Threading.AbandonedMutexException] {}
}
function Unlock-Acl {
  try { $aclMutex.ReleaseMutex() } catch {}
}
function Test-AclGranted([string]$path, [string]$sidValue) {
  try {
    $acl = Get-Acl -LiteralPath $path -ErrorAction Stop
    foreach ($ace in $acl.Access) {
      if ($ace.IdentityReference.Value -eq $sidValue) { return $true }
    }
  } catch {}
  return $false
}
function Test-AclCanWrite([string]$path, [string]$sidValue) {
  $write = [System.Security.AccessControl.FileSystemRights]::Write
  try {
    $acl = Get-Acl -LiteralPath $path -ErrorAction Stop
    foreach ($ace in $acl.Access) {
      if ($ace.AccessControlType -ne "Allow") { continue }
      if ($ace.IdentityReference.Value -ne $sidValue) { continue }
      if (($ace.FileSystemRights -band $write) -eq $write) { return $true }
    }
  } catch {}
  return $false
}
function Grant-Acl([string]$path, [string]$permissions) {
  if (-not (Test-Path -LiteralPath $path -PathType Container)) { return }
  if (Test-AclGranted $path $sid) { return }
  $previous = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    & icacls.exe $path /grant ("*" + $sid + ":" + $permissions) 2>$null | Out-Null
  } finally {
    $ErrorActionPreference = $previous
  }
}

try {
  $sid = [AivoWinSandbox]::GetSidString($profileName)

  # Concurrent helpers edit the same DACL. Serialize the read-modify-write so one
  # command cannot drop another command's AppContainer ACE.
  Lock-Acl
  try {
    $workspaceGrant = if ($ReadOnly.IsPresent) { "(OI)(CI)RX" } else { "(OI)(CI)M" }
    $workspaceOk = if ($ReadOnly.IsPresent) {
      Test-AclGranted $workspacePath $sid
    } else {
      Test-AclCanWrite $workspacePath $sid
    }
    if (-not $workspaceOk) {
      & icacls.exe $workspacePath /grant ("*" + $sid + ":" + $workspaceGrant) 2>$null | Out-Null
      if ($LASTEXITCODE -ne 0) { throw "Failed to grant workspace ACL to AppContainer" }
    }
    if (-not $cwdInsideWorkspace -and $cwdPath -ne $workspacePath) {
      if (-not (Test-AclCanWrite $cwdPath $sid)) {
        & icacls.exe $cwdPath /grant ("*" + $sid + ":(OI)(CI)M") 2>$null | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "Failed to grant cwd ACL to AppContainer" }
      }
    }

    $tempPath = Join-Path $workspacePath ".aivokey-tmp"
    New-Item -ItemType Directory -Force -Path $tempPath | Out-Null
    if (-not (Test-AclCanWrite $tempPath $sid)) {
      & icacls.exe $tempPath /grant ("*" + $sid + ":(OI)(CI)M") 2>$null | Out-Null
      if ($LASTEXITCODE -ne 0) { throw "Failed to grant temp ACL to AppContainer" }
    }

    # Node installed under Program Files often lacks an ALL APPLICATION PACKAGES
    # ACE on node.exe (unlike Git), so AppContainer cannot execute it. Mirror the
    # installation into a user-owned cache, grant RX once, and prefer it on PATH.
    # Other tools keep the original ACLs; git and most Windows tools already
    # include ALL APPLICATION PACKAGES and run without an extra grant.
    if (-not $Probe) {
      $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue | Select-Object -First 1
      if ($nodeCommand -and $nodeCommand.Source) {
        $sourceNodeDir = Split-Path -Parent $nodeCommand.Source
        $cacheParent = Join-Path $realUserProfile ".aivokey\sandbox-tools"
        $nodeCacheDir = Join-Path $cacheParent "nodejs"
        $cacheNode = Join-Path $nodeCacheDir "node.exe"
        $marker = Join-Path $nodeCacheDir ".aivo-source"
        $needsCopy = $true
        if ((Test-Path -LiteralPath $cacheNode) -and (Test-Path -LiteralPath $marker)) {
          $markerSource = (Get-Content -LiteralPath $marker -Raw -ErrorAction SilentlyContinue).Trim()
          if ($markerSource -eq $sourceNodeDir) {
            $srcTime = (Get-Item -LiteralPath (Join-Path $sourceNodeDir "node.exe")).LastWriteTimeUtc
            $dstTime = (Get-Item -LiteralPath $cacheNode).LastWriteTimeUtc
            if ($dstTime -ge $srcTime) { $needsCopy = $false }
          }
        }
        if ($needsCopy) {
          try {
            New-Item -ItemType Directory -Force -Path $cacheParent | Out-Null
            if (Test-Path -LiteralPath $nodeCacheDir) {
              Remove-Item -LiteralPath $nodeCacheDir -Recurse -Force -ErrorAction SilentlyContinue
            }
            Copy-Item -LiteralPath $sourceNodeDir -Destination $nodeCacheDir -Recurse -Force
            Set-Content -LiteralPath $marker -Value $sourceNodeDir -Encoding UTF8
          } catch {
            # Fall back to the original PATH entry; the command may still work if
            # this installation has AppContainer-compatible ACLs.
          }
        }
        if (Test-Path -LiteralPath $cacheNode) {
          Grant-Acl $nodeCacheDir "(OI)(CI)RX"
        } else {
          $nodeCacheDir = $null
        }
      }
    }
  } finally {
    Unlock-Acl
  }

  # Map a temporary drive so the child has an accessible cwd. PowerShell cannot
  # Set-Location through C:\Users\... when the AppContainer lacks traverse on the
  # ancestors, and granting traverse on those ancestors recursively is very slow.
  $mapRoot = if ($cwdInsideWorkspace) { $workspacePath } else { $cwdPath }
  $relativeCwd = ""
  if ($cwdInsideWorkspace -and $cwdPath.Length -gt $workspaceRoot.Length) {
    $relativeCwd = $cwdPath.Substring($workspaceRoot.Length).TrimStart([char]92)
  }
  foreach ($letter in @("Z","Y","X","W","V","U","T","S","R","Q","P","O","N","M","L","K","J","I","H","G","F","E","D")) {
    $drive = $letter + ":"
    if (Test-Path -LiteralPath ($drive + [char]92)) { continue }
    & subst.exe $drive $mapRoot 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) { $mappedDrive = $drive; break }
  }
  if (-not $mappedDrive) { throw "No free drive letter available for the AppContainer working directory" }
  $childCwd = if ($relativeCwd) { $mappedDrive + [char]92 + $relativeCwd } else { $mappedDrive + [char]92 }

  # Rewrite absolute workspace paths to the temporary drive. Node/tools inside the
  # AppContainer cannot realpath C:\... (root traverse is denied), and MCP server
  # args frequently contain absolute workspace script/config paths.
  $workspacePattern = [regex]::Escape($workspacePath).Replace('\\', '[\\/]') + '(?![A-Za-z0-9._-])'
  $Command = [regex]::Replace($Command, $workspacePattern, $mappedDrive, "IgnoreCase")

  # Node's module loader resolves main-script paths through GetFinalPathName, and
  # AppContainer cannot traverse C:\Users\... read-only. Expose the cached Node
  # installation through its own drive so npm/node child scripts use Y:\ paths.
  if ($nodeCacheDir) {
    foreach ($letter in @("Y","X","W","V","U","T","S","R","Q","P","O","N","M","L","K","J","I","H","G","F","E","D")) {
      $drive = $letter + ":"
      if ($drive -eq $mappedDrive) { continue }
      if (Test-Path -LiteralPath ($drive + [char]92)) { continue }
      & subst.exe $drive $nodeCacheDir 2>$null | Out-Null
      if ($LASTEXITCODE -eq 0) { $nodeDrive = $drive; break }
    }
    if ($nodeDrive) { $env:PATH = $nodeDrive + [char]92 + ";" + $env:PATH }
  }

  $scriptPath = Join-Path $tempPath ("aivo-cmd-" + [guid]::NewGuid().ToString("N") + ".ps1")
  Set-Content -LiteralPath $scriptPath -Value $Command -Encoding UTF8

  $sandboxHome = $tempPath
  New-Item -ItemType Directory -Force -Path (Join-Path $sandboxHome "AppData\Local") | Out-Null
  New-Item -ItemType Directory -Force -Path (Join-Path $sandboxHome "AppData\Roaming") | Out-Null
  $env:TEMP = $tempPath
  $env:TMP = $tempPath
  $env:HOME = $sandboxHome
  $env:USERPROFILE = $sandboxHome
  $env:LOCALAPPDATA = Join-Path $sandboxHome "AppData\Local"
  $env:APPDATA = Join-Path $sandboxHome "AppData\Roaming"

  $code = [AivoWinSandbox]::Run(
    $profileName,
    $Shell,
    $scriptPath,
    $childCwd,
    ($Network -eq "allow")
  )
  exit $code
} catch {
  Write-Error $_
  exit 1
} finally {
  $env:TEMP = $originalTemp
  $env:TMP = $originalTmp
  $env:HOME = $originalHome
  $env:USERPROFILE = $originalUserProfile
  $env:LOCALAPPDATA = $originalLocalAppData
  $env:APPDATA = $originalAppData
  if ($scriptPath) { Remove-Item -LiteralPath $scriptPath -Force -ErrorAction SilentlyContinue }
  if ($nodeDrive) { try { & subst.exe $nodeDrive /D 2>$null | Out-Null } catch {} }
  if ($mappedDrive) { try { & subst.exe $mappedDrive /D 2>$null | Out-Null } catch {} }
  # Normal runs keep the stable profile and its cached ACLs. The one-off probe
  # removes them so doctor/detection does not leave persistent state.
  if ($Probe -and $sid) {
    Lock-Acl
    try {
      try { & icacls.exe $workspacePath /remove:g ("*" + $sid) 2>$null | Out-Null } catch {}
      if (-not $cwdInsideWorkspace -and $cwdPath -and $cwdPath -ne $workspacePath) {
        try { & icacls.exe $cwdPath /remove:g ("*" + $sid) 2>$null | Out-Null } catch {}
      }
      if ($tempPath) {
        try { & icacls.exe $tempPath /remove:g ("*" + $sid) 2>$null | Out-Null } catch {}
      }
    } finally {
      Unlock-Acl
    }
    try { [AivoWinSandbox]::DeleteProfile($profileName) } catch {}
  }
}
`;
