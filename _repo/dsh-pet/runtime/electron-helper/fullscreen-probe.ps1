param([Parameter(Mandatory=$true)][int]$ParentProcessId)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class DshFullscreenProbe {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L,T,R,B; }
  [StructLayout(LayoutKind.Sequential)] public struct MONITORINFO { public int Size; public RECT Monitor,Work; public uint Flags; }
  public delegate bool EnumProc(IntPtr hwnd, IntPtr arg);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr arg);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
  [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr hwnd, uint flags);
  [DllImport("user32.dll")] static extern bool GetMonitorInfo(IntPtr monitor, ref MONITORINFO info);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd, StringBuilder text, int count);
  [DllImport("user32.dll", EntryPoint="GetWindowLongW")] static extern int GetWindowLong(IntPtr hwnd, int index);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr hwnd, int attr, out int value, int size);
  [DllImport("dwmapi.dll", EntryPoint="DwmGetWindowAttribute")] static extern int DwmRect(IntPtr hwnd, int attr, out RECT value, int size);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  static bool Covers(RECT r, RECT m) { return Math.Abs(r.L-m.L)<=8 && Math.Abs(r.T-m.T)<=8 && Math.Abs(r.R-m.R)<=8 && Math.Abs(r.B-m.B)<=8; }
  public static string Sample(int ignoredPid) {
    SetProcessDPIAware();
    var seen = new HashSet<IntPtr>(); var screens = new List<string>();
    EnumWindows(delegate(IntPtr hwnd, IntPtr arg) {
      uint pid; GetWindowThreadProcessId(hwnd,out pid);
      if(pid==(uint)ignoredPid || !IsWindowVisible(hwnd) || IsIconic(hwnd)) return true;
      int cloaked; if(DwmGetWindowAttribute(hwnd,14,out cloaked,4)==0 && cloaked!=0) return true;
      var name=new StringBuilder(256); GetClassName(hwnd,name,256); string cls=name.ToString();
      if(cls=="Progman" || cls=="WorkerW" || cls.Contains("TrayWnd") || cls=="Shell_SecondaryTrayWnd") return true;
      if((GetWindowLong(hwnd,-20) & 0x80)!=0) return true;
      RECT rect; if(DwmRect(hwnd,9,out rect,16)!=0 && !GetWindowRect(hwnd,out rect)) return true;
      if(rect.R-rect.L<160 || rect.B-rect.T<120) return true;
      IntPtr mon=MonitorFromWindow(hwnd,0); if(mon==IntPtr.Zero || seen.Contains(mon)) return true;
      var info=new MONITORINFO(); info.Size=Marshal.SizeOf(info); if(!GetMonitorInfo(mon,ref info)) return true;
      // EnumWindows is in Z order: only the first substantial non-tool window on each monitor is eligible.
      seen.Add(mon);
      if(Covers(rect,info.Monitor)) { RECT m=info.Monitor; screens.Add("{\"x\":"+m.L+",\"y\":"+m.T+",\"width\":"+(m.R-m.L)+",\"height\":"+(m.B-m.T)+"}"); }
      return true;
    },IntPtr.Zero);
    return "{\"screens\":["+String.Join(",",screens.ToArray())+"]}";
  }
}
'@
while ($true) {
  if (-not (Get-Process -Id $ParentProcessId -ErrorAction SilentlyContinue)) { break }
  [Console]::WriteLine([DshFullscreenProbe]::Sample($ParentProcessId))
  [Console]::Out.Flush()
  Start-Sleep -Milliseconds 300
}
