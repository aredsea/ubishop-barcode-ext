' ============================================================================
'  autoprint-setup.vbs  -  UbiShop silent-print one-time setup
'  Double-click this file once. After that, just open Chrome as usual and
'  printing goes straight to the default printer with NO print dialog.
'
'  It does 3 things:
'   1) Startup shortcut  -> at Windows login, UbiShop opens in kiosk-printing Chrome
'   2) Adds --kiosk-printing to existing Chrome shortcuts (desktop / taskbar)
'   3) Turns Chrome background mode OFF (so closing fully exits Chrome)
'
'  No admin rights needed. Uses your normal Chrome profile (extension + login kept).
' ============================================================================
Option Explicit
Dim sh, fso, chrome, url, flag, i, paths, modified
Set sh  = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

url  = "http://ubdstore.ubshop.biz/info/item/infoItemList.do"
flag = "--kiosk-printing"

' --- find chrome.exe ---
chrome = ""
paths = Array( _
  sh.ExpandEnvironmentStrings("%ProgramFiles%")      & "\Google\Chrome\Application\chrome.exe", _
  sh.ExpandEnvironmentStrings("%ProgramFiles(x86)%") & "\Google\Chrome\Application\chrome.exe", _
  sh.ExpandEnvironmentStrings("%LocalAppData%")      & "\Google\Chrome\Application\chrome.exe")
For i = 0 To UBound(paths)
  If fso.FileExists(paths(i)) Then chrome = paths(i) : Exit For
Next
If chrome = "" Then
  MsgBox "Chrome not found. Please install/locate Chrome and retry.", 16, "UbiShop Auto-Print"
  WScript.Quit
End If

' --- 1) Startup shortcut ---
Dim startup, lnk
startup = sh.SpecialFolders("Startup")
Set lnk = sh.CreateShortcut(startup & "\UbiShop-Print.lnk")
lnk.TargetPath   = chrome
lnk.Arguments    = flag & " """ & url & """"
lnk.IconLocation = chrome & ",0"
lnk.Description   = "UbiShop barcode print (no dialog)"
lnk.Save

' --- 2) Append flag to existing Chrome shortcuts ---
modified = 0
Dim dirs, d
dirs = Array( _
  sh.SpecialFolders("Desktop"), _
  "C:\Users\Public\Desktop", _
  sh.SpecialFolders("Programs"), _
  sh.ExpandEnvironmentStrings("%AppData%") & "\Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar")
For Each d In dirs
  If fso.FolderExists(d) Then modified = modified + PatchFolder(d)
Next

' --- 3) Chrome background mode OFF (HKCU policy, no admin needed) ---
On Error Resume Next
sh.RegWrite "HKCU\Software\Policies\Google\Chrome\BackgroundModeEnabled", 0, "REG_DWORD"
On Error GoTo 0

MsgBox "Setup complete." & vbCrLf & vbCrLf & _
  "Chrome shortcuts updated: " & modified & vbCrLf & _
  "A startup item was added (UbiShop opens at login)." & vbCrLf & vbCrLf & _
  "NOW: close ALL Chrome windows and open Chrome again." & vbCrLf & _
  "Then 'barcode print' prints with no dialog." & vbCrLf & vbCrLf & _
  "** Set the default printer to the Zebra label printer. **", _
  64, "UbiShop Auto-Print"

' patch every chrome*.lnk in a folder (top level), return count modified
Function PatchFolder(folderPath)
  Dim n, f, s
  n = 0
  On Error Resume Next
  For Each f In fso.GetFolder(folderPath).Files
    If LCase(fso.GetExtensionName(f.Name)) = "lnk" Then
      Set s = sh.CreateShortcut(f.Path)
      If InStr(LCase(s.TargetPath), "chrome.exe") > 0 Then
        If InStr(LCase(s.Arguments), "kiosk-printing") = 0 Then
          s.Arguments = Trim(s.Arguments & " " & flag)
          s.Save
          n = n + 1
        End If
      End If
    End If
  Next
  On Error GoTo 0
  PatchFolder = n
End Function
